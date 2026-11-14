'use strict';

/**
 * Job leases for the in-Strapi runner (1.0 hardening, Phase 4 stream G).
 * Design notes: docs/internals.md, section "server/runner/lease.js".
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
