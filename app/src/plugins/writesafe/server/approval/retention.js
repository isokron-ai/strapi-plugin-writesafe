'use strict';

/**
 * Retention of bulk jobs that belong to an approval or the runner, and of the approval records themselves (review
 * finding 3). On the same clock as the jobs (retention.jobHours):
 *  - a job waiting for approval, paused, or run by the runner is never pruned on its own: it goes together with its
 *    request (and decisions) and its lease, and only once those are finished (request decided, expired or used; lease
 *    not queued or running) or, for a paused job, once it has been idle that long;
 *  - requests (with their spec and samples) and decisions, and leases, are pruned once finished and older than
 *    jobHours, also when their job is already gone.
 * server/retention.js calls this for every idle job and once per pass.
 */
const STORE = require('./store');

const TERMINAL = ['rejected', 'expired', 'consumed', 'cancelled'];
const ACTIVE_LEASE = ['queued', 'running'];

/** Is the request over (decided, used, cancelled, or past its expiry)? A missing request counts as over. */
function requestDone(r, now) {
  if (!r) return true;
  if (TERMINAL.includes(r.status)) return true;
  if (r.status === 'pending') return Number(r.expiresAt) < now;
  if (r.status === 'approved') return Number(r.approvalExpiresAt) < now;
  return false;
}

/**
 * Jobs kept on the long horizon (retention.longHorizonDays, 30 by default; re-review A3): a paused job waits for an
 * admin, and an approved job already under way (cursor past 0, not finished) waits for its agent; neither should
 * vanish after jobHours. They go when idle that long, or when an admin cancels them.
 */
const longKept = (job) => job.tool !== 'ws_undo' && (job.status === 'paused'
  || (Boolean(job.approval) && Number(job.next || 0) > 0 && ['running', 'stopped'].includes(job.status)));

/**
 * What to do with a job that has been idle for jobHours: 'keep', 'prune' (job only) or 'prune_linked'.
 * opts: { updatedAtMs, longCutoffMs } (without them the job counts as idle past every horizon).
 */
function jobAction(job, request, lease, now, opts = {}) {
  // a stream F undo job: no approval, no lease; pruned when idle, as without stream G
  if (job.tool === 'ws_undo') return 'prune';
  const linked = Boolean((job.approval && job.approval.request_id) || lease);
  if (job.status === 'awaiting_approval') return requestDone(request, now) ? 'prune_linked' : 'keep';
  if (job.status === 'running' && job.runner && lease && ACTIVE_LEASE.includes(lease.state)) return 'keep';
  if (longKept(job)) {
    const idleSince = Number(opts.updatedAtMs || 0);
    const longCut = opts.longCutoffMs === undefined ? now : opts.longCutoffMs;
    return idleSince < longCut ? 'prune_linked' : 'keep';
  }
  if (job.status === 'running' && job.runner) return 'prune_linked';
  return linked ? 'prune_linked' : 'prune';
}

/** When an idle job (last update at updatedAtMs) is pruned, in ms; for the jobs page. */
function pruneOn(job, updatedAtMs, { jobHours, longHorizonDays }) {
  if (!jobHours) return null;
  const h = longKept(job) ? (longHorizonDays || 0) * 24 : jobHours;
  return h ? Number(updatedAtMs) + h * 3600000 : null;
}

const leasePrunable = (lease, cutoffMs) => Boolean(lease && !ACTIVE_LEASE.includes(lease.state) && Number(lease.updatedAtMs || 0) < cutoffMs);
const requestPrunable = (r, now, cutoffMs) => Boolean(r && requestDone(r, now) && Number(r.requestedAt) < cutoffMs);

async function linkedOf(strapi, job) {
  const rid = job.approval && job.approval.request_id;
  const request = rid ? await STORE.approvals(strapi).getRequest(rid) : null;
  const lease = await STORE.leases(strapi).get(job.job_id);
  return { request, lease };
}

async function deleteRequest(strapi, requestId) {
  await strapi.db.query(STORE.DEC).deleteMany({ where: { requestId } });
  await strapi.db.query(STORE.REQ).deleteMany({ where: { requestId } });
}

async function deleteLinked(strapi, job, { request, lease }) {
  if (request) await deleteRequest(strapi, request.requestId);
  if (lease) await strapi.db.query(STORE.LEASE).deleteMany({ where: { jobId: lease.jobId } });
}

/**
 * Finished requests and leases older than the cutoff whose job is gone (or never existed), paged by id (re-review
 * A7): a first page full of rows that must stay (a live job's request) cannot stop the rest from being pruned.
 * Returns counts. At most PAGES pages of PAGE rows per table per pass; the next pass goes on.
 */
const PAGE = 500;
const PAGES = 20;
// kept between passes (third review B6): a pass that stops after PAGES pages goes on from there next time; the end
// of the table starts the next pass from the beginning
const CURSOR = { requests: 0, leases: 0 };
const resetCursors = () => { CURSOR.requests = 0; CURSOR.leases = 0; };
async function pruneRecords(strapi, cutoffMs, jobExists) {
  const now = Date.now();
  const out = { requests: 0, leases: 0 };
  for (let p = 0; p < PAGES; p += 1) {
    const reqs = (await strapi.db.query(STORE.REQ).findMany({ where: { requestedAt: { $lt: cutoffMs }, id: { $gt: CURSOR.requests } }, orderBy: { id: 'asc' }, limit: PAGE })).map(STORE.norm);
    if (!reqs.length) { CURSOR.requests = 0; break; }
    CURSOR.requests = reqs[reqs.length - 1].id;
    for (const r of reqs) {
      if (!requestPrunable(r, now, cutoffMs) || (await jobExists(r.planId))) continue;
      await deleteRequest(strapi, r.requestId);
      out.requests += 1;
    }
    if (reqs.length < PAGE) { CURSOR.requests = 0; break; }
  }
  for (let p = 0; p < PAGES; p += 1) {
    const leases = (await strapi.db.query(STORE.LEASE).findMany({ where: { updatedAtMs: { $lt: cutoffMs }, id: { $gt: CURSOR.leases } }, orderBy: { id: 'asc' }, limit: PAGE })).map(STORE.norm);
    if (!leases.length) { CURSOR.leases = 0; break; }
    CURSOR.leases = leases[leases.length - 1].id;
    for (const l of leases) {
      if (!leasePrunable(l, cutoffMs) || (await jobExists(l.jobId))) continue;
      await strapi.db.query(STORE.LEASE).deleteMany({ where: { jobId: l.jobId } });
      out.leases += 1;
    }
    if (leases.length < PAGE) { CURSOR.leases = 0; break; }
  }
  return out;
}

module.exports = { resetCursors, requestDone, jobAction, pruneOn, longKept, leasePrunable, requestPrunable, linkedOf, deleteLinked, pruneRecords, TERMINAL };
