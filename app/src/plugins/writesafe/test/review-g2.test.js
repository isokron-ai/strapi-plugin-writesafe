'use strict';

// Re-review of the stream G PR: A1-A8, written before the fixes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../server/approval/tiers');
const A = require('../server/approval/service');
const L = require('../server/runner/lease');
const R = require('../server/runner/runner');

const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || (e.payload && e.payload.code); } };
const H = 3600000;
const T0 = Date.parse('2026-11-14T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------------ A1.1 admin tokens limited to MCP

function fakeAuth(strategyName) {
  return { authenticate: async (ctx, next) => { ctx.state.auth = { strategy: { name: strategyName } }; ctx.state.isAuthenticated = true; return next(); } };
}
async function call(auth, path = '/admin/users') {
  const ctx = { state: {}, request: { path }, path, status: 404, body: null };
  let reached = false;
  await auth.authenticate(ctx, async () => { reached = true; });
  return { reached, status: ctx.status, body: ctx.body };
}

test('A1.1: adminTokens "mcp-only" refuses admin-token authentication on admin routes; sessions pass; "any" changes nothing', async () => {
  const G = require('../server/compat/admin-tokens');
  for (const [mode, strategy, reached] of [['mcp-only', 'admin-token', false], ['mcp-only', 'admin', true], ['any', 'admin-token', true]]) {
    const auth = fakeAuth(strategy);
    const strapi = { get: (n) => (n === 'auth' ? auth : null), log: { info() {}, warn() {}, error() {} } };
    G.install(strapi, mode);
    for (const p of ['/admin/users', '/admin/admin-tokens', '/content-manager/collection-types/api::page.page']) {
      const r = await call(auth, p);
      assert.strictEqual(r.reached, reached, `${mode}/${strategy} ${p}`);
      if (!reached) assert.strictEqual(r.status, 403);
    }
  }
  // fail closed: mcp-only asked for and the auth service cannot be wrapped -> startup error
  assert.throws(() => G.install({ get: () => null, log: { error() {} } }, 'mcp-only'), /adminTokens/);
  const CFG = require('../server/config');
  assert.strictEqual(CFG.defaults.adminTokens, 'any');
  assert.throws(() => CFG.validator({ adminTokens: 'some' }), /adminTokens/);
});

// ------------------------------------------------------------------ A1.2 more unsafe actions

test('A1.2: token, transfer-token and provider-login management make a token unsafe', () => {
  const G = require('../server/approval/gate');
  for (const a of ['admin::admin-tokens.create', 'admin::admin-tokens.update', 'admin::admin-tokens.regenerate', 'admin::api-tokens.create',
    'admin::api-tokens.update', 'admin::api-tokens.regenerate', 'admin::transfer.tokens.create', 'admin::transfer.tokens.access',
    'admin::transfer.tokens.regenerate', 'admin::provider-login.update']) {
    assert.ok(G.UNSAFE_ACTIONS.includes(a), a);
    assert.strictEqual(G.unsafeToken({ can: (x) => x === a }), a);
  }
});

// ------------------------------------------------------------------ A1.3 approver quiet period

test('A1.3: an approver whose account changed within approverQuietHours before the request cannot approve', async () => {
  assert.strictEqual(T.settings({}, 1000).approverQuietHours, 24);
  const s = T.settings({ twoApproverAbove: 20, maxDocuments: 50 }, 5);
  const store = A.memoryStore();
  const svc = A.create({ store, settings: s, now: () => T0 });
  const { request } = await svc.request({ plan: { planId: 'j', planHash: 'h', uid: 'u', action: 'patch', count: 9 }, requester: { tokenId: '7', ownerUserId: '1' }, tier: T.tierFor(9, { action: 'patch' }, s) });
  const adm = (id, changed) => ({ id, viaSession: true, mayAct: true, createdAt: iso(T0 - 400 * H), updatedAt: iso(changed) });
  const c = await code(svc.decide({ requestId: request.requestId, approver: adm('2', T0 - 2 * H), decision: 'approve', planHash: 'h' }));
  assert.strictEqual(c, 'approver_changed');
  try { await svc.decide({ requestId: request.requestId, approver: adm('2', T0 - 2 * H), decision: 'approve', planHash: 'h' }); } catch (e) { assert.match(e.message, /2 h/); }
  // a rejection only stops a job: allowed in the quiet period
  const store2 = A.memoryStore();
  const svc2 = A.create({ store: store2, settings: s, now: () => T0 });
  const r2 = (await svc2.request({ plan: { planId: 'j2', planHash: 'h2', uid: 'u', action: 'patch', count: 9 }, requester: { tokenId: '7' }, tier: T.tierFor(9, { action: 'patch' }, s) })).request;
  assert.strictEqual((await svc2.decide({ requestId: r2.requestId, approver: adm('2', T0 - 2 * H), decision: 'reject', planHash: 'h2' })).request.status, 'rejected');
  assert.strictEqual((await svc.decide({ requestId: request.requestId, approver: adm('3', T0 - 25 * H), decision: 'approve', planHash: 'h' })).request.status, 'approved');
  const s0 = T.settings({ approverQuietHours: 0, twoApproverAbove: 20, maxDocuments: 50 }, 5);
  const svc0 = A.create({ store: A.memoryStore(), settings: s0, now: () => T0 });
  const r0 = (await svc0.request({ plan: { planId: 'j', planHash: 'h', uid: 'u', action: 'patch', count: 9 }, requester: { tokenId: '7' }, tier: T.tierFor(9, { action: 'patch' }, s0) })).request;
  assert.strictEqual((await svc0.decide({ requestId: r0.requestId, approver: adm('2', T0 - 60000), decision: 'approve', planHash: 'h' })).request.status, 'approved');
  assert.throws(() => T.settings({ approverQuietHours: 10000 }, 5), /approverQuietHours/);
});

test('A1.3: while the token owner\'s account is in its quiet period, the owner may not approve (requesterMayApprove forced off)', async () => {
  const s = T.settings({ twoApproverAbove: 20, maxDocuments: 50, approverQuietHours: 24 }, 5);
  const svc = A.create({ store: A.memoryStore(), settings: s, now: () => T0 });
  const { request } = await svc.request({ plan: { planId: 'j', planHash: 'h', uid: 'u', action: 'patch', count: 9 }, requester: { tokenId: '7', ownerUserId: '1', ownerChangedAt: T0 - 3 * H }, tier: T.tierFor(9, { action: 'patch' }, s) });
  assert.strictEqual(request.ownerMayApprove, false);
  // even once the owner's own account is old enough by the time they decide
  const owner = { id: '1', viaSession: true, mayAct: true, createdAt: iso(T0 - 400 * H), updatedAt: iso(T0 - 30 * H) };
  assert.strictEqual(await code(svc.decide({ requestId: request.requestId, approver: owner, decision: 'approve', planHash: 'h' })), 'requester_cannot_approve');
});

// ------------------------------------------------------------------ A2 full filter, honest view

test('A2: the full filter is kept (or refused when too long), and the view tells "not stored in full" from "hidden"', () => {
  const G = require('../server/approval/gate');
  const V = require('../server/approval/view');
  const big = { $or: Array.from({ length: 300 }, (_, i) => ({ title: { $eq: `padding-${i}` } })) };
  const rec = G.filterRecord(big);
  assert.strictEqual(rec.tooLong, false);
  assert.deepStrictEqual(rec.filter, big);
  assert.strictEqual(G.filterRecord({ $or: Array.from({ length: 5000 }, (_, i) => ({ title: { $eq: `x${i}` } })) }).tooLong, true);
  const superAdmin = { can: () => true };
  const v = V.approverView(superAdmin, { uid: 'u', spec: {}, filter: big, samples: [] });
  assert.ok(v.filter_summary.includes('padding-299'), 'a Super Admin sees the whole filter');
  const legacy = V.approverView(superAdmin, { uid: 'u', spec: {}, filter_summary: '{"title":{"$eq":"cut', samples: [] });
  assert.match(legacy.filter_summary, /not stored in full/);
  assert.notStrictEqual(legacy.filter_summary, V.HIDDEN_FILTER);
});

// ------------------------------------------------------------------ A3 longer horizon for paused and started jobs

test('A3: paused jobs and approved agent-driven jobs with progress get the long horizon', () => {
  const RT = require('../server/approval/retention');
  const now = T0;
  const opts = { cutoffMs: now - 72 * H, longCutoffMs: now - 30 * 24 * H };
  assert.strictEqual(RT.jobAction({ status: 'paused' }, null, null, now, { ...opts, updatedAtMs: now - 100 * H }), 'keep');
  assert.strictEqual(RT.jobAction({ status: 'paused' }, null, null, now, { ...opts, updatedAtMs: now - 31 * 24 * H }), 'prune_linked');
  const started = { status: 'running', next: 3, approval: { request_id: 'ar', status: 'used' } };
  assert.strictEqual(RT.jobAction(started, { status: 'consumed' }, null, now, { ...opts, updatedAtMs: now - 100 * H }), 'keep');
  assert.strictEqual(RT.jobAction({ ...started, next: 0 }, { status: 'consumed' }, null, now, { ...opts, updatedAtMs: now - 100 * H }), 'prune_linked');
  assert.strictEqual(RT.pruneOn({ status: 'paused' }, now, { jobHours: 72, longHorizonDays: 30 }), now + 30 * 24 * H);
  assert.strictEqual(RT.pruneOn({ status: 'done' }, now, { jobHours: 72, longHorizonDays: 30 }), now + 72 * H);
});

// ------------------------------------------------------------------ A4 approver may act on every field and locale

test('A4: mayAct needs the action on every touched field and on the locale; isStillApprover re-checks it', async () => {
  const AP = require('../server/approval/approver');
  // a permission checker over (action, entity, field) as Content Manager's
  const pcFor = (allow) => ({ can: new Proxy({}, { get: (_, act) => (e, f) => allow(act, e, f) }), cannot: new Proxy({}, { get: (_, act) => (e, f) => !allow(act, e, f) }) });
  const req = { uid: 'api::page.page', action: 'patch', locale: 'fr', spec: { set: { title: 'x', note: 'y' } } };
  assert.strictEqual(AP.mayAct(pcFor(() => true), req), true);
  assert.strictEqual(AP.mayAct(pcFor((a, e, f) => f !== 'note'), req), false);
  assert.strictEqual(AP.mayAct(pcFor((a, e) => !e || e.locale !== 'fr'), req), false);
  assert.strictEqual(AP.mayAct(pcFor((a) => a === 'publish'), { ...req, action: 'publish', spec: {} }), true);
  assert.strictEqual(AP.mayAct(pcFor((a) => a === 'update'), { ...req, action: 'publish', spec: {} }), false);
  // a component field is checked leaf by leaf, as Strapi names component permissions ("items.label")
  const strapi = { contentTypes: { 'api::page.page': { attributes: { items: { type: 'component', component: 'shared.item' } } } },
    components: { 'shared.item': { attributes: { id: {}, label: { type: 'string' }, qty: { type: 'integer' } } } } };
  const comp = { ...req, locale: null, spec: { ops: [{ op: 'add', field: 'items', data: {} }] } };
  assert.strictEqual(AP.mayAct(pcFor((a, e, f) => f !== 'items'), comp, AP.leavesFor(strapi, 'api::page.page')), true);
  assert.strictEqual(AP.mayAct(pcFor((a, e, f) => f !== 'items.qty'), comp, AP.leavesFor(strapi, 'api::page.page')), false);
  // service: isStillApprover gets the request
  const seen = [];
  const s = T.settings({ twoApproverAbove: 20, maxDocuments: 50, approverQuietHours: 0 }, 5);
  const svc = A.create({ store: A.memoryStore(), settings: s, now: () => T0, isStillApprover: async (id, r) => { seen.push([id, r.uid]); return true; } });
  const { request } = await svc.request({ plan: { planId: 'j', planHash: 'h', uid: 'api::page.page', action: 'patch', count: 30 }, requester: { tokenId: '7' }, tier: T.tierFor(30, { action: 'patch' }, s) });
  const adm = (id) => ({ id, viaSession: true, mayAct: true, createdAt: iso(T0 - H), updatedAt: iso(T0 - H) });
  await svc.decide({ requestId: request.requestId, approver: adm('1'), decision: 'approve', planHash: 'h' });
  await svc.decide({ requestId: request.requestId, approver: adm('2'), decision: 'approve', planHash: 'h' });
  assert.deepStrictEqual(seen, [['1', 'api::page.page']]);
});

test('A4: samples are hidden from an approver whose read rights carry conditions', () => {
  const V = require('../server/approval/view');
  const READ = 'plugin::content-manager.explorer.read';
  const ability = { can: () => true, rulesFor: (a) => (a === READ ? [{ conditions: { 'createdBy.id': 4 } }] : []) };
  const v = V.approverView(ability, { uid: 'api::page.page', spec: {}, samples: [{ documentId: 'd', before: { title: 'secret' }, after: { title: 'x' } }] });
  assert.deepStrictEqual(v.samples, []);
  assert.strictEqual(v.samples_hidden, 'conditional_read');
});

// ------------------------------------------------------------------ A5 chunk cap through the adapter

test('A5: the runner reads the chunk time cap through the adapter', () => {
  const AD = require('../server/runner/adapter');
  assert.strictEqual(typeof AD.chunkTimeMs, 'function');
  const C = require('../server/approval/control');
  const saved = AD.chunkTimeMs;
  const logs = [];
  AD.chunkTimeMs = () => 2000;
  const AT = require('../server/compat/admin-token');
  const probe = AT.probe;
  AT.probe = () => true;
  C.ST.runner = R.settings({ enabled: true, leaseMs: 5000, heartbeatMs: 1000 });
  try {
    C.startRunner({ log: { error: (m) => logs.push(m), info() {}, warn() {} } });
    assert.strictEqual(C.runnerActive(), false);
    assert.ok(logs.some((m) => /3 x/.test(m) && /2000/.test(m)), logs.join('|'));
  } finally {
    AD.chunkTimeMs = saved; AT.probe = probe; C.ST.runner = R.settings({});
  }
});

// ------------------------------------------------------------------ A6 back-off in the query

test('A6: the lease candidates query filters nextAttemptAt in SQL', async () => {
  const STORE = require('../server/approval/store');
  let where = null;
  const strapi = { db: { query: () => ({ findMany: async (q) => { where = q.where; return []; } }) } };
  await STORE.leases(strapi).candidates(T0, 5);
  assert.ok(JSON.stringify(where).includes('nextAttemptAt'), JSON.stringify(where));
});

// ------------------------------------------------------------------ A7 retention pages with a cursor

test('A7: finished approval records are pruned page by page past the first 500', async () => {
  const RT = require('../server/approval/retention');
  const rows = Array.from({ length: 1300 }, (_, i) => ({ id: i + 1, requestId: `ar${i}`, planId: `j${i}`, status: 'rejected', requestedAt: T0 - 100 * H }));
  const deleted = new Set();
  const match = (r, w) => Object.entries(w).every(([k, v]) => (v && typeof v === 'object' ? ((v.$lt === undefined || r[k] < v.$lt) && (v.$gt === undefined || r[k] > v.$gt)) : r[k] === v));
  const q = (uid) => ({
    findMany: async ({ where, limit }) => (uid.endsWith('approval-request') ? rows.filter((r) => !deleted.has(r.requestId) && match(r, where)).slice(0, limit) : []),
    deleteMany: async ({ where }) => { if (uid.endsWith('approval-request')) deleted.add(where.requestId); return { count: 1 }; },
  });
  const out = await RT.pruneRecords({ db: { query: q } }, T0 - 72 * H, async () => false);
  assert.strictEqual(out.requests, 1300);
});

// ------------------------------------------------------------------ A8 README matches the defaults

test('A8: the README tier table matches the defaults', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const table = md.slice(md.indexOf('| Documents | What happens |'), md.indexOf('Tiers apply per job'));
  const d = T.DEFAULTS;
  assert.ok(table.includes(`(${d.maxDocuments.toLocaleString('en-US')} by default`), table);
  assert.ok(/two \*\*different\*\* admins approve[^\n]*only when/.test(table) || /only when `approvals.maxDocuments` is raised/.test(table), table);
});
