'use strict';

// Approval tiers and records for bulk jobs (1.0 hardening, Phase 4 stream G). No Strapi needed: the service runs on
// the memory store, which has the same contract as the Strapi-table store (server/approval/store.js).
const test = require('node:test');
const assert = require('node:assert');
const T = require('../server/approval/tiers');
const A = require('../server/approval/service');

const S = (over = {}) => T.settings({ twoApproverAbove: 20, maxDocuments: 50, approverQuietHours: 0, ...over }, 5);
const plan = (over = {}) => ({ planId: 'jabc', planHash: 'h1', manifestRoot: 'm1', uid: 'api::page.page', locale: null, action: 'patch', count: 12, ...over });
const requester = { tokenId: '7', tokenName: 'agent', ownerUserId: '1', agent: 'bot' };
// an admin session as admin-api.js builds it: account unchanged since before the request, allowed the job's action
const session = (id) => ({ id, name: `admin ${id}`, viaSession: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), mayAct: true });
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };

function svc(settings = S(), clock = { t: 1000 }) {
  const store = A.memoryStore();
  return { store, clock, A: A.create({ store, settings, now: () => clock.t }) };
}

test('tiers: automatic up to the bulk ceiling, one approver, two approvers, refused above the admin ceiling', () => {
  const s = S();
  assert.deepStrictEqual([5, 6, 20, 21, 50, 51].map((n) => T.tierFor(n, { action: 'patch' }, s).tier), ['automatic', 'one', 'one', 'two', 'two', 'refused']);
  assert.strictEqual(T.tierFor(21, { action: 'patch' }, s).approvals, 2);
  assert.strictEqual(T.ceiling(s), 50);
});

test('tiers: defaults are the bulk ceiling automatic, ceiling 20,000 as measured on E\'s job tables (100,000 configurable)', () => {
  const s = T.settings({}, 5000);
  assert.strictEqual(s.automaticMax, 5000);
  assert.strictEqual(s.maxDocuments, 20000);
  assert.deepStrictEqual(s.escalate, { publish: false, relations: false });
  assert.strictEqual(T.tierFor(5001, { action: 'patch' }, s).tier, 'one');
  assert.strictEqual(T.tierFor(20000, { action: 'patch' }, s).tier, 'one');
  assert.strictEqual(T.tierFor(20001, { action: 'patch' }, s).tier, 'refused');
  const big = T.settings({ maxDocuments: 100000 }, 5000);
  assert.strictEqual(big.twoApproverAbove, 25000);
  assert.strictEqual(T.tierFor(25001, { action: 'patch' }, big).tier, 'two');
  assert.strictEqual(T.tierFor(100001, { action: 'patch' }, big).tier, 'refused');
});

test('tiers: hard limits cannot be configured away', () => {
  assert.throws(() => T.settings({ maxDocuments: 100001 }, 5000), /hard limit/);
  assert.throws(() => T.settings({ twoApproverAbove: 50001 }, 5000), /hard limit/);
  assert.throws(() => T.settings({ approvalTtlSeconds: 2 * 24 * 3600 }, 5000), /approvalTtlSeconds/);
  assert.throws(() => T.settings({ automaticMax: 6000 }, 5000), /bulk.maxDocuments/);
  assert.throws(() => T.settings({ escalate: { everything: true } }, 5000), /unknown/);
});

test('tiers: escalations ask for one approval at any size when on, and are off by default', () => {
  const off = S();
  const on = S({ escalate: { publish: true, relations: true } });
  assert.strictEqual(T.tierFor(2, { action: 'publish' }, off).tier, 'automatic');
  assert.strictEqual(T.tierFor(2, { action: 'publish' }, on).reason, 'publish');
  assert.strictEqual(T.tierFor(2, { action: 'patch', relations: true }, on).reason, 'relations');
  assert.strictEqual(T.tierFor(2, { action: 'patch', relations: false }, on).tier, 'automatic');
});

test('tiers: approvals off keeps the old behaviour (refused above the bulk ceiling)', () => {
  const s = S({ enabled: false });
  assert.strictEqual(T.tierFor(6, { action: 'patch' }, s).tier, 'refused');
  assert.strictEqual(T.ceiling(s), 5);
});

test('proof: the agent can never approve; a decision needs an admin session', async () => {
  const { A: svc1 } = svc();
  const { request } = await svc1.request({ plan: plan(), requester, tier: T.tierFor(12, { action: 'patch' }, S()) });
  // what an agent could send: an admin API token's identity, or a body claiming approval
  assert.strictEqual(await code(svc1.decide({ requestId: request.requestId, approver: { id: '1', viaSession: false }, decision: 'approve', planHash: 'h1' })), 'session_required');
  assert.strictEqual(await code(svc1.decide({ requestId: request.requestId, approver: { id: '1', approved: true }, decision: 'approve', planHash: 'h1' })), 'session_required');
  assert.strictEqual(await code(svc1.decide({ requestId: request.requestId, approver: null, decision: 'approve', planHash: 'h1' })), 'unauthorized');
  assert.strictEqual((await svc1.get(request.requestId)).status, 'pending');
  assert.strictEqual(await code(svc1.consume({ requestId: request.requestId, planId: 'jabc', planHash: 'h1' })), 'approval_pending');
});

test('one approver: an admin session approves, the approval is used once', async () => {
  const { A: s1 } = svc();
  const { request } = await s1.request({ plan: plan(), requester, tier: T.tierFor(12, { action: 'patch' }, S()) });
  const d = await s1.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' });
  assert.strictEqual(d.request.status, 'approved');
  assert.strictEqual((await s1.consume({ requestId: request.requestId, planId: 'jabc', planHash: 'h1' })).status, 'consumed');
  assert.strictEqual(await code(s1.consume({ requestId: request.requestId, planId: 'jabc', planHash: 'h1' })), 'approval_used');
});

test('two approvers: the same admin twice does not count; a distinct second admin is required', async () => {
  const { A: s2 } = svc();
  const { request } = await s2.request({ plan: plan({ count: 30 }), requester, tier: T.tierFor(30, { action: 'patch' }, S()) });
  assert.strictEqual(request.requiredApprovals, 2);
  const first = await s2.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' });
  assert.strictEqual(first.request.status, 'pending');
  assert.strictEqual(await code(s2.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' })), 'already_decided');
  assert.strictEqual(await code(s2.decide({ requestId: request.requestId, approver: { ...session(1) }, decision: 'approve', planHash: 'h1' })), 'already_decided'); // 1 and '1' are one admin
  assert.strictEqual(await code(s2.consume({ requestId: request.requestId, planId: 'jabc', planHash: 'h1' })), 'approval_pending');
  const second = await s2.decide({ requestId: request.requestId, approver: session('2'), decision: 'approve', planHash: 'h1' });
  assert.strictEqual(second.request.status, 'approved');
  assert.deepStrictEqual(second.decisions.map((x) => x.approverId), ['1', '2']);
});

test('two approvers deciding at the same moment: both recorded once, approved once', async () => {
  const { A: s3, store } = svc();
  const { request } = await s3.request({ plan: plan({ count: 30 }), requester, tier: T.tierFor(30, { action: 'patch' }, S()) });
  const r = await Promise.all(['1', '1', '2'].map((id) => s3.decide({ requestId: request.requestId, approver: session(id), decision: 'approve', planHash: 'h1' }).then(() => 'ok', (e) => e.code)));
  assert.deepStrictEqual(r.sort(), ['already_decided', 'ok', 'ok']);
  assert.strictEqual(store.decs.size, 2);
  assert.strictEqual((await s3.get(request.requestId)).status, 'approved');
});

test('a rejection by any approver ends the request', async () => {
  const { A: s4 } = svc();
  const { request } = await s4.request({ plan: plan({ count: 30 }), requester, tier: T.tierFor(30, { action: 'patch' }, S()) });
  await s4.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' });
  await s4.decide({ requestId: request.requestId, approver: session('2'), decision: 'reject', planHash: 'h1' });
  assert.strictEqual((await s4.get(request.requestId)).status, 'rejected');
  assert.strictEqual(await code(s4.decide({ requestId: request.requestId, approver: session('3'), decision: 'approve', planHash: 'h1' })), 'not_pending');
  assert.strictEqual(await code(s4.consume({ requestId: request.requestId, planId: 'jabc', planHash: 'h1' })), 'approval_rejected');
});

test('an approval bound to a different plan is refused, when deciding and when starting', async () => {
  const { A: s5 } = svc();
  const { request } = await s5.request({ plan: plan(), requester, tier: T.tierFor(12, { action: 'patch' }, S()) });
  assert.strictEqual(await code(s5.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h-other' })), 'plan_mismatch');
  assert.strictEqual(await code(s5.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve' })), 'invalid');
  await s5.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' });
  // the stored plan changed after the approval (another id list): its recomputed hash no longer matches
  assert.strictEqual(await code(s5.consume({ requestId: request.requestId, planId: 'jabc', planHash: 'h2' })), 'plan_mismatch');
  // another job cannot use it either
  assert.strictEqual(await code(s5.consume({ requestId: request.requestId, planId: 'jother', planHash: 'h1' })), 'plan_mismatch');
  assert.strictEqual((await s5.get(request.requestId)).status, 'approved'); // still usable by its own plan
});

test('an expired request cannot be decided; an expired approval cannot start the job', async () => {
  const s = S({ requestTtlSeconds: 60, approvalTtlSeconds: 30 });
  const { A: s6, clock } = svc(s);
  const r1 = (await s6.request({ plan: plan(), requester, tier: T.tierFor(12, { action: 'patch' }, s) })).request;
  clock.t += 61 * 1000;
  assert.strictEqual(await code(s6.decide({ requestId: r1.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' })), 'expired');
  assert.strictEqual((await s6.get(r1.requestId)).status, 'expired');
  const r2 = (await s6.request({ plan: plan({ planId: 'j2', planHash: 'h9' }), requester, tier: T.tierFor(12, { action: 'patch' }, s) })).request;
  await s6.decide({ requestId: r2.requestId, approver: session('1'), decision: 'approve', planHash: 'h9' });
  clock.t += 31 * 1000;
  assert.strictEqual(await code(s6.consume({ requestId: r2.requestId, planId: 'j2', planHash: 'h9' })), 'approval_expired');
});

test('requests: one pending request per plan and token, a cap per token', async () => {
  const s = S({ pendingPerToken: 2 });
  const { A: s7 } = svc(s);
  const tier = T.tierFor(12, { action: 'patch' }, s);
  const a = await s7.request({ plan: plan(), requester, tier });
  const again = await s7.request({ plan: plan({ planId: 'jdup' }), requester, tier });
  assert.strictEqual(again.existing, true);
  assert.strictEqual(again.request.requestId, a.request.requestId);
  await s7.request({ plan: plan({ planId: 'j2', planHash: 'h2' }), requester, tier });
  assert.strictEqual(await code(s7.request({ plan: plan({ planId: 'j3', planHash: 'h3' }), requester, tier })), 'too_many_pending');
  assert.strictEqual(await code(s7.request({ plan: plan(), requester: { tokenId: null }, tier })), 'unsupported');
});

test('requesterMayApprove false: the token owner cannot approve its own job', async () => {
  const s = S({ requesterMayApprove: false });
  const { A: s8 } = svc(s);
  const { request } = await s8.request({ plan: plan(), requester, tier: T.tierFor(12, { action: 'patch' }, s) });
  assert.strictEqual(await code(s8.decide({ requestId: request.requestId, approver: session('1'), decision: 'approve', planHash: 'h1' })), 'requester_cannot_approve');
  assert.strictEqual((await s8.decide({ requestId: request.requestId, approver: session('2'), decision: 'approve', planHash: 'h1' })).request.status, 'approved');
});

test('plan hash: the same for a job in memory and read back from its row; any change to the plan changes it', () => {
  const AD = require('../server/runner/adapter');
  // stream E's job row: the job id comes from the plan token's MAC, idHash is the plan's id-list hash
  const job = { jobId: 'jmac1', owner: 'u1:abc', tool: 'ws_bulk', contentType: 'api::page.page', targetLocale: null, action: 'patch', mode: 'stop_on_error',
    spec: { set: { summary: 'x' }, unset: undefined, ops: undefined }, qfilters: { title: { $startsWith: 'a' } }, total: 3, idHash: 'h3' };
  const stored = JSON.parse(JSON.stringify(job));
  assert.strictEqual(AD.planHash(job), AD.planHash(stored));
  for (const change of [{ idHash: 'h2' }, { total: 2 }, { jobId: 'jmac2' }, { spec: { set: { summary: 'y' } } }, { owner: 'u2:abc' }, { action: 'publish' }, { targetLocale: 'fr' }]) {
    assert.notStrictEqual(AD.planHash({ ...stored, ...change }), AD.planHash(stored), JSON.stringify(change));
  }
});
