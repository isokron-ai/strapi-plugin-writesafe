'use strict';

/**
 * The in-Strapi job runner (1.0 hardening, Phase 4 stream G). Off by default (config writesafe.runner.enabled).
 *
 * It runs approved bulk jobs in the background, chunk by chunk, with the same engine the agent's own `ws_bulk
 * {job_id}` calls use (adapter.js). Caller-driven resume keeps working whether the runner is on or off.
 *
 * Every chunk:
 *  1. the kill switch is read (an admin's "stop all jobs", or config): set, the worker takes no chunk;
 *  2. the lease is renewed (heartbeat); a worker that lost it stops;
 *  3. the permissions of the token that asked for the job are rebuilt from the token itself (never a superuser, never
 *     the approver's): a revoked or expired token, a deactivated owner, or any change to the token's rules on the
 *     job's content type pauses the job with `permission_changed`;
 *  4. the chunk runs with that token's ability, inside one transaction that first checks the lease is still held (the
 *     fence), so a worker that was taken over writes nothing;
 *  5. pacing: chunkPauseMs between chunks, so admin saves and other writers get the rows in between (the per-chunk
 *     time cap is the bulk engine's own, from stream B).
 * After a crash the lease expires (leaseMs) and any worker resumes from the job's last committed cursor.
 */
const crypto = require('crypto');
const { LeaseLost } = require('./lease');

const HARD = Object.freeze({ workersMax: 4, leaseMsMin: 1000, leaseMsMax: 600000, pollMsMin: 100, pollMsMax: 60000, chunkPauseMsMax: 60000, errorsBeforeFail: 5 });
const DEFAULTS = Object.freeze({ enabled: false, workers: 1, pollMs: 2000, leaseMs: 60000, heartbeatMs: 15000, chunkPauseMs: 250, killSwitch: false });

const isInt = (v) => Number.isSafeInteger(v);
function settings(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const bad = (m) => { throw new Error(`writesafe.runner.${m}`); };
  if (typeof c.enabled !== 'boolean') bad('enabled must be a boolean');
  if (typeof c.killSwitch !== 'boolean') bad('killSwitch must be a boolean');
  if (!isInt(c.workers) || c.workers < 1 || c.workers > HARD.workersMax) bad(`workers must be from 1 to ${HARD.workersMax}`);
  if (!isInt(c.leaseMs) || c.leaseMs < HARD.leaseMsMin || c.leaseMs > HARD.leaseMsMax) bad(`leaseMs must be from ${HARD.leaseMsMin} to ${HARD.leaseMsMax}`);
  if (!isInt(c.heartbeatMs) || c.heartbeatMs < 0 || (c.heartbeatMs && c.heartbeatMs * 2 > c.leaseMs)) bad('heartbeatMs must be 0 (off) or at most half of leaseMs');
  if (!isInt(c.pollMs) || c.pollMs < HARD.pollMsMin || c.pollMs > HARD.pollMsMax) bad(`pollMs must be from ${HARD.pollMsMin} to ${HARD.pollMsMax}`);
  if (!isInt(c.chunkPauseMs) || c.chunkPauseMs < 0 || c.chunkPauseMs > HARD.chunkPauseMsMax) bad(`chunkPauseMs must be from 0 to ${HARD.chunkPauseMsMax}`);
  return c;
}

const STATE_OF = { done: 'done', stopped: 'stopped', paused: 'paused', cancelled: 'cancelled', rejected: 'cancelled', missing: 'failed' };

/**
 * One worker. deps:
 *   store     lease store (lease.js contract)
 *   adapter   { runOneChunk({ jobId, owner, ctx, token, guard }) -> { job, items, idle, from }, setJobStatus(jobId, to, opts) }
 *   tokens    { check(tokenId, uid) -> { ok, reason, ctx, fingerprint, token } }
 *   killSwitch() -> bool, settings, now(), sleep(ms), workerId, log
 */
function createWorker(deps) {
  const { store, adapter, tokens, settings: s, log = null } = deps;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const killSwitch = deps.killSwitch || (async () => false);
  const workerId = deps.workerId || `w-${crypto.randomBytes(6).toString('hex')}`;
  const held = new Map();
  let stopping = false;

  const ev = (jobId, e) => store.event(jobId, { w: workerId, at: now(), ...e }, 50).catch(() => {});

  async function heartbeat() {
    for (const [jobId, fence] of held) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await store.renew(jobId, workerId, fence, now() + s.leaseMs, now()).catch(() => false))) held.delete(jobId);
    }
  }

  /** Runs one leased job until it is done, paused, stopped, the lease is lost or the worker stops. Returns why it left. */
  async function work(lease) {
    const { jobId, fence } = lease;
    held.set(jobId, fence);
    let errors = Number(lease.errors || 0);
    const leave = (patch) => store.release(jobId, workerId, fence, { ...patch, updatedAtMs: now() });
    try {
      for (;;) {
        if (stopping) { await leave({}); return 'stopping'; }
        if (await killSwitch()) { await leave({}); await ev(jobId, { e: 'kill_switch' }); return 'kill_switch'; }
        if (!held.has(jobId) || !(await store.renew(jobId, workerId, fence, now() + s.leaseMs, now()))) return 'lease_lost';
        const perm = await tokens.check(lease.tokenId, lease.uid);
        if (!perm.ok || perm.fingerprint !== lease.permFingerprint) {
          const detail = perm.ok ? 'rules_changed' : perm.reason;
          await adapter.setJobStatus(jobId, 'paused', { from: ['running'], reason: 'permission_changed', detail });
          await leave({ state: 'paused', reason: 'permission_changed', detail });
          await ev(jobId, { e: 'paused', reason: 'permission_changed', detail });
          return 'paused';
        }
        let r;
        try {
          r = await adapter.runOneChunk({
            jobId, owner: lease.owner, ctx: perm.ctx, token: perm.token,
            // inside the chunk's transaction, after the job row lock: a worker that lost its lease writes nothing
            guard: async () => { if (!(await store.assertHeld(jobId, workerId, fence))) throw new LeaseLost(jobId); },
          });
        } catch (e) {
          const c = e && (e.code || (e.payload && e.payload.code));
          if (c === 'lease_lost') { held.delete(jobId); await ev(jobId, { e: 'lease_lost', f: fence }); return 'lease_lost'; }
          errors += 1;
          const msg = String((e && (e.payload ? e.payload.message : e.message)) || e).slice(0, 500);
          if (log) log.warn(`[writesafe] runner: job ${jobId} chunk failed (${errors}/${HARD.errorsBeforeFail}): ${msg}`);
          if (errors >= HARD.errorsBeforeFail) {
            await adapter.setJobStatus(jobId, 'paused', { from: ['running'], reason: 'runner_errors', detail: msg }).catch(() => {});
            await leave({ state: 'paused', reason: 'runner_errors', detail: msg, errors, lastError: msg });
            return 'paused';
          }
          // back off: 2 s, 4 s, 8 s, 16 s, so a database blip does not use up the tries (review finding 8)
          await leave({ errors, lastError: msg, nextAttemptAt: now() + Math.min(60000, 1000 * 2 ** errors) });
          return 'error';
        }
        errors = 0;
        if (!r.idle) await ev(jobId, { e: 'chunk', f: fence, from: r.from, n: r.items.length });
        const st = r.job && r.job.status;
        if (r.idle || st !== 'running') {
          const state = STATE_OF[st] || (st === 'running' ? 'running' : 'done');
          const reason = st === 'missing' ? 'job_missing' : ((r.job && r.job.pause_reason) || null);
          await leave({ state, reason, errors: 0, processed: r.job && r.job.next != null ? r.job.next : null });
          if (st === 'missing' && log) log.warn(`[writesafe] runner: job ${jobId} no longer exists; its lease ends as failed (job_missing)`);
          await ev(jobId, { e: 'left', state });
          return state;
        }
        await store.update(jobId, { processed: r.job.next, errors: 0, nextAttemptAt: null, updatedAtMs: now() }, { leaseOwner: workerId }).catch(() => {});
        if (s.chunkPauseMs) await sleep(s.chunkPauseMs);
      }
    } finally {
      held.delete(jobId);
    }
  }

  /** Takes and runs every runnable job it can lease. Returns how many it ran. */
  async function tick() {
    if (stopping || (await killSwitch())) return 0;
    const rows = await store.candidates(now(), 5);
    let n = 0;
    for (const row of rows) {
      if (stopping) break;
      const got = await store.tryAcquire(row.jobId, workerId, now(), now() + s.leaseMs);
      if (!got) continue;
      n += 1;
      await ev(row.jobId, { e: 'acquired', f: got.fence });
      await work(got);
    }
    return n;
  }

  let loopP = null;
  let hbTimer = null;
  function start() {
    if (loopP) return;
    stopping = false;
    if (s.heartbeatMs) { hbTimer = setInterval(() => { heartbeat().catch(() => {}); }, s.heartbeatMs); if (hbTimer.unref) hbTimer.unref(); }
    loopP = (async () => {
      while (!stopping) {
        let n = 0;
        try { n = await tick(); } catch (e) { if (log) log.warn(`[writesafe] runner tick failed: ${e.message}`); }
        if (!stopping && !n) await sleep(s.pollMs + Math.floor(Math.random() * s.pollMs * 0.2));
      }
    })();
  }
  async function stop() {
    stopping = true;
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
    const p = loopP;
    loopP = null;
    if (p) await p;
  }

  return { workerId, tick, work, heartbeat, start, stop, held };
}

module.exports = { createWorker, settings, DEFAULTS, HARD, STATE_OF };
