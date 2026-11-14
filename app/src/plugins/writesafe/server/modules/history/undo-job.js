'use strict';

/**
 * Undo as a job (1.0 hardening item 21). The undo of a job (ws_bulk, ws_replace, an undo job), or of a receipt with
 * more than INLINE_MAX entries (not under on_conflict "stop"), runs in chunks of `chunk_size` entries, each its own
 * transaction: lock the job row, take the next entries from the cursor, lock their documents in one order, revert,
 * record the chunk, move the cursor. A killed process loses only the running chunk. The walk goes backwards (newest
 * receipt, newest entry first). Reverted entries are marked one by one; the undo's own entries name what they reverted
 * (uo). Conflicts are skipped and listed ("skip") or stop the job ("stop"); unreadable entries are only counted. State
 * lives behind the undo-store adapter.
 */
const crypto = require('crypto');
const M = require('../../model');
const C = require('./capture');
const U = require('./undo');
const S = require('./undo-store');

const RECEIPT_UID = C.RECEIPT_UID;

const HINT_RUNNING = 'Not finished. Call ws_undo again with only {undo_job_id} to continue (also after an interruption: the job resumes where its last committed chunk ended).';
const HINT_CONFLICTS = 'These documents changed after the job wrote them, so they were left as they are (on_conflict "skip"). `before` holds the values '
  + 'the job replaced (fields this token can read). To revert one by hand, read it (ws_get) and put back only what is still yours with ws_patch. '
  + 'Calling ws_undo with the same receipt_id later tries the documents that are still not undone again.';
const HINT_STOPPED = 'Stopped at a document that changed after the job wrote it (on_conflict "stop"). The documents before it in undo order are reverted; '
  + 'it and the rest are not. `conflict.before` holds the values the job replaced. Leave it, or change it back by hand, then call ws_undo with '
  + '{undo_job_id} to continue from it; or start the undo again with on_conflict "skip" to leave such documents and go on.';

const NOT_UNDOABLE = ['publish', 'import'];
const TOTALS = ['restored', 'unchanged', 'deleted', 'recreated', 'already_gone', 'conflicts', 'failed', 'too_large', 'not_undoable', 'expired', 'unreadable', 'already_undone'];

/** Key of the running undo job of one caller, receipt and mode (one at a time; a repeat call resumes it). */
const scopeKey = (owner, a) => M.sha(`${owner}|${a.receipt_id}|${a.on_conflict || 'skip'}|${a.force ? 1 : 0}|${a.idempotency_key || ''}`).slice(0, 40);

/**
 * The next `n` entries in undo order from `cursor` ({row, i}; rows sorted by id descending, entries newest first).
 * Undone entries are skipped and counted (skipBefore per entry, tail after the last).
 */
function nextEntries(rows, cursor, n, pending0 = 0) {
  const entries = [];
  const skipped = { already_undone: 0, tail: 0 };
  let pending = pending0;
  for (const r of rows) {
    if (cursor && r.id > cursor.row) continue;
    const h = r.history || {};
    const es = Array.isArray(h.e) ? h.e : [];
    const start = cursor && r.id === cursor.row ? cursor.i : es.length - 1;
    for (let k = start; k >= 0; k -= 1) {
      if (entries.length >= n) {
        skipped.tail = pending;
        return { entries, cursor: { row: r.id, i: k }, exhausted: false, skipped };
      }
      const e = es[k];
      const done = h.undone_by || (h.undone_items && h.undone_items[e.i] !== undefined);
      if (done) { skipped.already_undone += 1; pending += 1; continue; }
      entries.push({ ...e, rid: r.receiptId, rowId: r.id, skipBefore: pending });
      pending = 0;
    }
  }
  skipped.tail = pending;
  return { entries, cursor: null, exhausted: true, skipped };
}

const settings = (strapi) => {
  const d = { chunkSize: 25, maxChunkSize: 100, timeBudgetMs: 20000, chunkTimeMs: 0 };
  try { return { ...d, ...require('../_bulk/util').settings(strapi).bulk }; } catch { return d; }
};
const chunkOf = (cfg, a) => Math.max(1, Math.min(a.chunk_size ?? cfg.chunkSize, cfg.maxChunkSize));

/** Receipt rows of a job (or one receipt) as the walk reads them: history views, expired and stripped entries marked. */
function rowView(r) {
  const h = C.histOf(r) || { e: [] };
  const expired = C.expired(r);
  // a receipt-level too-large mark (rc.2 and before stream F: every before-image dropped) makes EVERY entry not
  // undoable, creates too (review L4): the inline undo refused the whole receipt, and so does the job
  const e = (h.e || []).map((x) => ({ ...x, ...(expired ? { expired: true } : {}), ...(h.t && !x.t ? { t: 1 } : {}) }));
  return { id: r.id, receiptId: r.receiptId, history: { ...h, e } };
}
const rowsWhere = (job) => (job.single ? { receiptId: job.receipt_id } : { receiptId: { $startsWith: `${job.receipt_id}~` } });

/** The next entries from the job's cursor: row ids first, then one receipt row at a time (review M7). */
async function gather(strapi, job, n) {
  const q = strapi.db.query(RECEIPT_UID);
  let cursor = job.cursor || null;
  const entries = [];
  let already = 0;
  let pending = 0;
  for (let page = 0; page < 50; page += 1) {
    const where = { ...rowsWhere(job), ...(cursor ? { id: { $lte: cursor.row } } : {}) };
    const ids = (await q.findMany({ where, select: ['id'], orderBy: { id: 'desc' }, limit: 50 })).map((r) => r.id);
    for (const id of ids) {
      const row = await q.findOne({ where: { id }, select: ['id', 'receiptId', 'moduleData', 'createdAt'] });
      if (!row) continue;
      const r = nextEntries([rowView(row)], cursor, n - entries.length, pending);
      entries.push(...r.entries);
      already += r.skipped.already_undone;
      if (!r.exhausted) return { entries, cursor: r.cursor, exhausted: false, tail: r.skipped.tail, already };
      pending = r.skipped.tail;
      cursor = { row: id, i: -1 };
    }
    if (ids.length < 50) return { entries, cursor: null, exhausted: true, tail: pending, already };
  }
  return { entries, cursor, exhausted: false, tail: pending, already };
}

/** Entries, before-image bytes and stripped entries of a job: from its stats row, or by reading its receipts. */
async function sizeOf(strapi, job) {
  if (!job.single) {
    const st = await C.readStat(strapi, job.receipt_id);
    if (st) return { entries: st.entries, bytes: st.bytes, stripped: st.stripped };
  }
  const q = strapi.db.query(RECEIPT_UID);
  const out = { entries: 0, bytes: 0, stripped: 0 };
  let last = null;
  for (let page = 0; page < 250; page += 1) {
    const rows = await q.findMany({ where: { ...rowsWhere(job), ...(last ? { id: { $gt: last } } : {}) }, select: ['id', 'receiptId', 'moduleData', 'createdAt'], orderBy: { id: 'asc' }, limit: 20 });
    for (const r of rows.map(rowView)) {
      out.entries += r.history.e.length;
      out.stripped += r.history.e.filter((e) => e.t).length;
      out.bytes += r.history.bytes ?? r.history.e.filter((e) => C.hasBefore(e) && !e.t).reduce((x, e) => x + Buffer.byteLength(JSON.stringify(e)), 0);
    }
    if (rows.length < 20) return out;
    last = rows[rows.length - 1].id;
  }
  return { ...out, partial: true };
}

/** 'job' or 'inline': a single receipt stays inline up to INLINE_MAX (the ws_batch maximum) and under "stop" (M3). */
const INLINE_MAX = 100;
async function route(strapi, a) {
  if (a.undo_job_id) return 'job';
  if (a.item !== undefined || a.documentId !== undefined) return 'inline';
  const q = strapi.db.query(RECEIPT_UID);
  const one = await q.findOne({ where: { receiptId: a.receipt_id }, select: ['id', 'moduleData'] });
  if (one) {
    if (a.on_conflict === 'stop') return 'inline';
    const h = C.histOf(one);
    return h && Array.isArray(h.e) && h.e.length > INLINE_MAX ? 'job' : 'inline';
  }
  const n = await q.count({ where: { receiptId: { $startsWith: `${a.receipt_id}~` } } });
  return n ? 'job' : 'inline';
}

/** The owner: a per-token identity and the unique index, as bulk jobs need, or a clear refusal (review L8). */
function callerId(E, ctx, extra) {
  try {
    E.requireUniqueIndex();
    return E.tokenScope(ctx, extra);
  } catch (e) {
    throw new E.WsError({
      code: 'unsupported', retryable: false, requires_reread: false,
      message: `Undoing a job (or a receipt with more than ${INLINE_MAX} entries) runs as an undo job, which needs a per-token identity (the request's Authorization header, as the plugin sees it) and the receipts table's unique index. ${(e && e.payload && e.payload.message) || ''} Undo single documents with documentId instead. Nothing was undone.`,
    });
  }
}

/** Status of an unfinished bulk or undo job the id names, else null (review M6: its undo would miss chunks). */
async function sourceStatus(strapi, id) {
  // the job tables' states (item 18): running, paused and stopped jobs are active; done and cancelled are not
  return id ? S.activeState(strapi, id) : null;
}
const where = (e) => ({ uid: e.uid, documentId: e.documentId, locale: e.locale || null, item: e.ref ?? e.i });
/** An item's error as an undo job stores and returns it (review L7): code, message, field, details; never driver text. */
const storedError = (p) => { const o = { code: p.code, message: p.message }; for (const k of ['field', 'details']) if (p[k] !== undefined) o[k] = p[k]; return o; };
/** A conflict as an undo job returns it: without `current` (status_only and ws_get show it), so replies stay small (M7). */
const lean = (c) => { const { current, current_rows, current_version, retry, ...rest } = c || {}; return rest; };
const itemFail = (E, info) => { const err = new E.WsError({ code: 'item_failed', message: (info.error && info.error.message) || 'item failed' }); err.itemFail = info; return err; };

/** One chunk: ONE transaction (run by runChunk through runWrite, so the history module records its receipt). */
async function chunkTx(strapi, ctx, E, jobId, owner, exclude, stopAt) {
  const job = await S.lock(strapi, jobId);
  if (!job || job.owner !== owner) throw new E.WsError({ code: 'not_found', message: `No undo job ${jobId} for this token.`, undo_job_id: jobId });
  if (job.status !== 'running') return { job, idle: true, rec: null };
  const at = JSON.stringify(job.cursor || null);
  // a failure seen in an earlier attempt belongs to the chunk that started at that cursor
  if (exclude.at !== at) { exclude.clear(); exclude.at = at; }
  if (stopAt && stopAt.at !== at) stopAt = null;
  const g = await gather(strapi, job, job.chunk_size);
  C.annotate({ group: jobId, undo_of: job.receipt_id, ...(job.agent ? { agent: job.agent } : {}) });
  const cfg = settings(strapi);
  const actionable = g.entries.filter((e) => !NOT_UNDOABLE.includes(e.op) && !e.t && !e.expired);
  await U.lockTargets(strapi, E, actionable);
  const rec = { items: [], conflicts: [], skipped: [], failed: [], unreadable: 0 };
  const full = []; // this call's conflict payloads (current, before): returned, never stored
  const done = [];
  const totals = {};
  const add = (k, n = 1) => { totals[k] = (totals[k] || 0) + n; };
  let cut = null;
  let stop = null;
  const t0 = Date.now();
  for (const [k, e] of g.entries.entries()) {
    const ek = `${e.rid}:${e.i}`;
    if (stopAt && stopAt.key === ek) { cut = k; stop = { failed: { ...where(e), error: stopAt.error } }; break; }
    // time cap (phase 2 B, chunkTimeMs): other writers of these documents wait for this commit
    if (cfg.chunkTimeMs > 0 && k > 0 && Date.now() - t0 >= cfg.chunkTimeMs) { cut = k; break; }
    if (exclude.has(ek)) { rec.failed.push({ ...where(e), rid: e.rid, i: e.i, error: exclude.get(ek) }); add('failed'); continue; }
    const actionableEntry = !NOT_UNDOABLE.includes(e.op) && !e.t && !e.expired;
    // every entry is checked before it is named, also the ones only skipped (review M2); unreadable ones are counted
    const raw = actionableEntry ? await U.readDraft(strapi, E, e) : (e.op === 'import' ? null : await U.readPlain(strapi, E, e));
    if (!(await U.entryVisible(strapi, ctx, E, e, raw))) { rec.unreadable += 1; add('unreadable'); continue; }
    let r;
    try {
      r = await U.revertOne(strapi, ctx, E, e, { force: job.force, args: {}, ...(actionableEntry ? { raw } : {}) });
    } catch (err) {
      if (err && err.itemFail) throw err;
      throw itemFail(E, { key: ek, at, error: storedError(E.mapStrapiError(err).payload) });
    }
    if (r.kind === 'item') {
      rec.items.push({ ...r.value, rid: e.rid, i: e.i });
      done.push(e);
      add({ restored: 'restored', unchanged: 'unchanged', deleted: 'deleted', recreated: 'recreated', already_gone: 'already_gone' }[r.value.op] || 'restored');
    } else if (r.kind === 'conflict') {
      if (job.on_conflict === 'stop') { cut = k; stop = { conflict: { ...where(e), rid: e.rid, i: e.i, changed_since: r.value.changed_since }, payload: lean(r.value) }; break; }
      rec.conflicts.push({ ...where(e), rid: e.rid, i: e.i, changed_since: r.value.changed_since });
      full.push(lean(r.value));
      add('conflicts');
    } else {
      rec.skipped.push({ ...r.value, rid: e.rid, i: e.i });
      add(r.value.reason === 'too_large' ? 'too_large' : r.value.reason === 'expired' ? 'expired' : 'not_undoable');
    }
  }
  // the cursor: where the next chunk starts (at the entry where this one was cut, or after the last one walked)
  const walked = cut === null ? g.entries : g.entries.slice(0, cut);
  const alreadyWalked = walked.reduce((x, e) => x + (e.skipBefore || 0), 0) + (cut === null ? g.tail : 0) + (cut !== null ? g.entries[cut].skipBefore || 0 : 0);
  add('already_undone', alreadyWalked);
  job.processed = (job.processed || 0) + walked.length + alreadyWalked;
  if (cut !== null) {
    const e = g.entries[cut];
    job.cursor = { row: e.rowId, i: e.i };
  } else job.cursor = g.cursor;
  for (const [k, n] of Object.entries(totals)) if (n) job.totals[k] = (job.totals[k] || 0) + n;
  if (stop) {
    job.status = 'stopped';
    job.stopped = stop.conflict ? { conflict: stop.conflict } : { failed: stop.failed };
  } else if (cut === null && g.exhausted) {
    job.status = 'done';
    job.cursor = null; // done: the slot is released by the save (toRow)
  } else job.status = 'running';
  job.chunks += 1;
  job.updated_at = new Date().toISOString();
  // the reverted entries, item by item, on their receipts (the rest of each receipt stays undoable)
  if (done.length) {
    const byRid = new Map();
    for (const e of done) (byRid.get(e.rid) || byRid.set(e.rid, []).get(e.rid)).push(e.i);
    C.annotate({ undo_rows: [...byRid].map(([id, items]) => ({ id, items })) });
  }
  await S.addChunk(strapi, job, job.chunks, rec);
  await S.save(strapi, job);
  return { job, rec, full, stopPayload: stop && stop.payload };
}

async function runChunk(strapi, ctx, E, extra, jobId, owner) {
  const exclude = new Map();
  let stopAt = null;
  for (let round = 0; round < 200; round += 1) {
    try {
      return await E.runWrite(strapi, ctx, 'ws_undo', {}, () => chunkTx(strapi, ctx, E, jobId, owner, exclude, stopAt), extra);
    } catch (e) {
      if (!(e && e.itemFail)) throw e;
      // a failing entry (Strapi refused the write): the chunk is run again without it (skip) or up to it (stop)
      const job = await S.load(strapi, jobId);
      if (job && job.on_conflict === 'stop') stopAt = e.itemFail;
      else { if (exclude.at !== e.itemFail.at) { exclude.clear(); exclude.at = e.itemFail.at; } exclude.set(e.itemFail.key, e.itemFail.error); }
    }
  }
  throw new E.WsError({ code: 'write_failed', message: 'An undo chunk could not be completed.' });
}

function view(job, acc, extra = {}) {
  const totals = Object.fromEntries(TOTALS.map((k) => [k, (job.totals || {})[k] || 0]));
  const r = {
    ok: job.status !== 'stopped', undo_job_id: job.job_id, undo_of: job.receipt_id, status: job.status, on_conflict: job.on_conflict,
    total: job.total ?? null, processed: job.processed || 0, remaining: job.total == null ? null : Math.max(0, job.total - (job.processed || 0)),
    totals, chunks_done: job.chunks, items: acc.items,
  };
  if (acc.items_dropped) r.items_note = `${acc.items_dropped} more items of this call left out; ws_history with receipt_id ${job.job_id} lists every reverted entry.`;
  if (acc.conflicts.length) { r.conflicts = acc.conflicts; r.conflicts_hint = HINT_CONFLICTS; }
  if (acc.skipped.length) r.skipped = acc.skipped;
  if (acc.failed.length) r.failed = acc.failed;
  if (job.status === 'running') r.next = { hint: HINT_RUNNING, undo_job_id: job.job_id };
  if (job.status === 'stopped' && job.stopped) {
    r.error = {
      code: 'job_stopped', message: HINT_STOPPED,
      ...(job.stopped.conflict ? { conflict: acc.stopPayload ? { ...acc.stopPayload, ...where(job.stopped.conflict) } : job.stopped.conflict } : {}),
      ...(job.stopped.failed ? { cause: job.stopped.failed.error, documentId: job.stopped.failed.documentId } : {}),
    };
  }
  return { ...r, ...extra };
}

const strip = (x) => { const { rid, i, ...rest } = x; return rest; };

async function run(strapi, ctx, E, extra, jobId, owner, maxChunks, extraView) {
  const cfg = settings(strapi);
  const t0 = Date.now();
  const acc = { items: [], conflicts: [], skipped: [], failed: [], items_dropped: 0, stopPayload: null };
  let job = null;
  for (let n = 0; ; n += 1) {
    if (maxChunks && n >= maxChunks) break;
    if (n > 0 && Date.now() - t0 > cfg.timeBudgetMs) break;
    const r = await runChunk(strapi, ctx, E, extra, jobId, owner);
    job = r.job;
    if (r.rec) {
      for (const it of r.rec.items) { if (acc.items.length < 200) acc.items.push(strip(it)); else acc.items_dropped += 1; }
      for (const c of r.full) if (acc.conflicts.length < 100) acc.conflicts.push(c);
      for (const s of r.rec.skipped) if (acc.skipped.length < 100) acc.skipped.push(strip(s));
      for (const f of r.rec.failed) if (acc.failed.length < 100) acc.failed.push(strip(f));
      if (r.stopPayload) acc.stopPayload = r.stopPayload;
    }
    if (r.idle || job.status !== 'running') break;
  }
  if (!job) job = await S.load(strapi, jobId);
  const t = job.totals || {};
  const did = TOTALS.filter((k) => k !== 'already_undone').reduce((x, k) => x + (t[k] || 0), 0);
  if (job.status === 'done' && !did && t.already_undone) {
    throw new E.WsError({ code: 'already_undone', message: `Every entry of ${job.receipt_id} was already undone. To redo a change, undo the undo that reverted it (ws_history lists it).`, receipt_id: job.receipt_id });
  }
  return view(job, acc, extraView);
}

/** Reopen a stopped job (its next call retries the entry it stopped at). */
async function reopen(strapi, ctx, E, extra, jobId) {
  await E.runWrite(strapi, ctx, 'ws_undo', {}, async () => {
    const j = await S.lock(strapi, jobId);
    if (j && j.status === 'stopped') { j.status = 'running'; j.stopped = undefined; await S.save(strapi, j); }
    return {};
  }, extra);
}

/** A cancelled undo job is not resumed (a new undo of the same receipt starts a new job). */
function resumeCheck(job, E = require('../../engine')) {
  if (job && job.status === 'cancelled') {
    throw new E.WsError({ code: 'job_cancelled', undo_job_id: job.job_id, message: 'This undo job was cancelled: what it reverted stays reverted. Undo the same receipt again to go on (a new undo job).' });
  }
}

const NOTHING = { items: [], conflicts: [], skipped: [], failed: [] };
/** ws_job cancel: under the row lock (a running chunk finishes first); what was reverted stays, the slot is freed. */
async function cancel(strapi, ctx, E, extra, jobId, owner) {
  let job = null;
  let cancelled = false;
  await E.runWrite(strapi, ctx, 'ws_undo', {}, async () => {
    job = await S.lock(strapi, jobId);
    if (!job || job.owner !== owner) throw new E.WsError({ code: 'not_found', message: `No undo job ${jobId} for this token.`, job_id: jobId });
    if (S.ACTIVE.includes(job.status)) {
      job.status = 'cancelled';
      job.stopped = undefined;
      job.updated_at = new Date().toISOString();
      cancelled = true;
      await S.save(strapi, job); // an inactive job holds no slot
    }
    return {};
  }, extra);
  const v = view(job, NOTHING);
  return {
    ...v, cancelled,
    note: cancelled ? 'Cancelled: what it reverted is kept (totals); the rest was not undone.' : `Nothing to cancel: the undo job is ${job.status}.`,
  };
}

/** status_only: the job and every conflict it left, with the before values this token may read. */
async function statusView(strapi, ctx, E, job) {
  const last = new Map(); // an entry retried after a stop has two item rows: its latest state counts
  for await (const it of S.items(strapi, job.job_id)) {
    const x = it.info || {};
    last.set(`${x.rid}:${x.i}`, it.state === 'conflict' ? { ...x, documentId: it.docId } : null);
  }
  const conflicts = [...last.values()].filter(Boolean);
  const out = [];
  // only the entries that conflicted are kept from each receipt row (review M7), one row read at a time
  const wanted = new Map();
  for (const x of conflicts.slice(0, 1000)) (wanted.get(x.rid) || wanted.set(x.rid, new Set()).get(x.rid)).add(x.i);
  const entries = new Map();
  for (const [rid, is] of wanted) {
    const row = await strapi.db.query(RECEIPT_UID).findOne({ where: { receiptId: rid }, select: ['id', 'moduleData'] });
    const h = C.histOf(row);
    for (const i of is) if (h && (h.e || [])[i]) entries.set(`${rid}:${i}`, h.e[i]);
  }
  for (const x of conflicts.slice(0, 1000)) {
    const e = entries.get(`${x.rid}:${x.i}`);
    const names = [...new Set((x.changed_since || []).map((f) => f.replace(/[[(].*$/, '')))].filter(Boolean);
    let before = null;
    if (e && (e.op === 'update' || e.op === 'delete')) {
      // the entry's creator fields, so conditional field permissions apply to the before values (review L5)
      const cur = E.writableUids(strapi).includes(e.uid)
        ? await strapi.db.query(e.uid).findOne({ where: { documentId: e.documentId, ...(e.locale ? { locale: e.locale } : {}) }, populate: M.permQueryPopulate(strapi, e.uid) }) : null;
      const creator = cur ? Object.fromEntries(['createdBy', 'updatedBy'].filter((f) => cur[f]).map((f) => [f, cur[f]])) : {};
      before = await C.visibleBefore(E.permissionChecker(strapi, ctx, e.uid), e, e.op === 'update' ? names : undefined, creator);
    }
    out.push({ ...strip(x), before });
  }
  const v = view(job, { items: [], conflicts: [], skipped: [], failed: [] });
  if (out.length) { v.conflicts = out; v.conflicts_hint = HINT_CONFLICTS; }
  if (conflicts.length > out.length) v.conflicts_note = `${conflicts.length - out.length} more conflicts not listed.`;
  return v;
}

/** Read-only preview of what the next entries would do (no write, no lock). */
async function classify(strapi, ctx, E, e) {
  const w = where(e);
  // checked before anything about the entry is named (review M2)
  const raw = e.op === 'import' ? null : await U.readPlain(strapi, E, e);
  if (!(await U.entryVisible(strapi, ctx, E, e, raw))) return { would: 'unreadable' };
  if (NOT_UNDOABLE.includes(e.op)) return { ...w, op: e.op, would: 'not_undoable' };
  if (e.expired) return { ...w, op: e.op, would: 'expired' };
  if (e.t) return { ...w, op: e.op, would: 'too_large' };
  if (e.op === 'update') {
    if (!raw) return { ...w, op: e.op, would: 'conflict', changed_since: ['(document)'] };
    const cur = M.normalize(strapi, e.uid, raw);
    const ch = U.changedSince(strapi, e, cur);
    if (ch.length) return { ...w, op: e.op, would: 'conflict', changed_since: ch };
    return { ...w, op: e.op, would: Object.keys(U.restoreData(strapi, e, cur)).length ? 'restore' : 'unchanged' };
  }
  if (e.op === 'create') return { ...w, op: e.op, would: raw ? 'delete' : 'already_gone' };
  if (e.op === 'delete') return { ...w, op: e.op, would: raw ? 'conflict' : 'recreate', ...(raw ? { changed_since: ['(document exists again)'] } : {}) };
  return { ...w, op: e.op, would: 'not_undoable' };
}

async function exists(strapi, a) {
  const q = strapi.db.query(RECEIPT_UID);
  if (await q.findOne({ where: { receiptId: a.receipt_id }, select: ['id'] })) return { single: true };
  if (await q.count({ where: { receiptId: { $startsWith: `${a.receipt_id}~` } } })) return { single: false };
  return null;
}

async function dryRun(strapi, ctx, E, a) {
  const ex = await exists(strapi, a);
  if (!ex) throw new E.WsError({ code: 'not_found', message: `No receipt ${a.receipt_id}. ws_history lists receipts.`, receipt_id: a.receipt_id });
  const cfg = settings(strapi);
  const job = { receipt_id: a.receipt_id, single: ex.single, cursor: null };
  const size = await sizeOf(strapi, job);
  const chunk = chunkOf(cfg, a);
  const g = await gather(strapi, job, Math.min(a.preview ?? 5, 20));
  const preview = [];
  for (const e of g.entries) preview.push(await classify(strapi, ctx, E, e));
  const o = C.opts();
  return {
    ok: true, dry_run: true, written: false, job: true, undo_of: a.receipt_id, on_conflict: a.on_conflict || 'skip',
    total: size.entries, bytes: size.bytes, not_undoable: size.stripped, ...(size.partial ? { totals_partial: true } : {}),
    budget: { per_document_bytes: o.maxBeforeBytes, per_job_bytes: o.maxJobBeforeBytes },
    chunk_size: chunk, chunks: Math.ceil(size.entries / chunk), preview,
    hint: `Run the same call without dry_run to start the undo job: ${Math.ceil(size.entries / chunk)} chunks of ${chunk}, newest first, each its own transaction; `
      + `documents changed since are ${(a.on_conflict || 'skip') === 'skip' ? 'left alone and listed' : 'a stop'}.`,
  };
}

/** ws_undo as a job: start or resume (same caller, receipt and mode), undo_job_id, status_only, dry_run. */
async function handle(strapi, ctx, E, a, extra) {
  const owner = callerId(E, ctx, extra);
  await S.ready(strapi, E);
  if (a.undo_job_id) {
    const job = await S.load(strapi, a.undo_job_id);
    if (!job || job.owner !== owner) throw new E.WsError({ code: 'not_found', message: `No undo job ${a.undo_job_id} for this token.`, undo_job_id: a.undo_job_id });
    if (a.status_only) return statusView(strapi, ctx, E, job);
    resumeCheck(job, E);
    if (job.status === 'stopped') await reopen(strapi, ctx, E, extra, job.job_id);
    return run(strapi, ctx, E, extra, job.job_id, owner, a.max_chunks);
  }
  if (a.dry_run) return dryRun(strapi, ctx, E, a);
  const scope = scopeKey(owner, a);
  const active = await S.findActive(strapi, scope);
  if (active && active.owner === owner) {
    if (active.status === 'stopped') await reopen(strapi, ctx, E, extra, active.job_id);
    return run(strapi, ctx, E, extra, active.job_id, owner, a.max_chunks, { resumed: true });
  }
  const ex = await exists(strapi, a);
  if (!ex) throw new E.WsError({ code: 'not_found', message: `No receipt ${a.receipt_id}. ws_history lists receipts.`, receipt_id: a.receipt_id });
  const cfg = settings(strapi);
  const base = { receipt_id: a.receipt_id, single: ex.single, cursor: null };
  const size = await sizeOf(strapi, base);
  const now = new Date().toISOString();
  const job = {
    v: 1, job_id: `u${crypto.randomUUID().replace(/-/g, '').slice(0, 23)}`, owner, ...base, scope,
    on_conflict: a.on_conflict || 'skip', force: Boolean(a.force), chunk_size: chunkOf(cfg, a), status: 'running',
    total: size.entries, processed: 0, totals: {}, chunks: 0, created_at: now, updated_at: now, ...(a.agent ? { agent: String(a.agent).slice(0, 80) } : {}),
  };
  try {
    await E.runWrite(strapi, ctx, 'ws_undo', {}, async () => { await S.create(strapi, job); return {}; }, extra);
  } catch (e) {
    // the same call started at the same moment (the slot is unique): resume that one
    const again = await S.findActive(strapi, scope);
    if (!again) throw e;
    return run(strapi, ctx, E, extra, again.job_id, owner, a.max_chunks, { resumed: true });
  }
  return run(strapi, ctx, E, extra, job.job_id, owner, a.max_chunks);
}

module.exports = {
  handle, route, sourceStatus, nextEntries, scopeKey, gather, sizeOf, rowView, storedError, INLINE_MAX, HINT_RUNNING, HINT_CONFLICTS, HINT_STOPPED,
  statusView, view, cancel, resumeCheck, callerId, TOTALS,
};
