'use strict';

// Second-agent review of the stream G PR: one test (or more) per finding, written before the fixes.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../server/approval/tiers');
const A = require('../server/approval/service');
const L = require('../server/runner/lease');
const R = require('../server/runner/runner');

const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || (e.payload && e.payload.code); } };
const S = (over = {}) => T.settings({ twoApproverAbove: 20, maxDocuments: 50, ...over }, 5);
const plan = (over = {}) => ({ planId: 'jabc', planHash: 'h1', uid: 'api::page.page', action: 'patch', count: 12, ...over });
const requester = { tokenId: '7', ownerUserId: '1' };
const T0 = Date.parse('2026-11-14T10:00:00Z');
const old = new Date(T0 - 2 * 86400000).toISOString(); // older than the 24 h quiet period (re-review A1.3)
const session = (id, over = {}) => ({ id, name: `admin ${id}`, viaSession: true, createdAt: old, updatedAt: old, mayAct: true, ...over });
function svc(settings = S(), extra = {}) {
  const store = A.memoryStore();
  const clock = { t: T0 };
  return { store, clock, A: A.create({ store, settings, now: () => clock.t, ...extra }) };
}

// ------------------------------------------------------------------ 1. self-approval through user management

test('1a: a token that can manage admin users or roles cannot ask for an approval (nothing stored)', async () => {
  const G = require('../server/approval/gate');
  for (const a of ['admin::roles.create', 'admin::roles.update', 'admin::users.create', 'admin::users.update']) assert.ok(G.UNSAFE_ACTIONS.includes(a), a); // more since re-review A1.2
  for (const a of G.UNSAFE_ACTIONS) {
    const ability = { can: (x) => x === a };
    assert.strictEqual(G.unsafeToken(ability), a);
  }
  assert.strictEqual(G.unsafeToken({ can: () => false }), null);
});

test('1b: an approver whose admin account was created or changed after the request cannot decide it', async () => {
  const { A: s, clock } = svc();
  const { request } = await s.request({ plan: plan(), requester, tier: T.tierFor(12, { action: 'patch' }, S()) });
  clock.t += 60000;
  const after = new Date(T0 + 1000).toISOString();
  assert.strictEqual(await code(s.decide({ requestId: request.requestId, approver: session('2', { updatedAt: after }), decision: 'approve', planHash: 'h1' })), 'approver_changed');
  assert.strictEqual(await code(s.decide({ requestId: request.requestId, approver: session('3', { createdAt: after, updatedAt: after }), decision: 'approve', planHash: 'h1' })), 'approver_changed');
  assert.strictEqual(await code(s.decide({ requestId: request.requestId, approver: session('4', { updatedAt: undefined }), decision: 'approve', planHash: 'h1' })), 'approver_changed');
  assert.strictEqual((await s.decide({ requestId: request.requestId, approver: session('5'), decision: 'approve', planHash: 'h1' })).request.status, 'approved');
});

// ------------------------------------------------------------------ 7. approver permissions

test('7: the approver must be allowed the job\'s action on the type; stale approvals do not count at the final decision', async () => {
  const live = new Set(['1', '2']);
  const { A: s } = svc(S(), { isStillApprover: async (id) => live.has(String(id)) });
  const { request } = await s.request({ plan: plan({ count: 30 }), requester, tier: T.tierFor(30, { action: 'patch' }, S()) });
  assert.strictEqual(await code(s.decide({ requestId: request.requestId, approver: session('9', { mayAct: false }), decision: 'approve', planHash: 'h1' })), 'approver_lacks_permission');
  await s.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' });
  live.delete('1'); // admin 1 lost "Approve writesafe jobs" or was deactivated
  const r = await s.decide({ requestId: request.requestId, approver: session('2'), decision: 'approve', planHash: 'h1' });
  assert.strictEqual(r.request.status, 'pending');
  assert.deepStrictEqual(r.dropped, ['1']);
  live.add('3');
  assert.strictEqual((await s.decide({ requestId: request.requestId, approver: session('3'), decision: 'approve', planHash: 'h1' })).request.status, 'approved');
});

// ------------------------------------------------------------------ 6. ceiling on E's job tables

test('6: default admin ceiling is 20,000 (the reduced-scale run on E\'s job tables); the hard limit stays 100,000', () => {
  const s = T.settings({}, 1000);
  assert.strictEqual(s.maxDocuments, 20000);
  assert.strictEqual(T.tierFor(20001, { action: 'patch' }, s).tier, 'refused');
  assert.strictEqual(T.settings({ maxDocuments: 100000 }, 1000).maxDocuments, 100000);
  assert.throws(() => T.settings({ maxDocuments: 100001 }, 1000), /hard limit/);
});

// ------------------------------------------------------------------ 10. refused tier

test('10: a job over the admin ceiling is refused by the gate itself (never let through)', async () => {
  const G = require('../server/approval/gate');
  const C = require('../server/approval/control');
  const strapi = { config: { get: () => ({}) }, contentTypes: { 'api::page.page': { attributes: {} } }, components: {} };
  C.ST.approvalsCfg = { maxDocuments: 50, twoApproverAbove: 20 };
  const job = { contentType: 'api::page.page', action: 'patch', spec: { set: { title: 'x' } }, total: 51 }; // stream E's job row
  assert.strictEqual(await code(G.gate.beforeCreate(strapi, { userAbility: { can: () => false } }, {}, job, 51)), 'too_many_documents');
  C.ST.approvalsCfg = undefined;
});

// ------------------------------------------------------------------ 9. kill switch fails closed

test('9: the kill switch reads as ON when its store cannot be read', async () => {
  const C = require('../server/approval/control');
  const broken = { store: { get: async () => { throw new Error('db down'); } } };
  assert.strictEqual(await C.killSwitch(broken), true);
  assert.strictEqual(await C.killSwitch({ store: { get: async () => null } }), false);
  assert.strictEqual(await C.killSwitch({ store: { get: async () => ({ on: true }) } }), true);
});

// ------------------------------------------------------------------ 2. runner enabled but not started

test('2: a runner that is enabled but failed its probe is not active; approved jobs fall back to the agent', async () => {
  const C = require('../server/approval/control');
  const logs = [];
  const strapi = { admin: { services: {} }, log: { error: (m) => logs.push(m), info: () => {}, warn: () => {} } };
  C.ST.runner = R.settings({ enabled: true });
  C.startRunner(strapi);
  assert.strictEqual(C.runnerActive(), false);
  assert.ok(logs.some((m) => /runner NOT started/.test(m)));
  const G = require('../server/approval/gate');
  const d = G.gate.describe({ job_id: 'j', status: 'running', runner: true });
  assert.strictEqual(d.runner, undefined); // no "running on the server" claim
  C.ST.runner = R.settings({});
});

// ------------------------------------------------------------------ 3. retention

test('3: retention never prunes a waiting, paused or runner-run job on its own clock', () => {
  const RT = require('../server/approval/retention');
  const now = T0;
  const pending = { status: 'pending', expiresAt: now + 1000 };
  assert.strictEqual(RT.jobAction({ status: 'awaiting_approval' }, pending, null, now), 'keep');
  assert.strictEqual(RT.jobAction({ status: 'awaiting_approval' }, { status: 'pending', expiresAt: now - 1 }, null, now), 'prune_linked');
  assert.strictEqual(RT.jobAction({ status: 'awaiting_approval' }, { status: 'rejected' }, null, now), 'prune_linked');
  assert.strictEqual(RT.jobAction({ status: 'awaiting_approval' }, null, null, now), 'prune_linked');
  assert.strictEqual(RT.jobAction({ status: 'running', runner: true }, null, { state: 'running' }, now), 'keep');
  assert.strictEqual(RT.jobAction({ status: 'running', runner: true }, null, { state: 'queued' }, now), 'keep');
  assert.strictEqual(RT.jobAction({ status: 'paused', approval: { request_id: 'ar' } }, null, { state: 'paused' }, now), 'prune_linked');
  assert.strictEqual(RT.jobAction({ status: 'done' }, null, null, now), 'prune');
  assert.strictEqual(RT.jobAction({ status: 'done', approval: { request_id: 'ar' } }, { status: 'consumed' }, { state: 'done' }, now), 'prune_linked');
  assert.strictEqual(RT.leasePrunable({ state: 'done', updatedAtMs: now - 10 }, now - 5), true);
  assert.strictEqual(RT.leasePrunable({ state: 'running', updatedAtMs: now - 10 }, now - 5), false);
  assert.strictEqual(RT.requestPrunable({ status: 'consumed', requestedAt: now - 10 }, now, now - 5), true);
  assert.strictEqual(RT.requestPrunable({ status: 'pending', requestedAt: now - 10, expiresAt: now + 5 }, now, now - 5), false);
});

test('3: requestTtlSeconds cannot outlive the job retention', () => {
  const CFG = require('../server/config');
  assert.throws(() => CFG.validator({ approvals: { requestTtlSeconds: 4 * 3600 }, retention: { jobHours: 2 } }), /requestTtlSeconds/);
  CFG.validator({ approvals: { requestTtlSeconds: 3600 }, retention: { jobHours: 2 } });
  CFG.validator({ approvals: { requestTtlSeconds: 4 * 3600 }, retention: { jobHours: 0 } }); // 0 keeps jobs
});

test('3: a decision whose job is gone says so (start_error), and a lease of a missing job ends visibly', async () => {
  const C = require('../server/approval/control');
  const AD = require('../server/runner/adapter');
  const saved = { decide: C.ST.service, runner: C.ST.runner, active: C.ST.runnerActive, getJob: AD.getJob };
  C.ST.service = { decide: async () => ({ request: { status: 'approved', planId: 'jgone' }, decisions: [], approvals: 1, required: 1 }) };
  C.ST.runner = R.settings({ enabled: true });
  C.ST.runnerActive = true;
  AD.getJob = async () => null;
  const r = await C.decide({}, { requestId: 'ar', admin: session('1'), decision: 'approve', planHash: 'h' });
  assert.strictEqual(r.started, false);
  assert.strictEqual(r.start_error.code, 'job_missing');
  Object.assign(C.ST, { service: saved.decide, runner: saved.runner, runnerActive: saved.active });
  AD.getJob = saved.getJob;

  const store = L.memoryStore();
  await store.insert({ jobId: 'jgone', state: 'queued', tokenId: '7', uid: 'u', permFingerprint: 'fp' });
  const w = R.createWorker({ store, adapter: { runOneChunk: async () => ({ job: { status: 'missing' }, items: [], idle: true }), setJobStatus: async () => true },
    tokens: { check: async () => ({ ok: true, fingerprint: 'fp', ctx: {} }) }, settings: R.settings({ heartbeatMs: 0, chunkPauseMs: 0 }), workerId: 'A' });
  await w.tick();
  const row = await store.get('jgone');
  assert.deepStrictEqual([row.state, row.reason], ['failed', 'job_missing']);
});

// ------------------------------------------------------------------ 4. the approver's own view

test('4: samples, change and filter are shown through the approver\'s read permission', () => {
  const V = require('../server/approval/view');
  const READ = 'plugin::content-manager.explorer.read';
  const ability = { can: (a, uid, f) => a === READ && uid === 'api::page.page' && f !== 'note' };
  const r = {
    uid: 'api::page.page', spec: { set: { title: 'T', note: 'secret' }, unset: ['summary'], ops: [{ op: 'add', field: 'note', data: { x: 1 } }] },
    filter_summary: JSON.stringify({ title: { $startsWith: 'a' } }),
    samples: [{ documentId: 'd1', changed: ['title', 'note'], before: { title: 'a', note: 'old secret' }, after: { title: 'T', note: 'secret' } }],
  };
  const v = V.approverView(ability, r);
  assert.strictEqual(v.spec.set.title, 'T');
  assert.notStrictEqual(v.spec.set.note, 'secret');
  assert.ok(!JSON.stringify(v).includes('secret'));
  assert.deepStrictEqual(v.fields, ['note', 'summary', 'title']);
  const v2 = V.approverView(ability, { ...r, filter_summary: JSON.stringify({ $or: [{ note: { $eq: 'x' } }] }) });
  assert.ok(!v2.filter_summary.includes('"x"'));
  const none = V.approverView({ can: () => false }, r);
  assert.deepStrictEqual(none.samples, []);
  assert.strictEqual(none.samples_hidden, true);
  assert.ok(!JSON.stringify(none).includes('secret') && !JSON.stringify(none).includes('"T"'));
});

// ------------------------------------------------------------------ 8. back-off after a chunk error

test('8: after a chunk error the job waits (growing delay) before the next try', async () => {
  const store = L.memoryStore();
  await store.insert({ jobId: 'j1', state: 'queued', tokenId: '7', uid: 'u', permFingerprint: 'fp' });
  const clock = { t: T0 };
  let calls = 0;
  const adapter = { runOneChunk: async () => { calls += 1; throw new Error('db blip'); }, setJobStatus: async () => true };
  const w = R.createWorker({ store, adapter, tokens: { check: async () => ({ ok: true, fingerprint: 'fp', ctx: {} }) }, settings: R.settings({ heartbeatMs: 0, chunkPauseMs: 0 }), workerId: 'A', now: () => clock.t });
  await w.tick();
  assert.strictEqual(calls, 1);
  await w.tick();
  assert.strictEqual(calls, 1); // not before nextAttemptAt
  const first = (await store.get('j1')).nextAttemptAt - clock.t;
  clock.t += first + 1;
  await w.tick();
  assert.strictEqual(calls, 2);
  const second = (await store.get('j1')).nextAttemptAt - clock.t;
  assert.ok(second > first, `${second} > ${first}`);
  assert.strictEqual((await store.get('j1')).state, 'running');
});

// ------------------------------------------------------------------ 11. fence without the lease clock

test('11: an expired lease nobody took is still the worker\'s (fence and owner), so a long chunk is not lost; a taken one is', async () => {
  const store = L.memoryStore();
  await store.insert({ jobId: 'j1', state: 'queued' });
  const a = await store.tryAcquire('j1', 'A', 1000, 2000);
  assert.strictEqual(await store.assertHeld('j1', 'A', a.fence, 5000), true);
  assert.strictEqual(await store.renew('j1', 'A', a.fence, 9000, 5000), true);
  const b = await store.tryAcquire('j1', 'B', 10000, 11000);
  assert.ok(b);
  assert.strictEqual(await store.assertHeld('j1', 'A', a.fence, 10001), false);
  assert.strictEqual(await store.renew('j1', 'A', a.fence, 12000, 10001), false);
});

// ------------------------------------------------------------------ 14. admin resume re-inserts a missing lease

test('14: an admin resume of a runner job whose lease row is gone puts it back', async () => {
  const C = require('../server/approval/control');
  const AD = require('../server/runner/adapter');
  const AT = require('../server/compat/admin-token');
  const saved = { getJob: AD.getJob, setJobStatus: AD.setJobStatus, check: AT.check, leases: C.ST.leases, service: C.ST.service, runner: C.ST.runner, active: C.ST.runnerActive };
  const job = { job_id: 'j1', status: 'paused', uid: 'api::page.page', owner: 'o', runner: true, approval: { request_id: 'ar1' } };
  AD.getJob = async () => job;
  AD.setJobStatus = async (s, id, to) => ({ ...job, status: to });
  AT.check = async () => ({ ok: true, fingerprint: 'fp-now' });
  C.ST.leases = L.memoryStore();
  C.ST.service = { get: async () => ({ requestId: 'ar1', tokenId: '7' }) };
  C.ST.runner = R.settings({ enabled: true });
  C.ST.runnerActive = true;
  try {
    await C.resume({}, 'j1');
    const l = await C.ST.leases.get('j1');
    assert.ok(l, 'lease re-inserted');
    assert.deepStrictEqual([l.state, l.tokenId, l.permFingerprint, l.owner], ['queued', '7', 'fp-now', 'o']);
  } finally {
    AD.getJob = saved.getJob; AD.setJobStatus = saved.setJobStatus; AT.check = saved.check;
    Object.assign(C.ST, { leases: saved.leases, service: saved.service, runner: saved.runner, runnerActive: saved.active });
  }
});
