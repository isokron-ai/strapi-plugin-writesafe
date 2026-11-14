'use strict';

// The in-Strapi runner (1.0 hardening, Phase 4 stream G): leases, crash resume, permission re-check per chunk.
// No Strapi needed: the lease store is the memory store (same contract as the SQL store) and the bulk engine is a fake
// that behaves like the real one where it matters: one chunk at a time under the job row lock, the cursor committed
// with the chunk, the guard called inside the chunk's transaction.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../server/runner/lease');
const R = require('../server/runner/runner');

function fakeEngine(total, size) {
  const job = { status: 'running', next: 0, total };
  const writes = new Map(); // documentId -> times written
  const ctxSeen = [];
  let lock = Promise.resolve();
  const hooks = { beforeCommit: null };
  return {
    job, writes, ctxSeen, hooks,
    async runOneChunk({ ctx, guard }) {
      const run = lock.then(async () => {
        if (job.status !== 'running') return { job: { ...job }, items: [], idle: true };
        await guard(job); // inside the transaction, after the job row lock
        const from = job.next;
        const ids = Array.from({ length: Math.min(size, total - from) }, (_, i) => `d${from + i}`);
        if (hooks.beforeCommit) await hooks.beforeCommit(from);
        ctxSeen.push(ctx);
        for (const d of ids) writes.set(d, (writes.get(d) || 0) + 1);
        job.next = from + ids.length;
        if (job.next >= total) job.status = 'done';
        return { job: { ...job }, items: ids.map((d) => ({ documentId: d, status: 'ok' })), from, idle: false };
      });
      lock = run.catch(() => {});
      return run;
    },
    async setJobStatus(id, to, { from, reason }) {
      if (from && !from.includes(job.status)) return false;
      job.status = to;
      job.pause_reason = reason;
      return true;
    },
  };
}

const TOKEN_CTX = { userAbility: { token: 7 }, user: { id: 1 } };
const okTokens = (fp = 'fp1') => ({ calls: 0, fp, ok: true, async check() { this.calls += 1; return this.ok ? { ok: true, fingerprint: this.fp, ctx: TOKEN_CTX, token: { id: '7' } } : { ok: false, reason: this.reason }; } });
const S = (over = {}) => R.settings({ leaseMs: 1000, heartbeatMs: 0, chunkPauseMs: 0, ...over });
const lease = (over = {}) => ({ jobId: 'j1', state: 'queued', tokenId: '7', uid: 'api::page.page', owner: 'o', permFingerprint: 'fp1', ...over });

test('settings: off by default, hard limits enforced', () => {
  assert.strictEqual(R.settings({}).enabled, false);
  assert.throws(() => R.settings({ workers: 9 }), /workers/);
  assert.throws(() => R.settings({ leaseMs: 10 }), /leaseMs/);
  assert.throws(() => R.settings({ leaseMs: 10000, heartbeatMs: 6000 }), /heartbeatMs/);
});

test('a job runs to the end with the token\'s own ability on every chunk (never a superuser)', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const eng = fakeEngine(10, 3);
  const tokens = okTokens();
  const w = R.createWorker({ store, adapter: eng, tokens, settings: S(), workerId: 'A' });
  assert.strictEqual(await w.tick(), 1);
  assert.strictEqual(eng.job.status, 'done');
  assert.strictEqual([...eng.writes.values()].every((n) => n === 1) && eng.writes.size, 10);
  assert.ok(eng.ctxSeen.every((c) => c === TOKEN_CTX));
  assert.strictEqual(tokens.calls, 4); // re-checked before every chunk
  const row = await store.get('j1');
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(row.leaseOwner, null);
});

test('two runners never hold one job at once', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const t = { now: 1000 };
  const a = await store.tryAcquire('j1', 'A', t.now, t.now + 1000);
  const b = await store.tryAcquire('j1', 'B', t.now + 10, t.now + 1010);
  assert.ok(a);
  assert.strictEqual(b, null);
  assert.strictEqual(await store.assertHeld('j1', 'A', a.fence, t.now + 20), true);
  assert.strictEqual(await store.assertHeld('j1', 'B', a.fence, t.now + 20), false);
});

test('two runners racing over one job: every chunk is processed once', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const eng = fakeEngine(40, 3);
  const mk = (id) => R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S({ chunkPauseMs: 1 }), workerId: id });
  const ws = ['A', 'B', 'C'].map(mk);
  await Promise.all(ws.map((w) => w.tick()));
  assert.strictEqual(eng.job.status, 'done');
  assert.strictEqual(eng.writes.size, 40);
  assert.ok([...eng.writes.values()].every((n) => n === 1));
  const events = (await store.get('j1')).events.filter((e) => e.e === 'acquired');
  assert.strictEqual(events.length, 1); // only one of the three got the lease
});

test('a worker whose lease expired mid-chunk and was taken over writes nothing (the fence)', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const clock = { t: 1000 };
  const eng = fakeEngine(9, 3);
  const A = R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S(), workerId: 'A', now: () => clock.t });
  const B = R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S(), workerId: 'B', now: () => clock.t });
  // A takes the lease, then freezes before its first chunk's transaction (a long GC pause)
  const got = await store.tryAcquire('j1', 'A', clock.t, clock.t + 1000);
  let release;
  const frozen = new Promise((r) => { release = r; });
  const realRun = eng.runOneChunk;
  let first = true;
  eng.runOneChunk = async (args) => {
    if (first && args.token && args.guard) { first = false; await frozen; }
    return realRun(args);
  };
  const aRun = A.work(got);
  await new Promise((r) => setImmediate(r));
  clock.t += 2000; // A's lease has expired
  const gotB = await store.tryAcquire('j1', 'B', clock.t, clock.t + 1000); // B takes over (fence 2)
  assert.ok(gotB);
  release(); // A wakes up and tries its chunk: the guard inside the transaction refuses it
  assert.strictEqual(await aRun, 'lease_lost');
  assert.strictEqual(eng.writes.size, 0);
  assert.strictEqual(await B.work(gotB), 'done');
  assert.strictEqual(eng.writes.size, 9);
  assert.ok([...eng.writes.values()].every((n) => n === 1), JSON.stringify([...eng.writes]));
  assert.strictEqual((await store.get('j1')).fence, 2);
});

test('a crashed runner: another one resumes from the last committed chunk after the lease expires', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const clock = { t: 1000 };
  const eng = fakeEngine(12, 3);
  // A crashes after its second chunk: it never releases nor renews
  let chunks = 0;
  eng.hooks.beforeCommit = async () => { chunks += 1; if (chunks === 3) throw Object.assign(new Error('SIGKILL'), { crash: true }); };
  const A = R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S(), workerId: 'A', now: () => clock.t });
  const got = await store.tryAcquire('j1', 'A', clock.t, clock.t + 1000);
  const origRelease = store.release;
  store.release = async () => true; // the dead process releases nothing
  await A.work(got);
  store.release = origRelease;
  assert.strictEqual(eng.job.next, 6);
  eng.hooks.beforeCommit = null;
  const B = R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S(), workerId: 'B', now: () => clock.t });
  assert.strictEqual(await B.tick(), 0); // the lease is still A's
  clock.t += 1500;
  assert.strictEqual(await B.tick(), 1);
  assert.strictEqual(eng.job.status, 'done');
  assert.strictEqual(eng.writes.size, 12);
  assert.ok([...eng.writes.values()].every((n) => n === 1));
});

test('a permission revoked mid-job pauses it with permission_changed; nothing more is written', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const eng = fakeEngine(30, 3);
  const tokens = okTokens();
  eng.hooks.beforeCommit = async (from) => { if (from === 6) tokens.fp = 'fp-after-role-change'; };
  const w = R.createWorker({ store, adapter: eng, tokens, settings: S(), workerId: 'A' });
  await w.tick();
  assert.strictEqual(eng.job.status, 'paused');
  assert.strictEqual(eng.job.pause_reason, 'permission_changed');
  assert.strictEqual(eng.writes.size, 9); // chunks 0, 3, 6; then the check before chunk 9 paused it
  const row = await store.get('j1');
  assert.deepStrictEqual([row.state, row.reason, row.detail], ['paused', 'permission_changed', 'rules_changed']);
  assert.strictEqual(await w.tick(), 0); // a paused job is not picked up again
});

test('a revoked token pauses the job too', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const eng = fakeEngine(6, 3);
  const tokens = okTokens();
  tokens.ok = false;
  tokens.reason = 'token_revoked';
  const w = R.createWorker({ store, adapter: eng, tokens, settings: S(), workerId: 'A' });
  await w.tick();
  assert.strictEqual(eng.writes.size, 0);
  assert.deepStrictEqual([(await store.get('j1')).reason, (await store.get('j1')).detail], ['permission_changed', 'token_revoked']);
});

test('the kill switch stops the runner between chunks; the job resumes when it is off', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const eng = fakeEngine(9, 3);
  let kill = false;
  eng.hooks.beforeCommit = async (from) => { if (from === 3) kill = true; };
  const w = R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S(), workerId: 'A', killSwitch: async () => kill });
  await w.tick();
  assert.strictEqual(eng.job.next, 6);
  assert.strictEqual(await w.tick(), 0);
  kill = false;
  eng.hooks.beforeCommit = null;
  await w.tick();
  assert.strictEqual(eng.job.status, 'done');
  assert.ok([...eng.writes.values()].every((n) => n === 1));
});

test('repeated chunk errors pause the job instead of looping forever', async () => {
  const store = L.memoryStore();
  await store.insert(lease());
  const eng = fakeEngine(9, 3);
  eng.hooks.beforeCommit = async () => { throw new Error('db down'); };
  const clock = { t: 1000 };
  const w = R.createWorker({ store, adapter: eng, tokens: okTokens(), settings: S(), workerId: 'A', now: () => clock.t });
  for (let i = 0; i < 6; i += 1) { await w.tick(); clock.t += 61000; } // past each back-off (finding 8)
  const row = await store.get('j1');
  assert.deepStrictEqual([row.state, row.reason], ['paused', 'runner_errors']);
  assert.strictEqual(eng.job.status, 'paused');
});
