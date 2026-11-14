'use strict';

/**
 * Strapi-table stores for approval requests/decisions (service.js contract) and job leases (runner/lease.js contract).
 * Unique indexes are created by the plugin (Strapi's `unique` is checked by the app only): one decision per admin per
 * request, one lease row per job.
 */
const DB = require('../compat/db');
const { RUNNABLE } = require('../runner/lease');

const REQ = 'plugin::writesafe.approval-request';
const DEC = 'plugin::writesafe.approval-decision';
const LEASE = 'plugin::writesafe.job-lease';

const NUMS = ['nextAttemptAt', 'requestedAt', 'expiresAt', 'approvedAt', 'approvalExpiresAt', 'consumedAt', 'requiredApprovals', 'docCount', 'decidedAt', 'leaseUntil', 'fence', 'heartbeatAt', 'processed', 'errors', 'updatedAtMs'];
function norm(r) {
  if (!r) return null;
  const o = { ...r };
  for (const k of NUMS) if (o[k] != null) o[k] = Number(o[k]);
  if ('docCount' in o) { o.count = o.docCount; delete o.docCount; }
  return o;
}
const toRow = (r) => {
  const o = { ...r };
  if ('count' in o) { o.docCount = o.count; delete o.count; }
  return o;
};
const isDuplicate = (e) => /23505|SQLITE_CONSTRAINT|ER_DUP_ENTRY|UNIQUE constraint|duplicate key/i.test(`${e?.code || ''} ${e?.message || ''} ${e?.cause?.code || ''}`);

/** Unique index on one column of a plugin table (as compat/db.js does for the receipts). */
async function ensureUnique(strapi, uid, attribute) {
  const meta = strapi.db.metadata.get(uid);
  const table = meta.tableName;
  const column = (meta.attributes[attribute] && meta.attributes[attribute].columnName) || attribute;
  try {
    if (await DB.hasUniqueIndex(strapi, table, column)) return true;
  } catch { /* create it */ }
  try {
    await strapi.db.connection.schema.alterTable(table, (t) => t.unique([column], { indexName: `${table}_${column}_uq` }));
    return true;
  } catch (e) {
    if (/already exists|Duplicate key name/i.test(e.message)) return true;
    strapi.log.error(`[writesafe] could not create the unique index on ${table}.${column}: ${e.message}. Approvals and the runner are refused until it exists.`);
    return false;
  }
}

const READY = { ok: null };
async function ensureIndexes(strapi) {
  const a = await ensureUnique(strapi, REQ, 'requestId');
  const b = await ensureUnique(strapi, DEC, 'key');
  const c = await ensureUnique(strapi, LEASE, 'jobId');
  for (const [uid, attr] of [[REQ, 'tokenId'], [REQ, 'status'], [LEASE, 'state']]) await DB.ensureIndex(strapi, uid, attr);
  READY.ok = a && b && c;
  return READY.ok;
}

function approvals(strapi) {
  const q = (uid) => strapi.db.query(uid);
  return {
    async createRequest(row) { await q(REQ).create({ data: toRow(row) }); },
    async getRequest(id) { return norm(await q(REQ).findOne({ where: { requestId: id } })); },
    async findRequests(where) { return (await q(REQ).findMany({ where: toRow(where), orderBy: { id: 'desc' }, limit: 500 })).map(norm); },
    async updateRequest(id, patch, expect) {
      const r = await q(REQ).updateMany({ where: { requestId: id, ...toRow(expect || {}) }, data: toRow(patch) });
      return Number(r && r.count) > 0;
    },
    async createDecision(d) {
      try {
        await q(DEC).create({ data: d });
      } catch (e) {
        if (isDuplicate(e)) { const x = new Error('duplicate decision'); x.duplicate = true; throw x; }
        throw e;
      }
    },
    async listDecisions(id) { return (await q(DEC).findMany({ where: { requestId: id }, orderBy: { id: 'asc' } })).map(norm); },
    /** fn(row) runs in a transaction holding the request row's lock (SQLite: the transaction serialises writers). */
    withRequestLock(id, fn) {
      if (READY.ok === false) throw new Error('approval tables have no unique index');
      return strapi.db.transaction(async () => {
        const locked = await strapi.db.queryBuilder(REQ).select(['id']).where({ requestId: id }).forUpdate().first().execute();
        return fn(locked ? norm(await q(REQ).findOne({ where: { requestId: id } })) : null);
      });
    },
  };
}

function leases(strapi) {
  const q = () => strapi.db.query(LEASE);
  const get = async (jobId) => norm(await q().findOne({ where: { jobId } }));
  const upd = async (where, data) => Number((await q().updateMany({ where, data })).count) > 0;
  return {
    async insert(row) {
      try {
        await q().create({ data: { fence: 0, leaseOwner: null, leaseUntil: 0, events: [], errors: 0, ...row } });
      } catch (e) {
        if (isDuplicate(e)) { const x = new Error('duplicate lease'); x.duplicate = true; throw x; }
        throw e;
      }
    },
    get,
    async list(where = {}) {
      const w = Object.fromEntries(Object.entries(where).map(([k, v]) => [k, Array.isArray(v) ? { $in: v } : v]));
      return (await q().findMany({ where: w, orderBy: { id: 'desc' }, limit: 200 })).map(norm);
    },
    async candidates(now, limit) {
      // back-off after an error (finding 8) in the WHERE (re-review A6): a page of waiting jobs cannot hide runnable ones
      return (await q().findMany({
        where: { state: { $in: RUNNABLE }, $and: [{ $or: [{ leaseOwner: null }, { leaseUntil: { $lt: now } }] }, { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }] },
        orderBy: { id: 'asc' }, limit,
      })).map(norm);
    },
    // compare-and-set on the fence: of several replicas acquiring at once, exactly one UPDATE matches
    async tryAcquire(jobId, worker, now, until) {
      const r = await get(jobId);
      if (!r || !RUNNABLE.includes(r.state) || (r.leaseOwner && r.leaseUntil >= now) || r.nextAttemptAt > now) return null;
      const fence = Number(r.fence || 0);
      const ok = await upd({ jobId, fence, state: { $in: RUNNABLE }, $or: [{ leaseOwner: null }, { leaseUntil: { $lt: now } }] },
        { leaseOwner: worker, leaseUntil: until, fence: fence + 1, heartbeatAt: now, state: 'running' });
      return ok ? { ...r, leaseOwner: worker, leaseUntil: until, fence: fence + 1, state: 'running' } : null;
    },
    // owner and fence, not the clock: an expired lease nobody took over is still this worker's (finding 11)
    renew: (jobId, worker, fence, until, now) => upd({ jobId, leaseOwner: worker, fence }, { leaseUntil: until, heartbeatAt: now }),
    release: (jobId, worker, fence, patch) => upd({ jobId, leaseOwner: worker, fence }, { ...patch, leaseOwner: null, leaseUntil: 0 }),
    update: (jobId, patch, expect) => upd({ jobId, ...Object.fromEntries(Object.entries(expect || {}).map(([k, v]) => [k, Array.isArray(v) ? { $in: v } : v])) }, patch),
    /** Inside the chunk's transaction: a locking read, so no other worker can take the lease until this chunk commits. */
    async assertHeld(jobId, worker, fence) {
      const row = await strapi.db.queryBuilder(LEASE).select(['id', 'leaseOwner', 'fence']).where({ jobId }).forUpdate().first().execute();
      return Boolean(row && row.leaseOwner === worker && Number(row.fence) === fence);
    },
    async event(jobId, ev, keep) {
      const r = await get(jobId);
      if (!r) return;
      await q().update({ where: { jobId }, data: { events: [...(Array.isArray(r.events) ? r.events : []), ev].slice(-keep) } });
    },
  };
}

module.exports = { approvals, leases, ensureIndexes, READY, REQ, DEC, LEASE, norm };
