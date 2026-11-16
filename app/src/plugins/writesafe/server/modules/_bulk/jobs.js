'use strict';

/**
 * ws_bulk: one patch or publish over every document that matches a filter, as a resumable job. ws_replace runs on the
 * same engine (registerAction).
 * Design notes: docs/internals.md, section "server/modules/_bulk/jobs.js".
 */
const { z } = require('@strapi/utils');
const E = require('../../engine');
const M = require('../../model');
const U = require('./util');
const P = require('./plan');
const S = require('./store');
const D = require('./deps');
const FL = require('../_lib/filters');
const RO = require('../../refops');
const F = require('../../force');

const { WsError } = E;

class ItemFail extends WsError {
  constructor(info) { super({ code: 'item_failed', message: info.error?.message || 'item failed' }); this.info = info; }
}

const DRIVER_TEXT_MAX = 500;
const compactError = (p) => {
  const out = { code: p.code, message: p.message };
  // No current_version: a compact item error carries no `current`, and a version never travels without its state.
  for (const k of ['field', 'key', 'details', 'documentId', 'driver_error']) if (p[k] !== undefined) out[k] = p[k];
  // review of PR #16 (M3): an item error is stored per document and listed in replies; the driver's own text (up to
  // 2,000 characters from mapStrapiError) is kept to 500 here and to 200 in reply lists
  if (typeof out.driver_error === 'string' && out.driver_error.length > DRIVER_TEXT_MAX) out.driver_error = out.driver_error.slice(0, DRIVER_TEXT_MAX);
  return out;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEmptyFilter = (f) => !f || typeof f !== 'object' || !Object.keys(f).length;
const historyOn = () => E.MOD.enabled().includes('history');
const history = () => require('../history');

// ---------------------------------------------------------------- hooks (Phase 4 stream G: approvals and the runner)

/**
 * Set by server/approval/gate.js (null hooks = the plain engine):
 *   gate:       { ceiling(bulkCfg) -> n, dryRunNote(strapi, desc, count, ctx) -> extra reply fields,
 *                 beforeCreate(strapi, ctx, extra, job, count) -> null | { awaiting } (throws to refuse),
 *                 afterCreate(strapi, ctx, extra, job, gated) -> reply, onResume(strapi, ctx, extra, job, a) -> null |
 *                 { reply } | { reload }, onCancel(strapi, job), describe(job) -> extra reply fields }
 *   chunkGuard: async (strapi, jobId) => void, before every chunk (agent- or runner-driven); throws to refuse it
 *               (the admin kill switch)
 */
const HOOKS = { gate: null, chunkGuard: null };
function setHooks(h) { const before = { ...HOOKS }; Object.assign(HOOKS, h); return before; }

// ---------------------------------------------------------------- actions

const actions = {};
/**
 * A job action: { permission, events, validate(strapi, uid, spec), apply(strapi, ctx, job, documentId, raw, version,
 * preview, chunk), bindVersion?, undoable?, chunkFull?(chunk) }. `chunk` is per-chunk state the action may keep
 * (ws_replace keeps one replacer per chunk); chunkFull(chunk) true ends the chunk before the next document.
 */
function registerAction(name, impl) { actions[name] = impl; }

const sameScalar = (a, b) => M.canonical(a) === M.canonical(b);

/** publish: "if_clean": whether the item was (or would be) published, or why not. */
function publishItem(item, spec, r, preview) {
  if (!spec.publish) return item;
  if (preview) item.would_publish = Boolean(r.would_publish);
  else item.published = r.published === true;
  if (r.publish_skipped) item.publish_skipped = r.publish_skipped;
  return item;
}

registerAction('patch', {
  permission: 'update',
  events: ['entry.update'],
  validate(strapi, uid, spec) {
    const { set = {}, unset = [], ops = [] } = spec;
    if (!Object.keys(set).length && !unset.length && !ops.length) throw new WsError({ code: 'invalid', message: 'Nothing to change: give set, unset or ops.' });
    E.checkPublishArg(strapi, uid, spec);
    // Rows can only be added (row keys differ per document); links of a to-many relation or a multiple media field (also
    // inside a single component, with path) are added or removed by ref (1.0 hardening item 20: the re-tag of job (d)).
    const bad = ops.filter((o) => (RO.isRefOp(o) ? o.key !== undefined : o.op !== 'add'));
    if (bad.length) {
      throw new WsError({ code: 'invalid', message: `ws_bulk ops can add rows, and add or remove links by ref (no key: row keys differ per document). Got: ${[...new Set(bad.map((o) => (o.key !== undefined ? `${o.op} with key` : o.op)))].join(', ')}. Use ws_patch or ws_batch for keyed row edits.` });
    }
    for (const o of ops.filter(RO.isRefOp)) {
      const t = RO.refTarget(strapi, uid, o);
      if (t.container !== null && t.container !== 'component') throw new WsError({ code: 'invalid', message: `ws_bulk: ref ops inside rows of ${o.field} need a row key, which differs per document. Use ws_patch.` });
    }
    const attrs = M.attrsOf(strapi, uid);
    for (const f of [...Object.keys(set), ...unset, ...ops.map((o) => o.field)]) {
      if (!attrs[f] || M.SKIP_KEYS.has(f)) throw new WsError({ code: 'invalid', message: `Unknown or read-only field ${f}`, allowed: Object.keys(attrs).filter((k) => !M.SKIP_KEYS.has(k)) });
    }
  },
  async apply(strapi, ctx, job, documentId, raw, version, preview) {
    const { set = {}, unset = [], ops = [] } = job.spec;
    const attrs = M.attrsOf(strapi, job.uid);
    const doc = M.normalize(strapi, job.uid, raw);
    // A document that already has every value is not written again (re-running a job is cheap and changes nothing).
    // Only for fields the token may read: otherwise "unchanged" would confirm a guess of a hidden value (review finding).
    const pcr = E.permissionChecker(strapi, ctx, job.uid);
    if (!unset.length && !ops.length && Object.entries(set).every(([f, v]) => M.fieldKind(attrs[f]) === 'scalar' && !pcr.cannot.read(raw, f) && sameScalar(doc[f], v))) {
      return { documentId, status: 'unchanged', version };
    }
    const r = await E.applyPatch(strapi, ctx, {
      _tool: job.tool, uid: job.uid, documentId, locale: job.locale, set: job.spec.set, unset: job.spec.unset, ops: job.spec.ops,
      expected_version: version, ...(job.spec.publish ? { publish: job.spec.publish } : {}), ...(preview ? { return: 'full', dry_run: true } : {}),
    });
    // only ref ops, every one a no-op for this document: nothing written
    if (r.unchanged) return { documentId, status: 'unchanged', version: r.version };
    const item = { documentId, status: 'ok', version: r.version };
    if (r.rows) item.rows = r.rows;
    publishItem(item, job.spec, r, preview);
    if (preview && E.cannotReadDoc(E.permissionChecker(strapi, ctx, job.uid), raw)) {
      item.changed = r.changed;
      item.readable = false; // a token that may write but not read: no before/after values (E.cannotReadDoc)
    } else if (preview) {
      const pc = E.permissionChecker(strapi, ctx, job.uid);
      const fields = r.changed;
      const before = M.presentDoc(strapi, job.uid, await pc.sanitizeOutput(raw), fields, { full: raw }).data;
      const after = Object.fromEntries(Object.entries(r.document || {}).filter(([k]) => fields.includes(k)));
      item.changed = fields;
      item.before = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, U.truncate(v)]));
      item.after = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, U.truncate(v)]));
    }
    return item;
  },
});

registerAction('publish', {
  permission: 'publish',
  events: ['entry.publish'],
  // Item 19: the snapshot binds each document's draft version as the dry run read it; a newer draft is a conflict.
  bindVersion: true,
  undoable: false,
  validate(strapi, uid) {
    if (!E.hasDP(strapi, uid)) throw new WsError({ code: 'invalid', message: `${uid} has no draft & publish.` });
  },
  async apply(strapi, ctx, job, documentId, raw, version, preview) {
    const r = await E.applyPublish(strapi, ctx, { _tool: job.tool, uid: job.uid, documentId, locale: job.locale, expected_version: version, ...(preview ? { dry_run: true } : {}) });
    return { documentId, status: 'ok', published_version: r.published_version };
  },
});

// ---------------------------------------------------------------- matching

/**
 * The documents a filter selects, as the token sees them: filters on fields it cannot read are refused (not ignored),
 * and the permission conditions of the action are added (Content Manager rules). Returns { count, ids, qfilters };
 * ids is null when more than `limit` match. ids are in draft-row id order, read in pages of 5,000 (keyset on id).
 */
async function match(strapi, ctx, uid, locale, filters, action, limit) {
  const pc = E.permissionChecker(strapi, ctx, uid);
  const perm = actions[action].permission;
  if (pc.cannot[perm]()) throw new WsError({ code: 'forbidden', message: `This token cannot ${perm} ${uid}.` });
  // Selecting by a filter is reading: a token without read permission on the type is refused, and the read conditions
  // are added as well as the action's, so counts and selections only consider documents the token can read (the read
  // sanitizer and validateQuery do not narrow anything for a token without a read rule, or with a conditional one).
  if (pc.cannot.read()) throw new WsError({ code: 'forbidden', message: `This token cannot read ${uid}, so it cannot select documents by a filter.` });
  // The filter is checked against READ permission (a filter on a field the token cannot read is refused) and must come
  // through the read sanitizer unchanged; it is NOT passed through the update/publish sanitizer, which silently deletes
  // filter keys on fields the token may read but not write and so widened a job to every document (review finding).
  // The action's permission conditions are added separately. One check for ws_bulk, ws_replace and ws_find
  // (../_lib/filters.js).
  const checked = await FL.checkFilters(pc, filters, { after: 'Nothing was written.' });
  const qfilters = await FL.withConditions(pc, 'read', await FL.withConditions(pc, perm, checked));
  const scope = { ...(locale ? { locale } : {}), ...(E.hasDP(strapi, uid) ? { status: 'draft' } : {}) };
  const count = await strapi.documents(uid).count({ filters: qfilters, ...scope });
  if (count > limit) return { count, ids: null, qfilters };
  const ids = [];
  const seen = new Set();
  let last = 0;
  for (;;) {
    const page = await strapi.documents(uid).findMany({
      filters: Object.keys(qfilters).length ? { $and: [qfilters, { id: { $gt: last } }] } : { id: { $gt: last } },
      ...scope, fields: ['documentId'], sort: 'id:asc', limit: 5000,
    });
    for (const r of page) {
      if (!seen.has(r.documentId)) { seen.add(r.documentId); ids.push(r.documentId); }
      last = Math.max(last, Number(r.id));
    }
    if (page.length < 5000 || ids.length > limit) break;
  }
  if (ids.length > limit) return { count: ids.length, ids: null, qfilters };
  return { count: ids.length, ids, qfilters };
}

/** The draft version of each document (publish: item 19), read in batches of 50; documents gone since are left out. */
async function withVersions(strapi, uid, locale, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const docs = await strapi.documents(uid).findMany({
      filters: { documentId: { $in: batch } }, ...(locale ? { locale } : {}), ...(E.hasDP(strapi, uid) ? { status: 'draft' } : {}),
      populate: M.populateFor(strapi, uid), limit: batch.length,
    });
    const byId = new Map(docs.map((d) => [d.documentId, d]));
    for (const id of batch) if (byId.has(id)) out.push({ documentId: id, version: D.versionOf(strapi, uid, byId.get(id)) });
  }
  return out;
}

/** The documentIds of a chunk that still match the job's filter (one query, after the chunk's locks). */
async function stillMatching(strapi, job, documentIds) {
  if (!job.qfilters || !Object.keys(job.qfilters).length || !documentIds.length) return new Set(documentIds);
  const hits = await strapi.documents(job.uid).findMany({
    filters: { $and: [job.qfilters, { documentId: { $in: documentIds } }] }, ...(job.locale ? { locale: job.locale } : {}),
    ...(E.hasDP(strapi, job.uid) ? { status: 'draft' } : {}), fields: ['documentId'], limit: documentIds.length,
  });
  return new Set(hits.map((h) => h.documentId));
}

/**
 * One document of a job, inside the chunk's transaction (its draft row is already locked). `row` is its item:
 * { docId, planVersion }. `matching` is the chunk's still-matching set (null: check this document alone).
 */
async function applyOne(strapi, ctx, job, row, preview, chunk, matching) {
  const documentId = row.docId;
  let raw;
  try {
    raw = await E.lockAndRead(strapi, job.uid, documentId, job.locale);
  } catch (e) {
    if (e instanceof WsError && e.payload.code === 'not_found') return { documentId, status: 'skipped', reason: 'deleted' };
    throw e;
  }
  const still = matching || await stillMatching(strapi, job, [documentId]);
  if (!still.has(documentId)) return { documentId, status: 'skipped', reason: 'no_longer_matches' };
  const act = actions[job.action];
  // The precondition is the version read now, under the row lock, inside this chunk's transaction ...
  let version = D.versionOf(strapi, job.uid, raw);
  // ... except for an action that binds the planned version (publish, item 19): the reviewed draft or nothing.
  if (act.bindVersion && row.planVersion) {
    if (version !== row.planVersion) {
      throw new WsError({ code: 'version_conflict', documentId, message: 'The draft changed after the dry run that planned this job, so it was not published (only the reviewed draft is). Review it and publish it on its own, or plan a new job.' });
    }
    version = row.planVersion;
  }
  return act.apply(strapi, ctx, job, documentId, raw, version, preview, chunk || {});
}

// ---------------------------------------------------------------- chunks

/** The job as the actions see it (rc.2's field names). */
const jobView = (j) => ({ job_id: j.jobId, tool: j.tool, uid: j.contentType, locale: j.targetLocale || null, action: j.action, spec: j.spec || {}, qfilters: j.qfilters, mode: j.mode, agent: j.agent });

const storedInfo = (it) => {
  if (it.error) return { error: it.error };
  if (it.reason) return { reason: it.reason };
  if (it.publish_skipped) return { publish_skipped: it.publish_skipped };
  if (it.published) return { published: true };
  return null;
};

function finish(job) {
  job.state = 'done';
  job.slot = null;
}

/**
 * Canary (item 18): the first chunk of a job that has more to do. Pauses when a document in it failed or conflicted,
 * or when none changed. Returns the pause record or null.
 */
function canary(items) {
  const n = (s) => items.filter((i) => i.status === s).length;
  const failed = n('failed');
  const conflict = n('conflict');
  const ok = n('ok');
  if (!failed && !conflict && ok) return null;
  return {
    reason: 'canary', code: 'paused_canary', checked: items.length, ok, unchanged: n('unchanged'), skipped: n('skipped'), failed, conflict,
    why: failed || conflict ? 'documents of the first chunk failed or conflicted' : 'the first chunk changed nothing',
  };
}

/**
 * L1 (review of PR #16): in stop_on_error the stopping document is a failed item while the job is stopped (counted in
 * nFailed, listed in failures and in ws_job status), and goes back to pending, uncounted, when the job resumes (the
 * resume retries it from the cursor).
 */
function stopRecord(job, row, error) {
  job.nFailed += 1;
  return { id: row.id, state: 'failed', info: { error } };
}
function unstopRecord(job) {
  if (!job.stopped) return null;
  job.nFailed = Math.max(0, job.nFailed - 1);
  return { docId: job.stopped.documentId };
}

const JOB_FIELDS = ['state', 'slot', 'cursor', 'chunks', 'stopped', 'paused', ...Object.values(S.COUNTERS), ...S.PUBLISH_COUNTERS];

async function chunkTx(strapi, ctx, jobId, owner, fb, guard) {
  const job = await S.lockJob(strapi, jobId);
  if (!job || job.owner !== owner) throw new WsError({ code: 'not_found', message: `No bulk job ${jobId} for this token.`, job_id: jobId });
  if (job.state !== 'running') return { job, items: [], idle: true };
  // [stream G] the runner's lease check: inside this transaction, after the job row lock (a locking read)
  if (guard) await guard(job);
  const cfg = U.settings(strapi).bulk;
  if (cfg.paused) {
    job.state = 'paused';
    job.paused = { reason: 'admin', code: 'jobs_paused', at: new Date().toISOString() };
    await S.saveJob(strapi, job, JOB_FIELDS);
    return { job, items: [], idle: true };
  }
  const rows = await S.nextItems(strapi, jobId, job.cursor, job.chunkSize);
  if (!rows.length) {
    finish(job);
    await S.saveJob(strapi, job, JOB_FIELDS);
    return { job, items: [], idle: true };
  }
  const from = job.cursor;
  // A failure seen in an earlier attempt of this chunk belongs to the chunk that started at its `from`; another call of
  // the same token may have advanced the job meanwhile (review finding: the wrong document could be reported failed).
  if (fb.from !== from) { fb.exclude.clear(); fb.stopAt = null; fb.from = from; }
  const jv = jobView(job);
  const act = actions[jv.action];
  // The history module, when on, groups this chunk's receipt under the job id: ws_undo {receipt_id: job_id} works.
  if (historyOn()) history().annotate({ group: jobId, ...(job.agent ? { agent: job.agent } : {}) });
  const upTo = fb.stopAt ? fb.stopAt.index : rows.length;
  const ids = rows.slice(0, upTo).map((r) => r.docId);
  await D.lockDocuments(strapi, jv.uid, ids, jv.locale);
  const matching = await stillMatching(strapi, jv, ids);
  const sp = D.savepointOf(strapi);
  const chunk = {};
  const cap = cfg.chunkTimeMs;
  const t0 = Date.now();
  const done = [];
  let stop = null;
  let cut = null;
  for (let i = 0; i < upTo; i += 1) {
    // Time cap (item 11) and the action's own budget (ws_replace's regex time, item 22): the chunk commits what it has
    // and the next chunk resumes at this document. At least one document per chunk.
    if (i > 0 && ((cap > 0 && Date.now() - t0 >= cap) || (act.chunkFull && act.chunkFull(chunk)))) { cut = i; break; }
    const row = rows[i];
    if (fb.exclude.has(row.docId)) {
      const err = fb.exclude.get(row.docId);
      done.push({ row, item: { documentId: row.docId, status: D.itemErrorKind(err.code), error: err } });
      continue;
    }
    let item;
    if (sp) {
      // Item 22 (N8): a savepoint per document. A failing document is rolled back alone (Strapi drops the events it
      // queued; its history entry is rewound). rc.2 rolled the whole chunk back and re-ran it once per failing document.
      const mark = historyOn() ? history().entriesMark() : null;
      try {
        item = await sp(() => applyOne(strapi, ctx, jv, row, false, chunk, matching));
      } catch (e) {
        if (D.attemptRetryable(e) || (e && e.name === 'SavepointError')) throw e; // the transaction is gone: re-run it all
        if (mark !== null) history().entriesRewind(mark);
        const err = compactError(E.mapStrapiError(e).payload);
        item = { documentId: row.docId, status: D.itemErrorKind(err.code), error: err };
      }
    } else {
      try {
        item = await applyOne(strapi, ctx, jv, row, false, chunk, matching);
      } catch (e) {
        if (D.attemptRetryable(e)) throw e;
        // No savepoints on this Strapi: roll the chunk back and re-run it without this document (runChunk).
        const f = new ItemFail({ documentId: row.docId, index: i, from, error: compactError(E.mapStrapiError(e).payload) });
        f.cause = e; // runWrite reads the cause chain to decide on a retry (stream B)
        throw f;
      }
    }
    if (item.status === 'failed' && jv.mode !== 'continue') { stop = { index: i, documentId: row.docId, error: item.error }; break; }
    done.push({ row, item });
  }
  if (!stop && cut === null && fb.stopAt) stop = { index: fb.stopAt.index, documentId: fb.stopAt.documentId, error: fb.stopAt.error };
  if (stop) {
    const rec = stopRecord(job, rows[stop.index], stop.error);
    await S.setItem(strapi, rec.id, rec.state, job.chunks + 1, rec.info);
  }
  job.chunks += 1;
  for (const { row, item } of done) {
    await S.setItem(strapi, row.id, item.status, job.chunks, storedInfo(item));
    job[S.COUNTERS[item.status]] += 1;
    if (item.published) job.nPublished += 1;
    if (item.publish_skipped) job.nPublishSkipped += 1;
  }
  const items = done.map((d) => d.item);
  const processed = stop ? stop.index : (cut !== null ? cut : upTo);
  job.cursor = processed ? rows[processed - 1].ordinal + 1 : from;
  if (stop) {
    job.state = 'stopped';
    job.stopped = { documentId: stop.documentId, error: stop.error };
    items.push({ documentId: stop.documentId, status: 'failed', error: stop.error });
    for (const r of rows.slice(stop.index + 1)) items.push({ documentId: r.docId, status: 'not_attempted' });
  } else if (job.cursor >= job.total) {
    finish(job);
    job.stopped = null;
  } else {
    job.state = 'running';
    job.stopped = null;
    if (job.chunks === 1) {
      const p = canary(items);
      if (p) { job.state = 'paused'; job.paused = { ...p, at: new Date().toISOString() }; }
    }
  }
  await S.saveJob(strapi, job, JOB_FIELDS);
  return { job, items };
}

/**
 * Run ONE chunk of a stored job (its own transaction, re-run on a deadlock). Returns { job, items, idle? }. On a
 * Strapi without savepoints a failing document rolls the chunk back and the chunk is re-run without it (continue, or
 * a conflict) or up to it (stop_on_error), as rc.2 did. The hook for an in-Strapi runner.
 */
async function runChunk(strapi, ctx, extra, jobId, owner, guard) {
  // [stream G] the admin kill switch, before the chunk's transaction (a plain read inside it would fix MySQL's
  // snapshot before the document rows are locked)
  if (HOOKS.chunkGuard) await HOOKS.chunkGuard(strapi, jobId);
  const fb = { exclude: new Map(), stopAt: null, from: undefined };
  for (let round = 0; round < 500; round += 1) {
    try {
      return await E.runWrite(strapi, ctx, 'ws_bulk', {}, () => chunkTx(strapi, ctx, jobId, owner, fb, guard), extra);
    } catch (e) {
      if (!(e instanceof ItemFail)) throw e;
      const job = await S.findJob(strapi, jobId);
      if (fb.from !== e.info.from) { fb.exclude.clear(); fb.stopAt = null; fb.from = e.info.from; }
      if (D.itemErrorKind(e.info.error.code) === 'conflict' || (job && job.mode === 'continue')) fb.exclude.set(e.info.documentId, e.info.error);
      else fb.stopAt = e.info;
    }
  }
  throw new WsError({ code: 'write_failed', message: 'Chunk could not be completed.' });
}

// ---------------------------------------------------------------- end report

/**
 * Item 18: once the job is done, one count of the filter now (`still_matching`) and the documents matching now that
 * are not in the job (`late_matches`: created or moved into the filter while it ran; never touched).
 */
async function reconcile(strapi, job) {
  const jv = jobView(job);
  const scope = { ...(jv.locale ? { locale: jv.locale } : {}), ...(E.hasDP(strapi, jv.uid) ? { status: 'draft' } : {}) };
  const qf = jv.qfilters && Object.keys(jv.qfilters).length ? jv.qfilters : {};
  const still = await strapi.documents(jv.uid).count({ filters: qf, ...scope });
  let late = 0;
  const lateIds = [];
  let last = 0;
  let scanned = 0;
  while (scanned < still && scanned <= U.HARD_MAX_DOCUMENTS * 2) {
    const page = await strapi.documents(jv.uid).findMany({
      filters: Object.keys(qf).length ? { $and: [qf, { id: { $gt: last } }] } : { id: { $gt: last } }, ...scope, fields: ['documentId'], sort: 'id:asc', limit: 1000,
    });
    if (!page.length) break;
    scanned += page.length;
    last = Math.max(...page.map((r) => Number(r.id)));
    const ids = [...new Set(page.map((r) => r.documentId))];
    const mem = await S.members(strapi, job.jobId, ids);
    for (const id of ids) {
      if (mem.has(id)) continue;
      late += 1;
      if (lateIds.length < 20) lateIds.push(id);
    }
    if (page.length < 1000) break;
  }
  const out = { still_matching: still, late_matches: late, late_ids: lateIds, checked_at: new Date().toISOString() };
  if (late) out.note = `${late} document(s) match the filter now that were not in the planned set (created or changed while the job ran). The job did not touch them; plan a new job to include them.`;
  return out;
}

// ---------------------------------------------------------------- views

const totalsOf = (j) => ({
  ok: j.nOk, unchanged: j.nUnchanged, skipped: j.nSkipped, failed: j.nFailed, conflict: j.nConflict,
  ...(j.spec && j.spec.publish ? { published: j.nPublished || 0, publish_skipped: j.nPublishSkipped || 0 } : {}),
});

function itemOut(job, r) {
  const info = r.info ? (typeof r.info === 'string' ? JSON.parse(r.info) : r.info) : null;
  let status = r.state;
  const stoppedHere = r.state === 'pending' && job.state === 'stopped' && job.stopped && job.stopped.documentId === r.docId;
  if (status === 'pending') status = stoppedHere ? 'failed' : 'not_attempted';
  const out = { documentId: r.docId, status };
  if (stoppedHere) out.error = job.stopped.error;
  if (info && info.reason) out.reason = info.reason;
  if (info && info.error) out.error = info.error;
  if (info && info.published) out.published = true;
  if (info && info.publish_skipped) out.publish_skipped = info.publish_skipped;
  if (r.chunk) out.chunk = r.chunk;
  return out;
}

const LIST_MAX = 200;
const PROBLEMS_MAX = 20;
const LIST_DRIVER_TEXT = 200;
/** An item for a reply list: the driver's own text cut to LIST_DRIVER_TEXT characters. */
function trimItem(it) {
  if (!it || !it.error || typeof it.error.driver_error !== 'string' || it.error.driver_error.length <= LIST_DRIVER_TEXT) return it;
  return { ...it, error: { ...it.error, driver_error: `${it.error.driver_error.slice(0, LIST_DRIVER_TEXT)}…` } };
}

const PAUSE_TEXT = {
  canary: 'The job paused after its first chunk (the canary): some of its documents failed or conflicted, or none changed. Look at `items` and `paused`. Resume with {job_id, control: "resume"} if that is expected, or stop it with ws_job {action: "cancel", job_id}. The documents of the first chunk are written; the rest are not.',
  admin: 'The site owner paused every bulk job (config writesafe.bulk.paused). Nothing more is written until they lift it; then resume with {job_id, control: "resume"}.',
  // [stream G] pauses only an admin lifts (Write-safe jobs page); control: "resume" is refused for them
  admin_job: 'An admin paused this job on the Write-safe jobs page. Only an admin can resume it there; tell the user.',
  permission_changed: 'The job is paused: the permissions of the token that asked for it changed. Only an admin can resume it (Write-safe jobs page); tell the user.',
  runner_errors: 'The in-Strapi runner paused this job after repeated errors. Only an admin can resume it (Write-safe jobs page); tell the user.',
};

async function view(strapi, job, items, extra = {}) {
  const status = job.state;
  const ok = items.filter((i) => i.status === 'ok').length;
  // M3 (review of PR #16): one call can run many chunks; its item list is at most LIST_MAX entries (problems first)
  let shown = items;
  let truncated = false;
  if (items.length > LIST_MAX) {
    const problems = items.filter((i) => i.status !== 'ok' && i.status !== 'unchanged');
    shown = problems.slice(0, LIST_MAX);
    truncated = true;
  }
  shown = shown.map(trimItem);
  const r = {
    ok: !['stopped', 'paused', 'awaiting_approval', 'rejected', 'expired'].includes(status),
    job_id: job.jobId, status, tool: job.tool, uid: job.contentType, locale: job.targetLocale || null, action: job.action, mode: job.mode,
    total: job.total, processed: job.cursor, remaining: job.total - job.cursor,
    totals: totalsOf(job), chunks_done: job.chunks, undoable: job.undoable,
    items: shown,
  };
  if (truncated) {
    r.items_truncated = true;
    r.items_note = `This call handled ${items.length} documents (${ok} ok); the list shows ${shown.length} of its problems only. ws_job {action: "status", job_id} pages through the problems, with items: "all" through every document.`;
  }
  if (status === 'running') r.next = { hint: `Not finished. Call ${job.tool} again with only {job_id} to continue.`, job_id: job.jobId };
  if (status === 'stopped') {
    // The item's own error (Strapi's or the database's text) stays in `cause`; the message is the plugin's (review item 8).
    r.error = { code: 'job_stopped', message: `Stopped at ${job.stopped.documentId}, which failed (see cause). Documents before it are written; it and the rest are not. Fix the cause and call again with {job_id} to retry from it, start a new job with mode "continue", or cancel this one with ws_job {action: "cancel", job_id}.`, documentId: job.stopped.documentId, cause: job.stopped.error };
  }
  if (status === 'paused') {
    const p = job.paused || {};
    r.paused = p;
    r.error = { code: p.code || 'paused_canary', message: PAUSE_TEXT[p.reason] || PAUSE_TEXT.canary };
  }
  if (status === 'cancelled') r.note = 'The job was cancelled: documents written before are kept; the rest were not written.';
  if (['done', 'stopped', 'paused', 'cancelled'].includes(status)) {
    // M3: at most PROBLEMS_MAX of each, with how many more there are (ws_job status pages through all of them)
    for (const [state, key, n] of [['failed', 'failures', job.nFailed], ['conflict', 'conflicts', job.nConflict]]) {
      if (!n) continue;
      const page = await S.pageItems(strapi, job.jobId, { states: [state], limit: PROBLEMS_MAX });
      const list = page.rows.map((x) => trimItem(itemOut(job, x)));
      if (!list.length) continue;
      r[key] = list;
      if (n > list.length) r[`${key}_more`] = n - list.length;
    }
    if (r.failures_more || r.conflicts_more) r.problems_hint = 'ws_job {action: "status", job_id} lists every failed, conflicting and skipped document, 200 per page.';
  }
  if (status === 'done' && job.reconcile) r.reconcile = job.reconcile;
  // [stream G] approval, runner and admin-pause fields
  if (HOOKS.gate) Object.assign(r, HOOKS.gate.describe(job));
  return { ...r, ...extra };
}

async function statusView(strapi, job, a) {
  const all = a.items === 'all';
  const after = parseCursor(a.cursor);
  // Item 23: one page of item rows (rc.2 read up to 5,000 chunk receipts and returned every item of the job).
  const page = await S.pageItems(strapi, job.jobId, { after, states: all ? null : ['failed', 'conflict', 'skipped'], limit: 200 });
  const v = await view(strapi, job, []);
  v.items = page.rows.map((x) => itemOut(job, x));
  v.items_scope = all ? 'all' : 'problems';
  delete v.items_note;
  if (page.next !== null) v.items_next = { cursor: String(page.next), hint: 'More items: call ws_job {action: "status"} again with this job_id and cursor (and the same items).' };
  if (!all) v.items_hint = 'Only failed, conflicting and skipped documents are listed; items: "all" pages through every document.';
  return v;
}

// ---------------------------------------------------------------- tool flow

/**
 * The plan's spec hash (review of PR #16, M2): the job as it will RUN, not the raw arguments: the resolved spec
 * (ws_bulk: set/unset/ops and publish "if_clean"; ws_replace: the pattern, publish and the fields resolved from the
 * token's permissions, which can change between dry run and start), the action, mode and allow_all. Arguments that
 * run or check a job (chunk_size, max_chunks, preview, max_documents, expected_count, agent, ...) are not part of it;
 * uid, locale and filter are bound by the MAC separately.
 */
const specHash = (tool, a, desc) => M.sha(M.canonical({
  v: 2, tool, action: desc.action, spec: desc.spec || {}, mode: a.mode || 'stop_on_error', allow_all: Boolean(a.allow_all),
}));

/** Checks of a start once its MAC verified and no job exists for it yet: expiry, then undoable (M2). */
function startCheck(parsed, { undoable, now = Date.now() }) {
  if (P.expired(parsed, now)) {
    return new WsError({ code: 'plan_expired', message: `This plan_token expired at ${new Date(parsed.exp * 1000).toISOString()}. Dry-run the call again for a new one. Nothing was written.` });
  }
  if (parsed.undoable !== undoable) {
    return new WsError({ code: 'plan_mismatch', reason: 'undoable', message: `The plan said this job ${parsed.undoable ? 'can' : 'cannot'} be undone, which is not true any more (the history module was ${undoable ? 'turned on' : 'turned off'}). Dry-run again. Nothing was written.` });
  }
  return null;
}

/** L3, L5: the job a {job_id} call names: this token's, this tool's, with its action loaded. */
function checkJob(job, owner, tool) {
  if (!job || job.owner !== owner || job.tool !== tool) throw new WsError({ code: 'not_found', message: `No ${tool} job ${job ? job.jobId : ''} for this token.`.replace('  ', ' '), ...(job ? { job_id: job.jobId } : {}) });
  if (!actions[job.action]) throw new WsError({ code: 'unsupported', job_id: job.jobId, message: `This job's action (${job.action}) is not available: its module is off. Turn the module on to resume or read it.` });
  return job;
}

/** L4: a status cursor is the integer of an earlier items_next.cursor. */
function parseCursor(c) {
  if (c === undefined) return -1;
  if (typeof c !== 'string' || !/^-?\d+$/.test(c) || Number(c) < -1 || !Number.isSafeInteger(Number(c))) {
    throw new WsError({ code: 'invalid', message: 'cursor must be the items_next.cursor (or next_cursor) of an earlier ws_job reply.' });
  }
  return Number(c);
}

const UNIQUE_RE = /23505|SQLITE_CONSTRAINT|ER_DUP_ENTRY|UNIQUE constraint|duplicate key/i;
const isUnique = (e) => UNIQUE_RE.test(`${e?.code || ''} ${e?.message || ''} ${e?.cause?.code || ''} ${e?.payload?.driver_error || ''}`);

/** Stratified preview positions: first, ..., last (n spread over count). */
function previewPositions(count, n) {
  if (!count || !n) return [];
  if (n >= count) return [...Array(count).keys()];
  if (n === 1) return [0];
  const out = new Set();
  for (let k = 0; k < n; k += 1) out.add(Math.round((k * (count - 1)) / (n - 1)));
  return [...out].sort((x, y) => x - y);
}

/**
 * Dry-run previews (written, then rolled back) of some rows of a job ({ position?, docId, planVersion? }): the dry run
 * and the approval samples (stream G).
 */
async function previewRows(strapi, ctx, extra, tool, jv, rows, sizes = null) {
  const preview = [];
  for (const r of rows) {
    const row = { docId: r.docId, planVersion: r.planVersion };
    const pos = r.position !== undefined ? { position: r.position } : {};
    try {
      const it = await E.runWrite(strapi, ctx, tool, { dry_run: true, ...(sizes ? { _measure_undo: true } : {}) }, async () => {
        await D.lockDocuments(strapi, jv.uid, [row.docId], jv.locale);
        return applyOne(strapi, ctx, jv, row, true, {});
      }, extra);
      delete it.dry_run; delete it.written;
      if ('version' in it) delete it.version;
      // stream F (item 21): the dry run measures each previewed write's before-image (undo_budget)
      if (it.undo_bytes) { if (sizes) sizes.push(it.undo_bytes); delete it.undo_bytes; }
      preview.push({ ...pos, ...it });
    } catch (e) {
      const err = compactError(E.mapStrapiError(e).payload);
      preview.push({ ...pos, documentId: row.docId, status: D.itemErrorKind(err.code), error: err });
    }
  }
  return preview;
}

async function ready(strapi) {
  const r = await S.ensure(strapi);
  if (!r.ok) throw new WsError({ code: 'unsupported', message: `Bulk jobs are unavailable: the plugin could not create the indexes of its job tables (${r.reason || 'unknown'}). An admin should check the server log. Nothing was written.` });
}

/** The job's documents with the ceiling applied: { entries: [{documentId, version?}], count, qfilters, extra }. */
async function collect(strapi, desc, max) {
  const c = await desc.collect(max);
  if (!c.ids || c.count > max) {
    throw new WsError({ code: 'too_many_documents', match_count: c.count, max_documents: max,
      message: `${c.count} documents match; the limit for one job is ${max}${max < desc.ceiling ? ` (max_documents; the server allows up to ${desc.ceiling})` : ` (config writesafe.bulk.maxDocuments; an admin may raise it up to ${U.HARD_MAX_DOCUMENTS})`}. Narrow the filter (for example by a date range or another field) and run one job per part. Nothing was written.` });
  }
  const entries = actions[desc.action].bindVersion ? await withVersions(strapi, desc.uid, desc.locale, c.ids) : c.ids.map((documentId) => ({ documentId }));
  return { entries, count: entries.length, qfilters: c.qfilters, extra: c.extra };
}
/**
 * The undo byte budget of a job (stream F, item 21), next to E's `undoable`: before-images are kept up to
 * history.maxBeforeBytes per document and history.maxJobBeforeBytes per job; the estimate extrapolates the previewed
 * writes. within_budget false: some changes will not be undoable (over_document_cap, or past the job budget).
 */
function undoBudget(sizes, count, undoable) {
  const o = undoable && historyOn() ? history().options() : null;
  if (!o) return undefined;
  const out = { per_document_bytes: o.maxBeforeBytes, job_budget_bytes: o.maxJobBeforeBytes, sampled: sizes.length };
  if (!sizes.length) return { ...out, estimated_bytes: null, within_budget: null };
  const over = sizes.reduce((x, s) => x + (s.over_document_cap || 0), 0);
  const est = Math.round((sizes.reduce((x, s) => x + s.bytes, 0) / sizes.length) * count);
  Object.assign(out, { estimated_bytes: est, over_document_cap: over, within_budget: !over && est <= o.maxJobBeforeBytes });
  if (!out.within_budget) {
    out.note = `${over ? `${over} of ${sizes.length} previewed documents are over the per-document cap: their change cannot be undone. ` : ''}`
      + `${est > o.maxJobBeforeBytes ? 'The estimate is over the job budget: documents written after it is used cannot be undone. ' : ''}`
      + 'Split the job, or raise history.maxBeforeBytes / history.maxJobBeforeBytes.';
  }
  return out;
}


/**
 * Shared by ws_bulk and ws_replace. `describe(strapi, ctx, a, cfg)` checks the arguments cheaply and returns
 * { uid, locale, action, filters, spec, collect(max) }; collect returns { count, ids|null, qfilters, extra? }
 * (ws_bulk: the filter match; ws_replace: the scan for the text).
 */
async function handle(strapi, ctx, extra, tool, a, cfg, describe) {
  refuseMoved(a);
  const owner = U.callerId(ctx, extra);
  await ready(strapi);
  // read per call (the config may change in a running app)
  const budget = U.settings(strapi).bulk.timeBudgetMs;

  if (a.job_id) {
    const job = checkJob(await S.findJob(strapi, a.job_id), owner, tool);
    return control(strapi, ctx, extra, job, owner, a, budget);
  }
  if (a.control) throw new WsError({ code: 'invalid', message: 'control needs job_id.' });

  const desc = await describe(strapi, ctx, a, cfg);
  const act = actions[desc.action];
  act.validate(strapi, desc.uid, desc.spec || {});
  // publish: "if_clean" needs publish permission (refused before any write, dry run included)
  if (desc.spec && desc.spec.publish && E.permissionChecker(strapi, ctx, desc.uid).cannot.publish()) {
    throw new WsError({ code: 'forbidden', message: `This token cannot publish ${desc.uid}, so publish: "if_clean" is refused. Leave publish out to write drafts only. Nothing was written.` });
  }
  // [stream G] with approvals, a job may match up to the admin ceiling; above bulk.maxDocuments it needs approval
  desc.ceiling = HOOKS.gate ? HOOKS.gate.ceiling(cfg) : cfg.maxDocuments;
  const max = Math.min(a.max_documents ?? desc.ceiling, desc.ceiling);
  const chunkSize = Math.min(a.chunk_size ?? cfg.chunkSize, cfg.maxChunkSize);
  const undoable = historyOn() && act.undoable !== false;
  const fields = { owner, uid: desc.uid, locale: desc.locale || null, filters: desc.filters || {}, action: desc.action, specHash: specHash(tool, a, desc) };

  if (a.dry_run) {
    const c = await collect(strapi, desc, max);
    const job = jobView({ jobId: null, tool, contentType: desc.uid, targetLocale: desc.locale, action: desc.action, spec: desc.spec, qfilters: c.qfilters, mode: a.mode || 'stop_on_error' });
    const n = Math.min(a.preview ?? 5, cfg.previewMax);
    const sizes = []; // item 21: each previewed write's before-image size (undo_budget)
    const preview = await previewRows(strapi, ctx, extra, tool, job,
      previewPositions(c.count, n).map((i) => ({ position: i, docId: c.entries[i].documentId, planVersion: c.entries[i].version })), sizes);
    // publish "if_clean": each document published also fires entry.publish (at_most counts both)
    const kinds = [...(act.events || ['entry.update']), ...(desc.spec && desc.spec.publish ? ['entry.publish'] : [])];
    const out = {
      ok: true, dry_run: true, written: false, tool, uid: desc.uid, locale: desc.locale || null, action: desc.action,
      match_count: c.count, max_documents: max, chunk_size: chunkSize, chunks: Math.ceil(c.count / chunkSize), preview,
      // Item 18 (fourth review, point 8): what the job emits. Strapi fires these after each chunk commits, once per
      // written document (an unchanged or skipped one fires none); every webhook subscribed to them is called as often.
      events: { per_document: kinds, at_most: c.count * kinds.length, note: 'Fired after each chunk commits, once per document actually written; every webhook subscribed to these events is called that often. On a localized type, a change to a non-localized field is also copied by Strapi to the other locales\' drafts, which can fire more events than at_most counts. Lifecycle hooks and Document Service middlewares also ran during this dry run.' },
      undoable, ...(undoable ? {} : { undo_note: act.undoable === false ? 'A publish is not undone by ws_undo.' : 'The history module is off: ws_undo cannot revert this job.' }),
      ...(desc.spec && desc.spec.publish ? {
        publish: desc.spec.publish,
        publish_note: 'Each document is published in the same write only if its draft had no other unpublished changes (would_publish in the preview); the others stay drafts. An undo reverts the drafts, not what was published.',
      } : {}),
      ...(undoable ? { undo_budget: undoBudget(sizes, c.count, undoable) } : {}),
      ...(c.extra || {}),
      // [stream G] whether starting it needs an admin's approval (and whether approvals are possible here)
      ...(HOOKS.gate ? HOOKS.gate.dryRunNote(strapi, { uid: desc.uid, action: desc.action, spec: desc.spec || {} }, c.count, ctx) : {}),
    };
    if (c.count) {
      const signed = P.sign(strapi, { ...fields, count: c.count, idHash: P.idListHash(c.entries), undoable }, cfg.planTtlSeconds);
      out.plan_token = signed.token;
      out.expires_at = signed.expires_at;
      out.hint = `To start, send the same call without dry_run and with plan_token (valid until ${signed.expires_at}). The job runs on exactly these ${c.count} documents; if the matches change before the start, it is refused (plan_mismatch) and nothing is written.`;
    } else {
      out.hint = 'Nothing matches.';
    }
    return out;
  }

  // ---- start
  if (!a.plan_token) {
    throw new WsError({ code: 'plan_required', message: 'A job starts only from a plan: run the same call with dry_run: true, check its match_count and preview, then send the call again with the plan_token it returned. Nothing was written.' });
  }
  const parsed = P.parse(a.plan_token);
  if (!parsed) throw new WsError({ code: 'plan_required', message: 'plan_token is not a plan token from a dry run of this tool. Run the call with dry_run: true and use the plan_token it returns. Nothing was written.' });
  if (!P.verify(strapi, parsed, fields)) {
    throw new WsError({ code: 'plan_mismatch', reason: 'request', message: 'This plan_token was made for a different request (other filters, change, type, locale or mode) or by another token. Send exactly the call you dry-ran, with dry_run left out, or dry-run this call. Nothing was written.' });
  }
  const jobId = P.jobIdOf(parsed.mac);
  const prior = await S.findJob(strapi, jobId);
  if (prior) {
    checkJob(prior, owner, tool);
    return control(strapi, ctx, extra, prior, owner, { ...a, control: undefined }, budget, { resumed: true });
  }
  const refused = startCheck(parsed, { undoable });
  if (refused) throw refused;
  if (U.settings(strapi).bulk.paused) throw new WsError({ code: 'jobs_paused', message: PAUSE_TEXT.admin });
  const c = await collect(strapi, desc, max);
  const idHash = P.idListHash(c.entries);
  if (c.count !== parsed.count || idHash !== parsed.idHash) {
    throw new WsError({ code: 'plan_mismatch', reason: 'matches', planned_count: parsed.count, match_count: c.count,
      message: `The documents this call selects are not the planned set any more (${parsed.count} planned, ${c.count} now${c.count === parsed.count ? ', but not the same documents or drafts' : ''}). Nothing was written. Dry-run again to see the current matches and get a new plan_token.` });
  }
  if (a.expected_count !== undefined && a.expected_count !== c.count) {
    throw new WsError({ code: 'count_changed', match_count: c.count, expected_count: a.expected_count, message: `${c.count} documents match now, not ${a.expected_count} as expected. Nothing was written. Dry-run again to see the current matches.` });
  }
  const job = {
    jobId, owner, slot: `${owner}|${desc.uid}`, tool, contentType: desc.uid, targetLocale: desc.locale || null, action: desc.action,
    spec: desc.spec, qfilters: c.qfilters, mode: a.mode || 'stop_on_error', chunkSize, state: 'running', total: c.count, cursor: 0, chunks: 0,
    nOk: 0, nUnchanged: 0, nSkipped: 0, nFailed: 0, nConflict: 0, nPublished: 0, nPublishSkipped: 0, undoable, idHash, ...(a.agent ? { agent: String(a.agent).slice(0, 80) } : {}),
  };
  // [stream G] above the automatic tier: refused here (no approvals possible, unsafe token, ...) or stored as
  // awaiting_approval (it holds the slot) and not run until an admin approves; the snapshot is written either way
  const gated = HOOKS.gate ? await HOOKS.gate.beforeCreate(strapi, ctx, extra, job, c.count) : null;
  const active = async () => {
    const other = await S.activeJob(strapi, job.slot);
    if (!other) return null;
    return new WsError({ code: 'job_running', job_id: other.jobId, status: other.state,
      message: `This token already has an active ${other.tool} job on ${desc.uid} (${other.state}). Finish it with {job_id}, or cancel it with ws_job {action: "cancel", job_id}, then start this one. Nothing was written.` });
  };
  try {
    await E.runWrite(strapi, ctx, tool, {}, async () => {
      if (await S.findJob(strapi, jobId)) return {};
      const busy = await active();
      if (busy) throw busy;
      await S.createJob(strapi, job, c.entries);
      return {};
    }, extra);
  } catch (e) {
    if (e instanceof WsError && e.payload.code === 'job_running') throw e;
    if (!isUnique(e)) throw e;
    const again = await S.findJob(strapi, jobId);
    if (again && again.owner === owner) return resumeView(strapi, ctx, extra, again, owner, a, budget, { resumed: true });
    const busy = await active();
    if (busy) throw busy;
    throw e;
  }
  if (gated && gated.awaiting) return HOOKS.gate.afterCreate(strapi, ctx, extra, job, gated);
  return runJob(strapi, ctx, extra, jobId, owner, budget, a.max_chunks);
}

/** ws_job cancel: under the row lock (a running chunk finishes first) an active job is cancelled; writes stay. */
async function cancelJob(strapi, ctx, extra, job) {
  let j = job;
  let cancelled = false;
  await E.runWrite(strapi, ctx, 'ws_bulk', {}, async () => {
    j = await S.lockJob(strapi, job.jobId);
    if (!j) throw new WsError({ code: 'not_found', job_id: job.jobId, message: `No bulk job ${job.jobId} for this token (it was removed meanwhile).` });
    if (S.ACTIVE.includes(j.state)) {
      j.state = 'cancelled';
      j.slot = null;
      cancelled = true;
      await S.saveJob(strapi, j, ['state', 'slot']);
    }
    return {};
  }, extra);
  if (cancelled && HOOKS.gate) await HOOKS.gate.onCancel(strapi, j);
  return { job: j, cancelled };
}

/** {job_id} (with control) on an existing job. */
async function control(strapi, ctx, extra, job, owner, a, budget, extraView) {
  // [stream G] a job waiting for approval starts here once approved; an admin's pause is lifted only by an admin
  if (HOOKS.gate && a.control !== 'cancel') {
    const g = await HOOKS.gate.onResume(strapi, ctx, extra, job, a);
    if (g && g.reply) return { ...g.reply, ...(extraView || {}) };
    if (g && g.reload) job = await S.findJob(strapi, job.jobId);
  }
  // internal only: the tools refuse control "cancel" (ws_job cancels)
  if (a.control === 'cancel') return view(strapi, (await cancelJob(strapi, ctx, extra, job)).job, []);
  return resumeView(strapi, ctx, extra, job, owner, a, budget, extraView);
}

async function resumeView(strapi, ctx, extra, job, owner, a, budget, extraView) {
  if (job.state === 'cancelled') {
    throw new WsError({ code: 'job_cancelled', job_id: job.jobId, message: 'This job was cancelled; it cannot be resumed. Documents written before the cancel are kept. Dry-run again to plan a new job.' });
  }
  if (job.state === 'paused' && a.control !== 'resume') return view(strapi, job, [], extraView);
  if (['stopped', 'paused'].includes(job.state)) {
    if (U.settings(strapi).bulk.paused) throw new WsError({ code: 'jobs_paused', message: PAUSE_TEXT.admin });
    await E.runWrite(strapi, ctx, 'ws_bulk', {}, async () => {
      const j = await S.lockJob(strapi, job.jobId);
      if (!j) throw new WsError({ code: 'not_found', job_id: job.jobId, message: `No bulk job ${job.jobId} for this token (it was removed meanwhile).` });
      if (['stopped', 'paused'].includes(j.state)) {
        const back = j.state === 'stopped' ? unstopRecord(j) : null;
        if (back) await S.resetItem(strapi, j.jobId, back.docId);
        j.state = 'running';
        j.stopped = null;
        j.paused = null;
        await S.saveJob(strapi, j, ['state', 'stopped', 'paused', 'nFailed']);
      }
      return {};
    }, extra);
  }
  return runJob(strapi, ctx, extra, job.jobId, owner, budget, a.max_chunks, extraView);
}

async function runJob(strapi, ctx, extra, jobId, owner, budget, maxChunks, extraView) {
  const t0 = Date.now();
  const items = [];
  const pace = U.settings(strapi).bulk.paceMs;
  let job = null;
  for (let n = 0; ; n += 1) {
    if (maxChunks && n >= maxChunks) break;
    if (n > 0 && Date.now() - t0 > budget) break;
    if (n > 0 && pace > 0) await sleep(pace); // pacing (item 18): other writers get the rows between chunks
    const r = await runChunk(strapi, ctx, extra, jobId, owner);
    job = r.job;
    items.push(...r.items);
    if (r.idle || job.state !== 'running') break;
  }
  if (!job) job = await S.findJob(strapi, jobId);
  if (job.state === 'done' && !job.reconcile) {
    job.reconcile = await reconcile(strapi, job);
    await S.saveJob(strapi, job, ['reconcile']);
  }
  return view(strapi, job, items, extraView);
}

const ID = { bool: (x) => x, int: (x) => x, obj: (x) => x, arr: (x) => x };

// moved to ws_job: refused here (schema and handler) with an invalid error naming ws_job. max_chunks stays here: it
// paces a call ({job_id, max_chunks} or a start), it does not read or control the job.
const MOVED_KEYS = ['status_only', 'items', 'cursor'];
const MOVED = 'moved to the ws_job tool: ws_job {action: "status", job_id} reads a job (items, cursor), {action: "cancel", job_id} '
  + 'cancels it. Here {job_id} continues a job (max_chunks limits the chunks of the call), {job_id, control: "resume"} resumes a paused one. Nothing was run.';
const CANCEL_MOVED = `control "cancel": ${MOVED}`;
const movedText = (keys) => `${keys.join(', ')}: ${MOVED}`;
const movedIn = (a) => MOVED_KEYS.filter((k) => a && a[k] !== undefined);
function refuseMoved(a) {
  const keys = movedIn(a);
  if (a && a.control === 'cancel') throw new WsError({ code: 'invalid', message: CANCEL_MOVED });
  if (keys.length) throw new WsError({ code: 'invalid', message: movedText(keys) });
}
/** z.object(shape).strict(); refusing a moved argument names ws_job (zod 4: `error`, zod 3: `errorMap`). */
function jobSchema(shape) {
  const why = (code, keys) => {
    if (code !== 'unrecognized_keys' || !Array.isArray(keys)) return undefined;
    const moved = keys.filter((k) => MOVED_KEYS.includes(k));
    if (moved.length) return movedText(moved);
    if (keys.includes('force') && !F.allowed()) return F.DISABLED_MESSAGE;
    return undefined;
  };
  if (typeof z.toJSONSchema === 'function') return z.object(shape, { error: (iss) => why(iss.code, iss.keys) }).strict();
  return z.object(shape, { errorMap: (iss, ctx) => ({ message: why(iss.code, iss.keys) || ctx.defaultError }) }).strict();
}
function controlSchema() {
  const why = (input) => (input === 'cancel' ? CANCEL_MOVED : undefined);
  if (typeof z.toJSONSchema === 'function') return z.enum(['resume'], { error: (iss) => why(iss.input) });
  return z.enum(['resume'], { errorMap: (iss, ctx) => ({ message: why(ctx.data) || ctx.defaultError }) });
}

function jobArgs(L = ID) {
  return {
    plan_token: z.string().max(400).optional().describe('From your dry run: starts the job on exactly the documents the dry run matched. Required to start (plan_required); refused if the request or the matches changed (plan_mismatch) or after 15 minutes (plan_expired). Sending the same start again resumes the job it started.'),
    max_documents: L.int(z.number().int().min(1)).optional().describe('Refuse if more documents match (default and ceiling: server config writesafe.bulk.maxDocuments, 5000).'),
    expected_count: L.int(z.number().int().min(0)).optional().describe('Optional: match_count from your dry run (count_changed if it differs). The plan_token already checks the exact set.'),
    chunk_size: L.int(z.number().int().min(1)).optional().describe('Documents per transaction (default 25, max 100).'),
    mode: z.enum(['stop_on_error', 'continue']).optional().describe('stop_on_error (default): stop at the first failing document; continue: record it as failed and go on.'),
    dry_run: L.bool(z.boolean()).optional().describe('Count the matches, preview a spread of the changes (patches are written, then rolled back, so Strapi lifecycle hooks and middlewares run for them; publishes are previews that do not call Strapi\'s publish) and get a plan_token. Nothing is stored.'),
    preview: L.int(z.number().int().min(0).max(20)).optional().describe('Dry run: how many documents to preview, spread from first to last (default 5).'),
    job_id: z.string().optional().describe('Continue a job this token started: only job_id, optionally max_chunks (and control "resume" if paused). Reading, cancelling, undoing: ws_job.'),
    max_chunks: L.int(z.number().int().min(1)).optional().describe('Run at most this many chunks in this call (the job stays resumable with {job_id}). Default: until done or the time budget is used.'),
    control: controlSchema().optional().describe('With job_id: "resume" a paused job (e.g. after the canary). To cancel use ws_job.'),
    ...E.MOD.writeArgs(z), // [integration] e.g. `agent` (history module): the label goes on every chunk receipt
  };
}

// publish only when given: a plan without it keeps its rc.2 spec hash (and cannot start a job that publishes)
const bulkSpec = (a) => ({ set: a.set, unset: a.unset, ops: a.ops, ...(a.publish !== undefined ? { publish: a.publish } : {}) });

function toolDef(strapi, h, cfg) {
  const bcfg = cfg.bulk;
  const L = h.lenient || ID;
  return {
    name: 'ws_bulk',
    title: 'Write-safe: patch or publish every document matching a filter',
    description: 'One change over many documents: action "patch" (set/unset fields, add rows, add/remove links by ref) or "publish", on every draft that matches `filters` (Strapi filter syntax, e.g. {"category": {"name": {"$eq": "News"}}}). '
      + 'Two calls: first dry_run: true, which returns match_count, a before/after preview, the events it will fire and a plan_token; then the same call without dry_run, with plan_token. '
      + 'The job runs on exactly the documents the dry run matched (documents added later are not touched; the end report counts them). Each document is re-read under lock and written with its current version as precondition '
      + '(publish: only the draft version the dry run saw), and gets a status (ok, unchanged, skipped, failed, conflict). '
      + 'patch with publish: "if_clean" also publishes each document whose draft had no other unpublished changes. '
      + 'Long jobs return status "running" with a job_id; call again with {job_id} to continue. ws_job reads, lists, cancels or undoes jobs. '
      + `A filter is required (allow_all: true to select every document). At most ${bcfg.maxDocuments} documents per job.`,
    // update or publish (1.0 hardening item 9): a publish-only token may run action "publish"; match() checks the
    // action's own permission.
    auth: h.policies(strapi, ['plugin::content-manager.explorer.update', 'plugin::content-manager.explorer.publish']),
    resolveInputSchema: () => jobSchema({
      uid: h.uidSchema(strapi).optional().describe('Content type UID (not needed with job_id).'),
      locale: h.localeSchema,
      filters: L.obj(z.object({}).catchall(z.any())).optional().describe('Strapi filters selecting the drafts, e.g. {"note": {"$null": true}}. Required unless allow_all is true.'),
      allow_all: L.bool(z.boolean()).optional().describe('Select every document of the type (no filter). Without it an empty or missing filter is refused (filter_required).'),
      action: z.enum(['patch', 'publish']).optional().describe('patch (default) or publish.'),
      set: L.obj(z.object({}).catchall(z.any())).optional().describe('patch: fields to set on every document (as ws_patch set).'),
      unset: L.arr(z.array(z.string())).optional().describe('patch: fields to clear on every document (as ws_patch unset).'),
      ops: L.arr(z.array(L.obj(z.object({}).passthrough()))).optional().describe('patch: ops without keys (row keys differ per document): {op: "add", ...} rows, and {op: "add"|"remove", field, ref} links (keeps other links).'),
      publish: z.enum(['if_clean']).optional().describe('patch: "if_clean": also publish each document in the same write if its draft equalled its live version before; else it stays a draft (publish_skipped). Needs publish permission.'),
      ...jobArgs(L),
    }),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try {
        const r = await handle(strapi, context, extra, 'ws_bulk', args, bcfg, async (st, ctx, a) => {
          if (!a.uid) throw new WsError({ code: 'invalid', message: 'uid is required to plan a job (or give job_id to resume one).' });
          E.checkUid(st, a.uid);
          const action = a.action || 'patch';
          if (action === 'publish' && (a.set || a.unset || a.ops)) throw new WsError({ code: 'invalid', message: 'publish takes no set, unset or ops.' });
          if (action === 'publish' && a.publish !== undefined) throw new WsError({ code: 'invalid', message: 'publish: "if_clean" goes with action "patch" (action "publish" publishes every matching draft as it is).' });
          // Item 17: a missing or empty filter selected every document (fourth review N17: `{uid, set}` alone patched
          // everything up to the ceiling).
          if (isEmptyFilter(a.filters) && !a.allow_all) {
            throw new WsError({ code: 'filter_required', message: 'filters is missing or empty, which would select every document of the type. Give a filter, or allow_all: true if every document is really meant. Nothing was written.' });
          }
          const locale = await E.resolveLocale(st, a.uid, a.locale);
          const filters = a.filters || {};
          return {
            uid: a.uid, locale, action, filters, spec: action === 'patch' ? bulkSpec(a) : {},
            collect: (max) => match(st, ctx, a.uid, locale, filters, action, max),
          };
        });
        return r.ok === false ? h.fail(r) : h.ok(r);
      } catch (e) { return h.fail(h.errorOf(e)); }
    },
  };
}

module.exports = {
  toolDef, registerAction, handle, jobArgs, match, applyOne, runChunk, chunkTx, reconcile, statusView, view, canary, previewPositions, specHash,
  actions, isEmptyFilter, startCheck, checkJob, parseCursor, compactError, stopRecord, unstopRecord, control,
  cancelJob, refuseMoved, jobSchema, MOVED, MOVED_KEYS, bulkSpec, publishItem, totalsOf, itemOut, storedInfo, ready, runJob,
  // [stream G] used by server/runner/adapter.js and server/approval/gate.js
  setHooks, jobView, previewRows, PAUSE_TEXT,
};
