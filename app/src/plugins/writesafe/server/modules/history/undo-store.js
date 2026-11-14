'use strict';

/**
 * Undo job state (item 21) in the bulk job tables (item 18, modules/_bulk/store.js). One `writesafe_bulk_jobs` row per
 * undo job (tool ws_undo, action undo): state and counters in its columns, the receipt cursor and totals in `spec` (a
 * fixed-size value). `slot` is "undo|<scope>" while the job is active (running, paused, stopped) and null once done or
 * cancelled: the store's unique slot index allows one active undo job per caller, receipt and mode, so two concurrent
 * starts become one job. One `writesafe_bulk_items` row per undone entry (its outcome; ordinal in undo order), written
 * by the chunk that reverted it. The store's retention removes idle jobs with their items.
 */
const ST = require('../_bulk/store');

const ACTIVE = ST.ACTIVE;
const slotOf = (scope) => (scope ? `undo|${scope}` : null);

function toRow(job) {
  return {
    jobId: job.job_id, owner: job.owner, slot: ACTIVE.includes(job.status) ? slotOf(job.scope) : null, tool: 'ws_undo', action: 'undo',
    mode: job.on_conflict, chunkSize: job.chunk_size, state: job.status, total: job.total || 0, cursor: job.processed || 0, chunks: job.chunks || 0,
    stopped: job.stopped || null, undoable: false, ...(job.agent ? { agent: job.agent } : {}),
    spec: {
      v: 1, receipt_id: job.receipt_id, single: Boolean(job.single), scope: job.scope, force: Boolean(job.force), total: job.total ?? null,
      cursor: job.cursor || null, totals: job.totals || {}, items: job.items || 0, created_at: job.created_at,
    },
  };
}

function fromRow(r) {
  if (!r || r.tool !== 'ws_undo') return null;
  const sp = r.spec || {};
  return {
    row_id: r.id, job_id: r.jobId, owner: r.owner, receipt_id: sp.receipt_id, single: sp.single, scope: sp.scope, force: sp.force,
    on_conflict: r.mode, chunk_size: r.chunkSize, status: r.state, total: sp.total ?? null, processed: r.cursor, totals: sp.totals || {},
    chunks: r.chunks, stopped: r.stopped || undefined, agent: r.agent || undefined, cursor: sp.cursor || null, items: sp.items || 0, created_at: sp.created_at,
  };
}

async function ready(strapi, E) {
  const r = await ST.ensure(strapi);
  if (!r.ok) throw new E.WsError({ code: 'unsupported', message: `Undo jobs are unavailable: the job tables' indexes could not be created (${r.reason || 'unknown'}). Nothing was undone.` });
}

async function create(strapi, job) { await ST.createJob(strapi, toRow(job), []); }
const load = async (strapi, id) => fromRow(await ST.findJob(strapi, id));
const lock = async (strapi, id) => fromRow(await ST.lockJob(strapi, id));
async function save(strapi, job) {
  const row = { id: job.row_id, ...toRow(job) };
  await ST.saveJob(strapi, row, ['slot', 'state', 'total', 'cursor', 'chunks', 'stopped', 'spec']);
}

const STATE_OF = { restored: 'restored', unchanged: 'unchanged', deleted: 'deleted', recreated: 'recreated', already_gone: 'already_gone' };
/** One item row per entry of a chunk's outcome (ordinals continue the job's count; job.items is advanced). */
async function addChunk(strapi, job, n, rec) {
  const rows = [];
  const add = (state, x, info) => rows.push({ jobId: job.job_id, ordinal: (job.items || 0) + rows.length, docId: x.documentId || '-', state, chunk: n, info: { rid: x.rid, i: x.i, uid: x.uid, locale: x.locale || null, item: x.item, ...info } });
  for (const x of rec.items) add(STATE_OF[x.op] || 'restored', x, {});
  for (const x of rec.conflicts) add('conflict', x, { changed_since: x.changed_since });
  for (const x of rec.skipped) add('skipped', x, { reason: x.reason });
  for (const x of rec.failed) add('failed', x, { error: x.error });
  for (let i = 0; i < rows.length; i += 200) await strapi.db.query(ST.ITEM_UID).createMany({ data: rows.slice(i, i + 200) });
  job.items = (job.items || 0) + rows.length;
}

/** Every item row of a job, oldest first, page by page (status_only). */
async function* items(strapi, jobId) {
  let after = -1;
  for (;;) {
    const p = await ST.pageItems(strapi, jobId, { after, limit: 500 });
    for (const r of p.rows) yield { ...r, info: typeof r.info === 'string' ? JSON.parse(r.info) : r.info };
    if (p.next === null) return;
    after = p.next;
  }
}

const findActive = async (strapi, scope) => fromRow(await ST.activeJob(strapi, slotOf(scope)));

/** The state of the job (bulk or undo) an id names, when it is still active, else null (review M6). */
async function activeState(strapi, id) {
  const j = await ST.findJob(strapi, id);
  return j && ACTIVE.includes(j.state) ? j.state : null;
}

module.exports = { ready, create, load, lock, save, addChunk, items, findActive, activeState, toRow, fromRow, slotOf };
