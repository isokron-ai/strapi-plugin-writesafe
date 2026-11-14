'use strict';

/**
 * The job store of ws_bulk and ws_replace (1.0 hardening item 18): two plugin tables, written once per job and then
 * per chunk, never as one growing JSON value.
 * Design notes: docs/internals.md, section "server/modules/_bulk/store.js".
 */
const JOB_UID = 'plugin::writesafe.bulk-job';
const ITEM_UID = 'plugin::writesafe.bulk-item';

const hidden = { 'content-manager': { visible: false }, 'content-type-builder': { visible: false } };
const contentTypes = {
  'bulk-job': {
    schema: {
      kind: 'collectionType',
      collectionName: 'writesafe_bulk_jobs',
      info: { singularName: 'bulk-job', pluralName: 'bulk-jobs', displayName: 'Write-safe bulk job' },
      options: { draftAndPublish: false },
      pluginOptions: hidden,
      attributes: {
        jobId: { type: 'string', required: true },
        owner: { type: 'string', required: true },
        slot: { type: 'string' },
        tool: { type: 'string' },
        contentType: { type: 'string' },
        targetLocale: { type: 'string' },
        action: { type: 'string' },
        spec: { type: 'json' },
        qfilters: { type: 'json' },
        mode: { type: 'string' },
        chunkSize: { type: 'integer' },
        state: { type: 'string' },
        total: { type: 'integer' },
        cursor: { type: 'integer' },
        chunks: { type: 'integer' },
        nOk: { type: 'integer' },
        nUnchanged: { type: 'integer' },
        nSkipped: { type: 'integer' },
        nFailed: { type: 'integer' },
        nConflict: { type: 'integer' },
        nPublished: { type: 'integer' },
        nPublishSkipped: { type: 'integer' },
        stopped: { type: 'json' },
        paused: { type: 'json' },
        reconcile: { type: 'json' },
        undoable: { type: 'boolean' },
        idHash: { type: 'string' },
        agent: { type: 'string' },
        // [stream G] the approval request a job waits for or ran under, and whether the in-Strapi runner runs it
        approval: { type: 'json' },
        runner: { type: 'boolean' },
      },
    },
  },
  'bulk-item': {
    schema: {
      kind: 'collectionType',
      collectionName: 'writesafe_bulk_items',
      info: { singularName: 'bulk-item', pluralName: 'bulk-items', displayName: 'Write-safe bulk job item' },
      options: { draftAndPublish: false },
      pluginOptions: hidden,
      attributes: {
        jobId: { type: 'string', required: true },
        ordinal: { type: 'integer', required: true },
        docId: { type: 'string', required: true },
        planVersion: { type: 'string' },
        state: { type: 'string' },
        chunk: { type: 'integer' },
        info: { type: 'json' },
      },
    },
  },
};

const COUNTERS = { ok: 'nOk', unchanged: 'nUnchanged', skipped: 'nSkipped', failed: 'nFailed', conflict: 'nConflict' };
const PUBLISH_COUNTERS = ['nPublished', 'nPublishSkipped'];
// [stream G] a job waiting for approval holds its slot too: the token cannot start a second job on the type meanwhile
const ACTIVE = ['running', 'paused', 'stopped', 'awaiting_approval'];
const INSERT_BATCH = 200;

const isSqlite = (strapi) => /sqlite/i.test(String(strapi.db?.config?.connection?.client || strapi.db?.dialect?.client || ''));

// ---------------------------------------------------------------- indexes

let ready = null;
let readyState = { ok: null, reason: null };

async function makeIndex(strapi, uid, attrs, unique, suffix) {
  const meta = strapi.db.metadata.get(uid);
  const table = meta.tableName;
  const cols = attrs.map((a) => (meta.attributes[a] && meta.attributes[a].columnName) || a);
  const name = `${table}_${suffix}`;
  try {
    await strapi.db.connection.schema.alterTable(table, (t) => (unique ? t.unique(cols, { indexName: name }) : t.index(cols, name)));
    strapi.log.info(`[writesafe] created ${unique ? 'unique ' : ''}index ${name}`);
  } catch (e) {
    if (!/already exists|Duplicate key name/i.test(e.message)) throw e;
  }
}

/** Create the store's indexes once (memoized; a failure is retried on the next call). Returns { ok, reason }. */
function ensure(strapi) {
  if (!ready) {
    ready = (async () => {
      try {
        await makeIndex(strapi, JOB_UID, ['jobId'], true, 'job_uq');
        await makeIndex(strapi, JOB_UID, ['slot'], true, 'slot_uq');
        await makeIndex(strapi, JOB_UID, ['updatedAt'], false, 'upd_ix');
        await makeIndex(strapi, JOB_UID, ['owner'], false, 'owner_ix');
        await makeIndex(strapi, ITEM_UID, ['jobId', 'ordinal'], true, 'ord_uq');
        await makeIndex(strapi, ITEM_UID, ['jobId', 'state'], false, 'state_ix');
        readyState = { ok: true, reason: null };
      } catch (e) {
        readyState = { ok: false, reason: e.message };
        strapi.log.error(`[writesafe] bulk job store indexes could not be created (${e.message}): bulk jobs are refused until they exist`);
        ready = null;
      }
      return readyState;
    })();
  }
  return ready;
}

// ---------------------------------------------------------------- jobs

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const JSON_FIELDS = ['spec', 'qfilters', 'stopped', 'paused', 'reconcile', 'approval'];
function rowToJob(row) {
  if (!row) return null;
  const j = { ...row };
  for (const k of JSON_FIELDS) j[k] = j[k] == null ? null : parse(j[k]);
  for (const k of ['total', 'cursor', 'chunks', 'chunkSize', ...Object.values(COUNTERS), ...PUBLISH_COUNTERS]) j[k] = Number(j[k] || 0);
  j.undoable = Boolean(j.undoable);
  j.runner = Boolean(j.runner);
  return j;
}

const findJob = async (strapi, jobId) => rowToJob(await strapi.db.query(JOB_UID).findOne({ where: { jobId } }));

/**
 * The job row read with a locking read (latest committed values; others wait until this transaction ends). The row
 * comes from the locking read itself: on MySQL (REPEATABLE READ) a plain read here would fix the transaction's snapshot
 * before the chunk locks its documents, and their reads would then be stale (engine.lockAndRead's STALE_SNAPSHOT).
 */
async function lockJob(strapi, jobId) {
  let q = strapi.db.queryBuilder(JOB_UID).select('*').where({ jobId });
  if (!isSqlite(strapi)) q = q.forUpdate();
  return rowToJob(await q.first().execute());
}

/** The active job (running, paused or stopped) of a slot, or null. */
const activeJob = async (strapi, slot) => rowToJob(await strapi.db.query(JOB_UID).findOne({ where: { slot } }));

/**
 * Insert a job and its id snapshot (inside the caller's transaction). entries: [{ documentId, version? }] in job order.
 * Items go in batches of 200 rows (one statement each).
 */
async function createJob(strapi, job, entries) {
  const data = {};
  for (const k of Object.keys(contentTypes['bulk-job'].schema.attributes)) if (job[k] !== undefined) data[k] = job[k];
  await strapi.db.query(JOB_UID).create({ data });
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    const rows = entries.slice(i, i + INSERT_BATCH).map((e, k) => ({
      jobId: job.jobId, ordinal: i + k, docId: e.documentId, planVersion: e.version || null, state: 'pending',
    }));
    await strapi.db.query(ITEM_UID).createMany({ data: rows });
  }
}

/** Write the job row's changed fields (by id). */
async function saveJob(strapi, job, fields) {
  const data = {};
  for (const k of fields) data[k] = job[k] === undefined ? null : job[k];
  await strapi.db.query(JOB_UID).update({ where: { id: job.id }, data });
}

/** The next n items from the cursor, in job order (a locking read, for the same reason as lockJob). */
async function nextItems(strapi, jobId, cursor, n) {
  let q = strapi.db.queryBuilder(ITEM_UID).select(['id', 'ordinal', 'docId', 'planVersion', 'state'])
    .where({ jobId, ordinal: { $gte: cursor } }).orderBy({ ordinal: 'asc' }).limit(n);
  if (!isSqlite(strapi)) q = q.forUpdate();
  return q.execute();
}

/** A stopped job's failing document back to pending (the resume retries it). */
async function resetItem(strapi, jobId, docId) {
  await strapi.db.query(ITEM_UID).updateMany({ where: { jobId, docId, state: 'failed' }, data: { state: 'pending', info: null } });
}

async function setItem(strapi, id, state, chunk, info) {
  await strapi.db.query(ITEM_UID).update({ where: { id }, data: { state, chunk, info: info || null } });
}

/**
 * A page of a job's items after an ordinal, for status views. states: null (every item) or a list of states.
 * Reads at most `limit` + 1 rows (rc.2's status read up to 5,000 chunk receipts and returned every item; item 23).
 */
async function pageItems(strapi, jobId, { after = -1, states = null, limit = 200 } = {}) {
  const where = { jobId, ordinal: { $gt: after }, ...(states ? { state: { $in: states } } : {}) };
  const rows = await strapi.db.query(ITEM_UID).findMany({ where, orderBy: { ordinal: 'asc' }, limit: limit + 1, select: ['ordinal', 'docId', 'state', 'chunk', 'info'] });
  const more = rows.length > limit;
  return { rows: more ? rows.slice(0, limit) : rows, next: more ? rows[limit - 1].ordinal : null };
}

/** Which of these documentIds are items of the job. */
async function members(strapi, jobId, documentIds) {
  if (!documentIds.length) return new Set();
  const rows = await strapi.db.query(ITEM_UID).findMany({ where: { jobId, docId: { $in: documentIds } }, select: ['docId'] });
  return new Set(rows.map((r) => r.docId));
}

/**
 * The retention cutoff for jobs (review of PR #16, L2): never younger than a plan token's life (plus a minute), or a
 * job pruned while its token is still valid could be started a second time by the same start.
 */
function jobCutoff(jobHours, planTtlSeconds, now = Date.now()) {
  return new Date(now - Math.max(jobHours * 3600000, (planTtlSeconds + 60) * 1000));
}

/**
 * Retention (server/retention.js): jobs without activity since `cutoff` (done or not) go with their items, the job row
 * and its items in ONE transaction (L2: a crash between them left orphan items). The updatedAt condition is checked again
 * by the delete itself: a job resumed meanwhile holds its row lock and moved it.
 */
// [stream G] paged by id with a cursor kept between passes (third review B6), and asking `decide` per job
let pruneCursor = 0;
async function prune(strapi, cutoff, limit = 200, { decide = null, linked = null } = {}) {
  const out = { jobs: 0, items: 0, ...(decide ? { kept: 0 } : {}) };
  for (let page = 0; page < 20; page += 1) {
    const jobs = await strapi.db.query(JOB_UID).findMany({ where: { updatedAt: { $lt: cutoff }, id: { $gt: pruneCursor } }, orderBy: { id: 'asc' }, limit });
    if (!jobs.length) { pruneCursor = 0; break; }
    pruneCursor = jobs[jobs.length - 1].id;
    for (const row of jobs) {
      const j = rowToJob(row);
      // stream G: a job waiting for approval, paused or run by the runner goes only with its request and lease
      const verdict = decide ? await decide(j) : { act: 'prune' };
      if (verdict.act === 'keep') { out.kept += 1; continue; }
      await strapi.db.transaction(async () => {
        const d = await strapi.db.query(JOB_UID).deleteMany({ where: { id: j.id, updatedAt: { $lt: cutoff } } });
        if (!d || !d.count) return;
        out.jobs += 1;
        const i = await strapi.db.query(ITEM_UID).deleteMany({ where: { jobId: j.jobId } });
        out.items += (i && i.count) || 0;
        if (verdict.act === 'prune_linked' && linked) await linked(j, verdict);
      });
    }
    if (jobs.length < limit) { pruneCursor = 0; break; }
  }
  return out;
}
const resetPruneCursor = () => { pruneCursor = 0; };

module.exports = {
  JOB_UID, ITEM_UID, contentTypes, COUNTERS, PUBLISH_COUNTERS, ACTIVE, ensure, state: () => readyState, findJob, lockJob, activeJob, createJob, saveJob,
  nextItems, setItem, resetItem, pageItems, members, prune, resetPruneCursor, jobCutoff, rowToJob, isSqlite,
  _reset: () => { ready = null; readyState = { ok: null, reason: null }; },
};
