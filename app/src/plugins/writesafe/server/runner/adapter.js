'use strict';

/**
 * The one place stream G (approvals, the runner, the admin page) touches the bulk job engine of stream E
 * (modules/_bulk: jobs.js, store.js, plan.js). Everything in server/approval and server/runner calls only these.
 * Design notes: docs/internals.md, section "server/runner/adapter.js".
 */
const E = require('../engine');
const M = require('../model');

const J = () => require('../modules/_bulk/jobs');
const S = () => require('../modules/_bulk/store');
const U = () => require('../modules/_bulk/util');

const TERMINAL = ['done', 'cancelled', 'rejected', 'expired'];
const PAUSE_CODES = { admin_job: 'job_paused', permission_changed: 'job_paused', runner_errors: 'job_paused' };

/** The approval code's view of an E job row. */
function toG(row) {
  if (!row) return null;
  return {
    job_id: row.jobId, status: row.state, tool: row.tool, uid: row.contentType, locale: row.targetLocale || null,
    owner: row.owner, action: row.action, spec: row.spec || {}, qfilters: row.qfilters || {}, mode: row.mode,
    next: Number(row.cursor || 0), total: Number(row.total || 0), idHash: row.idHash || null, chunks: Number(row.chunks || 0),
    totals: {
      ok: row.nOk || 0, unchanged: row.nUnchanged || 0, skipped: row.nSkipped || 0, failed: row.nFailed || 0, conflict: row.nConflict || 0,
      ...(row.spec && row.spec.publish ? { published: Number(row.nPublished || 0), publish_skipped: Number(row.nPublishSkipped || 0) } : {}),
    },
    approval: row.approval || null, runner: Boolean(row.runner), paused: row.paused || null,
    pause_reason: row.paused ? row.paused.reason || null : null, pause_detail: row.paused ? row.paused.detail || null : null,
    stopped: row.stopped || null, agent: row.agent || null,
    created_at: row.createdAt ? new Date(row.createdAt).toISOString() : null, updated_at: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}
const G = (job) => (job && job.job_id !== undefined && job.jobId === undefined ? job : toG(job));
/** A stream F undo job (E row or G view). */
const isUndo = (job) => Boolean(job) && (job.tool === 'ws_undo');

/** The plan's id-list hash (E's plan token commits to it): the manifest root shown to approvers. */
const manifestRoot = (job) => G(job).idHash;

/**
 * The hash an approval is bound to. The job id is derived from the plan token's MAC (E's plan.jobIdOf), which covers
 * owner, uid, locale, filter, action, spec hash, count, idHash, undoable, expiry and nonce; this adds the stored job's
 * own fields, so a job row changed after the request no longer matches.
 */
function planHash(job) {
  const g = G(job);
  const j = JSON.parse(JSON.stringify({ spec: g.spec || {}, qfilters: g.qfilters || {} }));
  return M.sha(M.canonical({
    v: 2, jobId: g.job_id, owner: g.owner, tool: g.tool, uid: g.uid, locale: g.locale || null, action: g.action,
    spec: j.spec, qfilters: j.qfilters, mode: g.mode, count: g.total, idHash: g.idHash,
  }));
}

const getJob = async (strapi, jobId) => toG(await S().findJob(strapi, jobId));

/**
 * Changes a job's state under its row lock, only from the given states. Pauses record { reason, code, detail };
 * a terminal state frees the slot; resuming a stopped job puts its failing document back (as E's own resume does).
 * patch: { approval, runner } (the G fields stored on the row). Returns the G job, or null if not changed.
 */
async function setJobStatus(strapi, jobId, to, { from, reason, detail, patch } = {}) {
  return strapi.db.transaction(async () => {
    const j = await S().lockJob(strapi, jobId);
    if (!j || (from && !from.includes(j.state))) return null;
    const fields = new Set(['state', 'slot', 'paused', 'stopped', 'nFailed']);
    if (to === 'running' && j.state === 'stopped') {
      const back = J().unstopRecord(j);
      if (back) await S().resetItem(strapi, j.jobId, back.docId);
    }
    j.state = to;
    if (to === 'paused') j.paused = { reason: reason || 'admin_job', code: PAUSE_CODES[reason] || 'job_paused', ...(detail ? { detail } : {}), at: new Date().toISOString() };
    else j.paused = null;
    if (to === 'running') j.stopped = null;
    if (TERMINAL.includes(to)) j.slot = null;
    for (const k of ['approval', 'runner']) if (patch && patch[k] !== undefined) { j[k] = patch[k]; fields.add(k); }
    await S().saveJob(strapi, j, [...fields]);
    return toG(j);
  });
}

/**
 * Runs the job's next chunk with the token's ability (ctx); guard() runs inside the chunk's transaction. A finished
 * job gets E's end report (reconcile) as runJob does. Returns { job (G), items, idle, from }.
 */
async function runOneChunk(strapi, { jobId, owner, ctx, token, guard }) {
  const row = await S().findJob(strapi, jobId);
  // the job row is gone (pruned, deleted by hand): the runner ends the lease as failed/job_missing
  if (!row) return { job: { status: 'missing' }, items: [], idle: true, from: null };
  let from = null;
  const extra = { requestInfo: { headers: {} }, writesafeRunner: { token: token || null } };
  const r = await E.withCaller(ctx, () => J().runChunk(strapi, ctx, extra, jobId, owner || row.owner, async (j) => {
    from = Number(j.cursor || 0);
    if (guard) await guard(j);
  }));
  const job = r.job;
  if (job && job.state === 'done' && !job.reconcile) {
    try {
      job.reconcile = await J().reconcile(strapi, job);
      await S().saveJob(strapi, job, ['reconcile']);
    } catch { /* the report is a nicety; the job is done */ }
  }
  return { job: toG(job), items: r.items || [], idle: Boolean(r.idle), from };
}

/** Recent jobs (newest first) for the admin page. */
async function listJobs(strapi, { limit = 50 } = {}) {
  const rows = await strapi.db.query(S().JOB_UID).findMany({ orderBy: { id: 'desc' }, limit });
  return rows.map((r) => summary(toG(S().rowToJob(r))));
}

/** A job for the admin page: no owner scope. */
function summary(job) {
  const g = G(job);
  return {
    job_id: g.job_id, tool: g.tool, kind: isUndo(g) ? 'undo' : 'bulk', uid: g.uid, locale: g.locale, action: g.action, status: g.status,
    total: g.total, processed: g.next, next: g.next, totals: g.totals, chunks: g.chunks, mode: g.mode,
    agent: g.agent, created_at: g.created_at, updated_at: g.updated_at,
    pause_reason: g.pause_reason, pause_detail: g.pause_detail, approval: g.approval, runner: g.runner, stopped: g.stopped,
    ...(isUndo(g) ? { undo_of: (g.spec && g.spec.receipt_id) || null } : {}),
  };
}

/** An evenly spread sample of a job's snapshot rows (first, ..., last). */
async function sampleRows(strapi, job, n) {
  const g = G(job);
  const positions = J().previewPositions(g.total, n);
  if (!positions.length) return [];
  return strapi.db.query(S().ITEM_UID).findMany({ where: { jobId: g.job_id, ordinal: { $in: positions } }, select: ['ordinal', 'docId', 'planVersion'], orderBy: { ordinal: 'asc' } });
}

/** Dry-run previews of some snapshot rows (written, then rolled back), as the token sees them. */
async function previewDocs(strapi, ctx, extra, job, rows) {
  const g = G(job);
  const jv = J().jobView({ jobId: g.job_id, tool: g.tool, contentType: g.uid, targetLocale: g.locale, action: g.action, spec: g.spec, qfilters: g.qfilters, mode: g.mode });
  return J().previewRows(strapi, ctx, extra, g.tool, jv, rows.map((r) => ({ docId: r.docId, planVersion: r.planVersion })));
}

/**
 * The per-chunk time cap of the bulk engine: stream B's bulk.chunkTimeMs (1,000 ms by default; 0 turns the cap off,
 * then null). The runner keeps leaseMs at least 3 x above it. The setting must exist: an engine without it is not the
 * one the runner was built against, so this throws rather than guess (a unit test asserts it is there).
 */
function chunkTimeMs(strapi) {
  const bulk = U().settings(strapi).bulk;
  if (!bulk || !Object.prototype.hasOwnProperty.call(bulk, 'chunkTimeMs')) {
    throw new Error('[writesafe] bulk.chunkTimeMs is missing from the bulk engine settings: the runner needs the per-chunk time cap of stream B');
  }
  const v = Number(bulk.chunkTimeMs);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** E's config kill switch (bulk.paused): either it or the admin's switch stops every job. */
const configPaused = (strapi) => {
  if (!strapi || !strapi.config || typeof strapi.config.get !== 'function') return false;
  try { return Boolean(U().settings(strapi).bulk.paused); } catch { return true; }
};

module.exports = { toG, asG: G, isUndo, chunkTimeMs, configPaused, manifestRoot, planHash, getJob, setJobStatus, runOneChunk, listJobs, summary, sampleRows, previewDocs, TERMINAL };
