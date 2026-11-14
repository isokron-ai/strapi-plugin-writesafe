'use strict';

// Third review of the stream G PR: B1-B7, written before the fixes.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../server/approval/tiers');
const A = require('../server/approval/service');

const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || (e.payload && e.payload.code); } };
const H = 3600000;
const T0 = Date.parse('2026-11-14T10:00:00Z');
const READ = 'plugin::content-manager.explorer.read';

// a tiny model: page with a dynamic zone, a repeatable component, a component, a relation to author
const strapi = {
  contentTypes: {
    'api::page.page': { attributes: {
      title: { type: 'string' }, body: { type: 'blocks' }, note: { type: 'string' },
      sections: { type: 'dynamiczone', components: ['blocks.text', 'blocks.hero'] },
      items: { type: 'component', repeatable: true, component: 'shared.item' },
      seo: { type: 'component', component: 'shared.seo' },
      author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
    } },
    'api::author.author': { attributes: { name: { type: 'string' }, email: { type: 'string' } } },
  },
  components: {
    'blocks.text': { attributes: { body: { type: 'text' } } },
    'blocks.hero': { attributes: { heading: { type: 'string' }, image: { type: 'media' } } },
    'shared.item': { attributes: { label: { type: 'string' }, qty: { type: 'integer' } } },
    'shared.seo': { attributes: { metaTitle: { type: 'string' }, score: { type: 'integer' } } },
  },
};
// a Content Manager-like permission checker: allowed fields as Strapi names them (zones whole, components by leaf)
const pcFor = (fields) => ({
  can: new Proxy({}, { get: () => (e, f) => f === undefined || fields.includes(f) }),
  cannot: new Proxy({}, { get: () => (e, f) => !(f === undefined || fields.includes(f)) }),
});

// ------------------------------------------------------------------ B1 ws_replace over a dynamic zone

test('B1: a ws_replace job on dynamic-zone text is approvable; paths map to permission fields, text leaves only', () => {
  const AP = require('../server/approval/approver');
  const all = ['title', 'body', 'note', 'sections', 'items.label', 'items.qty', 'seo.metaTitle', 'seo.score'];
  const req = (fields) => ({ uid: 'api::page.page', action: 'replace', tool: 'ws_replace', spec: { find: 'a', replace: 'b', fields } });
  assert.deepStrictEqual(AP.permPathsFor(strapi, req(['sections.body', 'items', 'body', 'seo.metaTitle'])).sort(), ['body', 'items.label', 'sections', 'seo.metaTitle']);
  assert.strictEqual(AP.mayActPaths(pcFor(all), req(['sections.body']), AP.permPathsFor(strapi, req(['sections.body']))), true);
  // an Editor without items.qty can still approve a replace on items (qty is not text)
  const editor = all.filter((f) => f !== 'items.qty');
  assert.strictEqual(AP.mayActPaths(pcFor(editor), req(['items']), AP.permPathsFor(strapi, req(['items']))), true);
  assert.strictEqual(AP.mayActPaths(pcFor(all.filter((f) => f !== 'sections')), req(['sections.body']), AP.permPathsFor(strapi, req(['sections.body']))), false);
});

// ------------------------------------------------------------------ B2 approvals need adminTokens 'mcp-only'

test('B2: with adminTokens "any" a job above the automatic tier is refused (approval_needs_mcp_only), nothing stored', async () => {
  const G = require('../server/approval/gate');
  const C = require('../server/approval/control');
  const AT = require('../server/compat/admin-tokens');
  const s = { config: { get: () => ({}) }, contentTypes: { 'api::page.page': { attributes: {} } }, components: {} };
  C.ST.approvalsCfg = { maxDocuments: 50, twoApproverAbove: 20, automaticMax: 4 };
  const job = { contentType: 'api::page.page', action: 'patch', spec: { set: { title: 'x' } }, total: 6 }; // stream E's job row
  const desc = { uid: 'api::page.page', action: 'patch', spec: { set: { title: 'x' } } };
  try {
    assert.strictEqual(AT.mode(), 'any');
    assert.strictEqual(await code(G.gate.beforeCreate(s, { userAbility: { can: () => false } }, {}, job, 6)), 'approval_needs_mcp_only');
    assert.strictEqual(job.state, undefined); // not marked awaiting
    assert.strictEqual(G.gate.dryRunNote(s, desc, 6, {}).approval.needs_mcp_only, true);
    assert.strictEqual(await G.gate.beforeCreate(s, {}, {}, job, 3), null); // automatic tier unchanged
    assert.strictEqual(C.approvalsActive(), false);
  } finally { C.ST.approvalsCfg = undefined; }
});

// ------------------------------------------------------------------ B3 locale-only conditions, leaf masking

test('B3: a read rule whose only condition is the job\'s locale shows samples; other locales or conditions hide them', () => {
  const V = require('../server/approval/view');
  const ab = (conditions) => ({ can: () => true, rulesFor: (a) => (a === READ ? [{ conditions }] : []) });
  const r = { uid: 'api::page.page', locale: 'fr', spec: {}, samples: [{ documentId: 'd', before: { title: 'a' }, after: { title: 'b' } }] };
  assert.strictEqual(V.approverView(ab({ locale: { $in: ['en', 'fr'] } }), r).samples.length, 1);
  assert.strictEqual(V.approverView(ab({ locale: { $in: ['en'] } }), r).samples_hidden, 'conditional_read');
  assert.strictEqual(V.approverView(ab({ locale: { $in: ['fr'] }, 'createdBy.id': 3 }), r).samples_hidden, 'conditional_read');
});

test('B3: component values are masked leaf by leaf', () => {
  const V = require('../server/approval/view');
  const ability = { can: (a, uid, f) => !f || ['title', 'items.label', 'seo.metaTitle'].includes(f), rulesFor: () => [] };
  const r = { uid: 'api::page.page', spec: {}, samples: [{ documentId: 'd', before: { items: [{ id: 1, label: 'a', qty: 7 }], seo: { metaTitle: 'm', score: 9 } }, after: { items: [{ id: 1, label: 'b', qty: 7 }] } }] };
  const v = V.approverView(ability, r);
  assert.strictEqual(v.samples[0].before.items[0].label, 'a');
  assert.strictEqual(v.samples[0].before.items[0].qty, V.HIDDEN);
  assert.strictEqual(v.samples[0].before.seo.metaTitle, 'm');
  assert.strictEqual(v.samples[0].before.seo.score, V.HIDDEN);
});

// ------------------------------------------------------------------ B4 quiet period on credential changes only

function fakeStrapi(user) {
  const kv = new Map();
  return {
    kv,
    user,
    store: { get: async ({ key }) => kv.get(key) || null, set: async ({ key, value }) => { kv.set(key, value); } },
    db: { query: () => ({ findOne: async () => ({ ...user, roles: user.roles.map((id) => ({ id })) }) }) },
  };
}

test('B4: the quiet period counts from the last credential change, not from any profile edit', async () => {
  const CR = require('../server/approval/credentials');
  const s = fakeStrapi({ id: 5, email: 'a@x.test', password: 'hash1', isActive: true, blocked: false, roles: [1], firstname: 'A', createdAt: new Date(T0 - 100 * H).toISOString(), updatedAt: new Date(T0 - 1 * H).toISOString() });
  // first observation: counts from createdAt, not from the recent profile edit
  assert.strictEqual(await CR.credentialsSince(s, 5, T0), T0 - 100 * H);
  s.user.firstname = 'Renamed';
  s.user.preferedLanguage = 'fr';
  assert.strictEqual(await CR.credentialsSince(s, 5, T0 + H), T0 - 100 * H);
  s.user.password = 'hash2';
  assert.strictEqual(await CR.credentialsSince(s, 5, T0 + 2 * H), T0 + 2 * H);
  assert.strictEqual(await CR.credentialsSince(s, 5, T0 + 3 * H), T0 + 2 * H);
  s.user.email = 'b@x.test';
  assert.strictEqual(await CR.credentialsSince(s, 5, T0 + 4 * H), T0 + 4 * H);
  s.user.roles = [1, 2];
  assert.strictEqual(await CR.credentialsSince(s, 5, T0 + 5 * H), T0 + 5 * H);
});

test('B4: decide() uses credentialsSince when given', async () => {
  const st = T.settings({ twoApproverAbove: 20, maxDocuments: 50, approverQuietHours: 24 }, 5);
  const svc = A.create({ store: A.memoryStore(), settings: st, now: () => T0 });
  const { request } = await svc.request({ plan: { planId: 'j', planHash: 'h', uid: 'u', action: 'patch', count: 9 }, requester: { tokenId: '7' }, tier: T.tierFor(9, { action: 'patch' }, st) });
  // profile edited an hour ago, credentials unchanged for 100 h: may approve
  const ok = { id: '2', viaSession: true, mayAct: true, createdAt: new Date(T0 - 100 * H).toISOString(), updatedAt: new Date(T0 - H).toISOString(), credentialsSince: T0 - 100 * H };
  assert.strictEqual((await svc.decide({ requestId: request.requestId, approver: ok, decision: 'approve', planHash: 'h' })).request.status, 'approved');
  const svc2 = A.create({ store: A.memoryStore(), settings: st, now: () => T0 });
  const r2 = (await svc2.request({ plan: { planId: 'j', planHash: 'h', uid: 'u', action: 'patch', count: 9 }, requester: { tokenId: '7' }, tier: T.tierFor(9, { action: 'patch' }, st) })).request;
  assert.strictEqual(await code(svc2.decide({ requestId: r2.requestId, approver: { ...ok, credentialsSince: T0 - 2 * H }, decision: 'approve', planHash: 'h' })), 'approver_changed');
});

// ------------------------------------------------------------------ B5 no "admin API open" hint to the agent

test('B5: instructions and ws_schema mention the admin-token mode only when it is mcp-only', () => {
  const G = require('../server/guidance');
  assert.ok(!/Admin API tokens/.test(G.instructions(['api::page.page'], 'guard', [], [], { adminTokens: 'any' })));
  assert.ok(/work only over MCP/.test(G.instructions(['api::page.page'], 'guard', [], [], { adminTokens: 'mcp-only' })));
  const S = require('../server/schema');
  const fake = { contentTypes: {}, components: {} };
  const AT = require('../server/compat/admin-tokens');
  assert.strictEqual(AT.mode(), 'any');
  const E = require('../server/engine');
  const saved = E.writableUids;
  E.writableUids = () => [];
  try { assert.strictEqual('admin_tokens' in S.listTypes(fake, {}), false); } finally { E.writableUids = saved; }
});

// ------------------------------------------------------------------ B6 retention cursors kept between passes

test('B6: the approval-record sweep resumes from its cursor on the next pass', async () => {
  const RT = require('../server/approval/retention');
  RT.resetCursors();
  const keep = Array.from({ length: 12000 }, (_, i) => ({ id: i + 1, requestId: `k${i}`, planId: `jk${i}`, status: 'rejected', requestedAt: T0 - 100 * H }));
  const gone = Array.from({ length: 100 }, (_, i) => ({ id: 12001 + i, requestId: `g${i}`, planId: `jg${i}`, status: 'rejected', requestedAt: T0 - 100 * H }));
  const rows = [...keep, ...gone];
  const deleted = new Set();
  const match = (r, w) => Object.entries(w).every(([k, v]) => (v && typeof v === 'object' ? ((v.$lt === undefined || r[k] < v.$lt) && (v.$gt === undefined || r[k] > v.$gt)) : r[k] === v));
  const q = (uid) => ({
    findMany: async ({ where, limit }) => (uid.endsWith('approval-request') ? rows.filter((r) => !deleted.has(r.requestId) && match(r, where)).slice(0, limit) : []),
    deleteMany: async ({ where }) => { if (uid.endsWith('approval-request')) deleted.add(where.requestId); return { count: 1 }; },
  });
  const s = { db: { query: q } };
  const exists = async (planId) => planId.startsWith('jk'); // the first 12,000 belong to live jobs
  const p1 = await RT.pruneRecords(s, T0 - 72 * H, exists);
  const p2 = await RT.pruneRecords(s, T0 - 72 * H, exists);
  assert.strictEqual(p1.requests + p2.requests, 100);
});

test('B6: the job sweep (stream E job tables) resumes from its cursor on the next pass', async () => {
  const RET = require('../server/retention');
  const RT = require('../server/approval/retention');
  RT.resetCursors();
  RET.resetCursors();
  RET.configure({ keyHours: 0, claimMinutes: 0, jobHours: 1 });
  const old = new Date(Date.now() - 10 * H);
  const jobs = [];
  // 4,100 jobs waiting for a live request (kept), then one finished job: a pass reads 20 pages of 200
  for (let i = 1; i <= 4100; i += 1) jobs.push({ id: i, jobId: `j${i}`, state: 'awaiting_approval', approval: { request_id: `ar${i}` }, updatedAt: old, total: 1, cursor: 0 });
  jobs.push({ id: 4101, jobId: 'jdone', state: 'done', updatedAt: old, total: 1, cursor: 1 });
  const match = (r, w) => Object.entries(w).every(([k, v]) => (v && typeof v === 'object' && !(v instanceof Date)
    ? (v.$lt === undefined || r[k] < v.$lt) && (v.$gt === undefined || r[k] > v.$gt) : r[k] === v));
  const q = (uid) => ({
    findMany: async ({ where, limit }) => (uid === 'plugin::writesafe.bulk-job' ? jobs.filter((r) => match(r, where)).slice(0, limit) : []),
    findOne: async ({ where }) => (uid.endsWith('approval-request') ? { requestId: where.requestId, status: 'pending', expiresAt: Date.now() + H, requestedAt: Date.now() } : null),
    deleteMany: async ({ where }) => {
      if (uid !== 'plugin::writesafe.bulk-job') return { count: 0 };
      const i = jobs.findIndex((r) => match(r, where));
      if (i < 0) return { count: 0 };
      jobs.splice(i, 1);
      return { count: 1 };
    },
  });
  const s = { db: { query: q, transaction: (fn) => fn() }, contentTypes: { 'plugin::writesafe.bulk-job': {} }, config: { get: () => ({}) }, log: { warn() {}, info() {} } };
  const a = await RET.prune(s);
  const b = await RET.prune(s);
  assert.strictEqual(a.jobs + b.jobs, 1, JSON.stringify([a, b]));
  RET.configure({});
});

// ------------------------------------------------------------------ B7 filter paths through relations

test('B7: a filter through a relation is checked against the related type\'s read permission; only that part is hidden', () => {
  const V = require('../server/approval/view');
  const ability = { can: (a, uid, f) => (uid === 'api::author.author' ? f !== 'email' : true), rulesFor: () => [] };
  const r = { uid: 'api::page.page', spec: {}, samples: [], filter: { $and: [{ title: { $startsWith: 'a' } }, { author: { email: { $eq: 'secret@x.test' } } }] } };
  const v = V.approverView(ability, r, (uid) => strapi.contentTypes[uid] || strapi.components[uid]);
  assert.ok(v.filter_summary.includes('"$startsWith":"a"'), v.filter_summary);
  assert.ok(!v.filter_summary.includes('secret@x.test'), v.filter_summary);
  const ok = V.approverView(ability, { ...r, filter: { author: { name: { $eq: 'Ann' } } } }, (uid) => strapi.contentTypes[uid] || strapi.components[uid]);
  assert.ok(ok.filter_summary.includes('Ann'));
});

test('B4: a credential change is dated when it happens (admin::user lifecycles), even for an admin first seen later', async () => {
  const CR = require('../server/approval/credentials');
  const s = fakeStrapi({ id: 9, email: 'v@x.test', password: 'h1', isActive: true, blocked: false, roles: [1], createdAt: new Date(T0 - 2 * H).toISOString() });
  const subs = [];
  s.db.lifecycles = { subscribe: (x) => subs.push(x) };
  CR.subscribe(s);
  assert.deepStrictEqual(subs[0].models, ['admin::user']);
  await subs[0].afterCreate({ result: { id: 9 } });          // created: dated from createdAt
  s.user.password = 'h2';
  await subs[0].afterUpdate({ result: { id: 9 } });           // password change: dated now
  const since = await CR.credentialsSince(s, 9, T0 + 50 * H);
  assert.ok(since > T0 - 2 * H, `${since}`);
});

test('rebase onto B: the runner reads B\'s bulk.chunkTimeMs through the adapter, and refuses an engine without it', () => {
  const U = require('../server/modules/_bulk/util');
  const AD = require('../server/runner/adapter');
  assert.ok(Object.prototype.hasOwnProperty.call(U.DEFAULTS.bulk, 'chunkTimeMs'), 'stream B setting present');
  const s = (bulk) => ({ config: { get: () => (bulk ? { bulk } : {}) } });
  assert.strictEqual(AD.chunkTimeMs(s()), U.DEFAULTS.bulk.chunkTimeMs);
  assert.strictEqual(AD.chunkTimeMs(s({ chunkTimeMs: 2500 })), 2500);
  assert.strictEqual(AD.chunkTimeMs(s({ chunkTimeMs: 0 })), null);
  const saved = U.DEFAULTS.bulk.chunkTimeMs;
  delete U.DEFAULTS.bulk.chunkTimeMs;
  try { assert.throws(() => AD.chunkTimeMs(s()), /chunkTimeMs is missing/); } finally { U.DEFAULTS.bulk.chunkTimeMs = saved; }
});
