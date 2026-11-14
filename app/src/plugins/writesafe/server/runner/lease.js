'use strict';

/**
 * Job leases for the in-Strapi runner (1.0 hardening, Phase 4 stream G).
 *
 * One lease row per job the runner owns (table writesafe_job_leases). A worker may run chunks of a job only while it
 * holds the lease: leaseOwner = its worker id, leaseUntil in the future, and the fence it got when it acquired.
 *  - acquire: one conditional UPDATE (no owner, or the lease has expired) that also increments `fence`; the database
 *    decides which of several replicas wins.
 *  - renew (heartbeat): the same row, only while owner and fence still match. An expired lease nobody took over is
 *    still the worker's: the fence, not the clock, says who holds it (review finding 11).
 *  - check: called inside every chunk's transaction (after the job row is locked): owner and fence must still match,
 *    so a worker whose lease was taken over (a long GC pause, a frozen container) writes nothing: its chunk rolls back.
 *    The check is a locking read of the lease row (on MySQL a plain read there would fix the snapshot before the
 *    document rows are locked), so a heartbeat waits for the running chunk; since expiry alone never takes a lease
 *    away from its owner, a chunk longer than the heartbeat costs nothing but a delayed renew. Others can take the
 *    lease only after leaseMs without any renew, so a chunk must stay well under leaseMs: the runner does not start when
 *    leaseMs is below 3 x the chunk time cap (bulk.chunkTimeMs from stream B, taken as 1 s until then; control.js).
 * A crashed worker simply stops renewing; after leaseMs another worker (or the restarted process) acquires the lease
 * with a higher fence and resumes from the job's last committed cursor.
 *
 * Times are epoch milliseconds from the worker's clock: replicas need synchronised clocks (NTP); leaseMs (60 s by
 * default) is the tolerance.
 *
 * Store contract (SQL: ./store.js; memory: below):
 *   insert(row), get(jobId), list(where), candidates(now, limit) -> rows runnable now,
 *   tryAcquire(jobId, worker, now, until) -> row | null (not before nextAttemptAt), renew(jobId, worker, fence, until, now) -> bool,
 *   release(jobId, worker, fence, patch) -> bool, update(jobId, patch, expect) -> bool, assertHeld(jobId, worker, fence) -> bool
 */
const RUNNABLE = ['queued', 'running'];

class LeaseLost extends Error {
  constructor(jobId) {
    super(`lease on job ${jobId} lost`);
    this.code = 'lease_lost';
  }
}

function memoryStore() {
  const rows = new Map();
  const pick = (r) => (r ? { ...r } : null);
  return {
    rows,
    async insert(row) {
      if (rows.has(row.jobId)) { const e = new Error('duplicate'); e.duplicate = true; throw e; }
      rows.set(row.jobId, { fence: 0, leaseOwner: null, leaseUntil: 0, events: [], ...row });
    },
    async get(jobId) { return pick(rows.get(jobId)); },
    async list(where = {}) { return [...rows.values()].filter((r) => Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))).map(pick); },
    async candidates(now, limit) {
      return [...rows.values()].filter((r) => RUNNABLE.includes(r.state) && (!r.leaseOwner || r.leaseUntil < now) && !(r.nextAttemptAt > now)).slice(0, limit).map(pick);
    },
    async tryAcquire(jobId, worker, now, until) {
      const r = rows.get(jobId);
      if (!r || !RUNNABLE.includes(r.state) || (r.leaseOwner && r.leaseUntil >= now) || r.nextAttemptAt > now) return null;
      Object.assign(r, { leaseOwner: worker, leaseUntil: until, fence: r.fence + 1, heartbeatAt: now, state: 'running' });
      return pick(r);
    },
    async renew(jobId, worker, fence, until, now) {
      const r = rows.get(jobId);
      if (!r || r.leaseOwner !== worker || r.fence !== fence) return false;
      Object.assign(r, { leaseUntil: until, heartbeatAt: now });
      return true;
    },
    async release(jobId, worker, fence, patch) {
      const r = rows.get(jobId);
      if (!r || r.leaseOwner !== worker || r.fence !== fence) return false;
      Object.assign(r, { ...patch, leaseOwner: null, leaseUntil: 0 });
      return true;
    },
    async update(jobId, patch, expect) {
      const r = rows.get(jobId);
      if (!r || (expect && !Object.entries(expect).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)))) return false;
      Object.assign(r, patch);
      return true;
    },
    async assertHeld(jobId, worker, fence) {
      const r = rows.get(jobId);
      return Boolean(r && r.leaseOwner === worker && r.fence === fence);
    },
    async event(jobId, ev, keep) {
      const r = rows.get(jobId);
      if (r) r.events = [...(r.events || []), ev].slice(-keep);
    },
  };
}

module.exports = { RUNNABLE, LeaseLost, memoryStore };
