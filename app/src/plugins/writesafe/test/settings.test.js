'use strict';

// The Settings page API (server/settings): tighten-only runtime overrides, the effective-config view with sources,
// the controller (stale saves, refused loosening), the routes' policies and the hooks in control.js and media.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../server/approval/tiers');
const O = require('../server/settings/overrides');
const V = require('../server/settings/view');
const S = require('../server/settings');

const FILE = (approvals = {}, allow = ['images.example.com', 'cdn.example.org/assets/']) => ({ approvals: T.settings(approvals, 5000), mediaAllow: allow });
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || e.message; } };

function fakeStrapi(cfg = {}, store = new Map()) {
  const logs = [];
  return {
    logs,
    store: {
      get: async (k) => { if (store.fail) throw new Error('db down'); return store.get(k.key); },
      set: async (k) => { store.set(k.key, JSON.parse(JSON.stringify(k.value))); },
    },
    config: { get: (k) => (k === 'plugin::writesafe' ? cfg : undefined) },
    log: { warn: (m) => logs.push(['warn', m]), info: (m) => logs.push(['info', m]), error: (m) => logs.push(['error', m]) },
  };
}

test('overrides: only the tighten-only keys, never looser than the config file, no-ops dropped', () => {
  const f = FILE();
  assert.deepStrictEqual(O.validate({
    'approvals.escalate.publish': true, 'approvals.escalate.relations': false, 'approvals.requesterMayApprove': false,
    'approvals.maxDocuments': 1000, 'approvals.twoApproverAbove': 20000, 'approvals.approverQuietHours': 48, 'media.disabled': ['images.example.com'],
  }, f), { 'approvals.escalate.publish': true, 'approvals.requesterMayApprove': false, 'approvals.maxDocuments': 1000, 'approvals.approverQuietHours': 48, 'media.disabled': ['images.example.com'] });
  // loosening, unknown keys, bad types, hard limits
  assert.strictEqual(code(() => O.validate({ 'approvals.maxDocuments': 20001 }, f)), 'invalid_override');
  assert.match(code(() => { try { O.validate({ 'approvals.maxDocuments': 20001 }, f); } catch (e) { throw new Error(e.message); } }), /only be lowered/);
  assert.strictEqual(code(() => O.validate({ 'approvals.approverQuietHours': 1 }, f)), 'invalid_override');
  assert.strictEqual(code(() => O.validate({ 'approvals.approverQuietHours': 721 }, f)), 'invalid_override');
  assert.strictEqual(code(() => O.validate({ 'approvals.automaticMax': 5001 }, f)), 'invalid_override');
  assert.strictEqual(code(() => O.validate({ 'approvals.maxDocuments': 0 }, f)), 'invalid_override');
  assert.strictEqual(code(() => O.validate({ 'approvals.maxDocuments': '10' }, f)), 'invalid_override');
  assert.strictEqual(code(() => O.validate({ 'approvals.enabled': false }, f)), 'invalid_override', 'enabled is not tighten-only (off refuses, but on would allow bigger jobs)');
  for (const k of ['allowForce', 'builtinUpdates', 'adminTokens', 'modules.bulk', 'media.allow', 'bulk.maxDocuments']) assert.strictEqual(code(() => O.validate({ [k]: false }, f)), 'invalid_override', k);
  assert.strictEqual(code(() => O.validate({ 'media.disabled': ['evil.example'] }, f)), 'invalid_override', 'hosts cannot be added');
  assert.strictEqual(code(() => O.validate({ 'approvals.escalate.publish': 'yes' }, f)), 'invalid_override');
  assert.strictEqual(code(() => O.validate([], f)), 'invalid_override');
  // a setting already strict in the file cannot be loosened at runtime
  const strictFile = FILE({ escalate: { publish: true }, requesterMayApprove: false });
  assert.strictEqual(code(() => O.validate({ 'approvals.escalate.publish': false }, strictFile)), 'invalid_override');
  assert.strictEqual(code(() => O.validate({ 'approvals.requesterMayApprove': true }, strictFile)), 'invalid_override');
  assert.deepStrictEqual(O.validate({ 'approvals.escalate.publish': true, 'approvals.maxDocuments': null }, strictFile), {});
});

test('overrides: the merge never loosens, whatever is stored (random file settings and stored garbage)', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const junk = [undefined, null, true, false, -5, 0, 3, 99999999, 1.5, 'x', [], {}, NaN];
  for (let i = 0; i < 2000; i += 1) {
    const bulkMax = 1 + rnd(9000);
    const maxDocuments = 1 + rnd(100000);
    const s = T.settings({ enabled: rnd(4) !== 0, maxDocuments, twoApproverAbove: rnd(50001), automaticMax: rnd(bulkMax + 1), approverQuietHours: rnd(721),
      requesterMayApprove: rnd(2) === 1, escalate: { publish: rnd(2) === 1, relations: rnd(2) === 1 } }, bulkMax);
    const stored = {};
    for (const k of Object.keys(O.SPEC)) if (rnd(2)) stored[k] = rnd(3) ? junk[rnd(junk.length)] : rnd(120000);
    const r = O.approvals(s, stored);
    assert.ok(r.automaticMax <= s.automaticMax && r.maxDocuments <= s.maxDocuments && r.twoApproverAbove <= s.twoApproverAbove, JSON.stringify({ s, stored, r }));
    assert.ok(r.approverQuietHours >= s.approverQuietHours && r.approverQuietHours <= T.HARD.approverQuietHoursMax);
    assert.ok(r.escalate.publish >= s.escalate.publish && r.escalate.relations >= s.escalate.relations);
    assert.ok(!r.requesterMayApprove || s.requesterMayApprove);
    assert.strictEqual(r.enabled, s.enabled);
    // approvals off in the file: only automaticMax is enforced, so nothing else is applied (or shown as tightened)
    if (!s.enabled) assert.deepStrictEqual({ ...r, automaticMax: s.automaticMax }, s, JSON.stringify({ s, stored, r }));
    // every job gets a tier at least as strict as with the file alone
    const rank = { automatic: 0, one: 1, two: 2, refused: 3 };
    for (const n of [0, 1, r.automaticMax, r.automaticMax + 1, s.automaticMax + 1, r.twoApproverAbove + 1, r.maxDocuments + 1, s.maxDocuments, 50001]) {
      for (const op of [{ action: 'patch' }, { action: 'publish' }, { action: 'patch', relations: true }]) {
        assert.ok(rank[T.tierFor(n, op, r).tier] >= rank[T.tierFor(n, op, s).tier], `count ${n} ${JSON.stringify(op)}`);
      }
    }
  }
  const s = T.settings({}, 5000);
  assert.strictEqual(O.approvals(s, {}), s, 'no overrides: the very same object');
  assert.deepStrictEqual(O.approvals(s, { 'approvals.automaticMax': 100, 'approvals.twoApproverAbove': 10 }).twoApproverAbove, 100, 'tiers stay ordered');
});

test('overrides: media allowlist entries can be switched off, never added', () => {
  assert.deepStrictEqual(O.mediaAllow(['a.example', 'b.example'], { 'media.disabled': ['a.example', 'zzz'] }), ['b.example']);
  assert.deepStrictEqual(O.mediaAllow(undefined, {}), []);
  assert.deepStrictEqual(O.mediaAllow(['a.example'], { 'media.disabled': 'a.example' }), ['a.example'], 'garbage is ignored');
});

test('overrides: load/save through the plugin store; a store that cannot be read keeps the last values', async () => {
  const store = new Map();
  const st = fakeStrapi({}, store);
  await O.load(st);
  assert.deepStrictEqual(O.state().values, {});
  await O.save(st, { 'approvals.escalate.publish': true }, 'Dana Admin (1)');
  assert.deepStrictEqual(store.get('settings-overrides').values, { 'approvals.escalate.publish': true });
  assert.ok(st.logs.some(([l, m]) => l === 'warn' && /Dana Admin \(1\)/.test(m)), 'audited in the log');
  store.fail = true;
  await O.load(st);
  assert.deepStrictEqual(O.state().values, { 'approvals.escalate.publish': true }, 'kept');
  store.fail = false;
  await O.save(st, {}, 'Dana Admin (1)');
  assert.strictEqual(O.state().log.length, 2);
  assert.deepStrictEqual(O.state().values, {});
});

test('control.approvalSettings and media settings apply the overrides', () => {
  const C = require('../server/approval/control');
  const st = fakeStrapi({ approvals: { maxDocuments: 9000 }, media: { allow: ['a.example', 'b.example'] } });
  C.ST.approvalsCfg = { maxDocuments: 9000 };
  O.setForTests({ 'approvals.maxDocuments': 300, 'approvals.escalate.relations': true, 'media.disabled': ['a.example'] });
  try {
    const s = C.approvalSettings(st);
    assert.strictEqual(s.maxDocuments, 300);
    assert.strictEqual(s.escalate.relations, true);
    const M = require('../server/modules/media');
    assert.deepStrictEqual(M.settings(st).rules.map((r) => r.host), ['b.example']);
  } finally {
    O.setForTests({});
    C.ST.approvalsCfg = undefined;
  }
});

const control = (over = {}) => ({
  approvalSettings: () => O.approvals(T.settings(over.approvals, 5000)),
  runnerSettings: () => ({ enabled: false, workers: 1, pollMs: 2000, leaseMs: 60000, heartbeatMs: 15000, chunkPauseMs: 250, killSwitch: false }),
  runnerActive: () => false,
  approvalsState: () => ({ active: false, reason: 'needs_mcp_only' }),
  killSwitchState: async () => ({ on: false, config: false }),
});
const deps = (cfg, user) => ({ control: control(cfg), user, modulesOn: ['find', 'history', 'bulk'], killSwitch: { on: false, config: false }, retention: require('../server/retention').DEFAULTS });
const rowsOf = (v) => Object.fromEntries(v.sections.flatMap((s) => s.rows).map((r) => [r.key, r]));

test('view: every value with its source: config file, default, derived, tightened here', async () => {
  const cfg = { builtinUpdates: 'guard', modules: { bulk: true }, approvals: { maxDocuments: 9000 }, media: { allow: ['a.example', 'b.example'] } };
  const user = { modules: { bulk: true }, approvals: { maxDocuments: 9000 }, media: { allow: ['a.example', 'b.example'] } };
  O.setForTests({ 'approvals.escalate.publish': true, 'media.disabled': ['b.example'] });
  try {
    const v = await V.build(fakeStrapi(cfg), deps(cfg, user));
    const r = rowsOf(v);
    assert.deepStrictEqual(v.sections.map((s) => s.id), ['agents', 'tokens', 'modules', 'approvals', 'bulk', 'runner', 'media', 'history', 'retention']);
    assert.deepStrictEqual([r.builtinUpdates.value, r.builtinUpdates.source], ['guard', 'default']);
    assert.deepStrictEqual([r.allowForce.value, r.allowForce.source], [false, 'derived']);
    assert.deepStrictEqual([r['approvals.automaticMax'].value, r['approvals.automaticMax'].source], [5000, 'derived']);
    assert.deepStrictEqual([r['approvals.maxDocuments'].value, r['approvals.maxDocuments'].source, r['approvals.maxDocuments'].hard], [9000, 'config', 100000]);
    assert.deepStrictEqual([r['approvals.escalate.publish'].value, r['approvals.escalate.publish'].source, r['approvals.escalate.publish'].file], [true, 'runtime', false]);
    assert.deepStrictEqual([r['media.allow'].value, r['media.allow'].source, r['media.allow'].file], [['a.example'], 'runtime', ['a.example', 'b.example']]);
    assert.deepStrictEqual([r['modules.bulk'].value, r['modules.bulk'].source], [true, 'config']);
    assert.deepStrictEqual([r['modules.history'].value, r['modules.history'].source, r['modules.history'].default_on], [true, 'default', true]);
    assert.deepStrictEqual([r['modules.media'].value, r['modules.media'].source], [false, 'default']);
    assert.strictEqual(r['bulk.maxDocuments'].value, 5000);
    assert.strictEqual(v.provenance, 'files');
    assert.deepStrictEqual(v.media_file_allow, ['a.example', 'b.example']);
    // config files not readable: honest about it
    const u = rowsOf(await V.build(fakeStrapi(cfg), deps(cfg, null)));
    assert.strictEqual(u.builtinUpdates.source, 'config or default');
  } finally {
    O.setForTests({});
  }
});

test('view: reads writesafe.config from the app config files the way Strapi does (base, then env)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-settings-'));
  fs.mkdirSync(path.join(dir, 'env', 'production'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins.js'), "module.exports = ({ env }) => ({ writesafe: { enabled: true, config: { adminTokens: env('WS_TEST_TOKENS', 'any'), modules: { bulk: true } } } });");
  fs.writeFileSync(path.join(dir, 'env', 'production', 'plugins.js'), 'module.exports = { writesafe: { config: { modules: { media: true } } } };');
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.deepStrictEqual(V.userConfig({ dirs: { dist: { config: dir } } }), { adminTokens: 'any', modules: { bulk: true, media: true } });
    assert.strictEqual(V.userConfig({ dirs: { dist: { config: path.join(dir, 'missing') } } }).constructor, Object);
    assert.strictEqual(V.userConfig({}), null);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes: admin session only (no admin API tokens) and the settings.read / settings.update actions', () => {
  assert.strictEqual(S.routes.type, 'admin');
  const [g, p] = S.routes.routes;
  assert.deepStrictEqual([g.method, g.path, g.handler], ['GET', '/settings', 'settings.get']);
  assert.deepStrictEqual([p.method, p.path, p.handler], ['PUT', '/settings/overrides', 'settings.update']);
  for (const [r, action] of [[g, 'plugin::writesafe.settings.read'], [p, 'plugin::writesafe.settings.update']]) {
    assert.ok(r.config.policies.includes('plugin::writesafe.session-only'));
    assert.ok(r.config.policies.includes('admin::isAuthenticatedAdmin'));
    assert.deepStrictEqual(r.config.policies.find((x) => x.name === 'admin::hasPermissions').config.actions, [action]);
  }
  const server = require('../strapi-server');
  assert.strictEqual(server.routes.settings, S.routes);
  assert.ok(server.routes.admin && server.controllers.jobs, 'the jobs page API is still there');
  assert.strictEqual(server.controllers.settings, S.controller);
});

test('bootstrap: registers the two settings actions and loads the overrides', async () => {
  const store = new Map([['settings-overrides', { values: { 'approvals.escalate.publish': true }, by: 'x', at: 1 }]]);
  const st = fakeStrapi({}, store);
  let actions = null;
  st.admin = { services: { permission: { actionProvider: { registerMany: async (a) => { actions = a; } } } } };
  await S.bootstrap(st);
  S.stop();
  assert.deepStrictEqual(actions.map((a) => [a.section, a.uid, a.pluginName]), [['settings', 'settings.read', 'writesafe'], ['settings', 'settings.update', 'writesafe']]);
  assert.deepStrictEqual(O.state().values, { 'approvals.escalate.publish': true });
  O.setForTests({});
});

test('controller: saves a tightening, refuses loosening (400) and a stale page (409)', async () => {
  const store = new Map();
  const cfg = { approvals: { maxDocuments: 9000 }, media: { allow: ['a.example'] } };
  global.strapi = fakeStrapi(cfg, store);
  const C = require('../server/approval/control');
  const saved = { approvalSettings: C.approvalSettings };
  const ctx = (body) => ({ request: { body }, state: { user: { id: 3, firstname: 'Dana', lastname: 'Admin' } }, status: 200, body: null });
  try {
    await O.load(global.strapi);
    let c = ctx({ values: { 'approvals.maxDocuments': 20000 }, based_on: null });
    await S.controller.update(c);
    assert.deepStrictEqual([c.status, c.body.error.code], [400, 'invalid_override']);
    assert.strictEqual(store.size, 0, 'nothing stored');
    // GET/PUT go through view.build, which needs the real modules; stub the parts that need a running Strapi
    const V2 = require('../server/settings/view');
    const build = V2.build;
    V2.build = async () => ({ sections: [] });
    try {
      c = ctx({ values: { 'approvals.maxDocuments': 100 }, based_on: null });
      await S.controller.update(c);
      assert.strictEqual(c.status, 200);
      assert.deepStrictEqual(store.get('settings-overrides').values, { 'approvals.maxDocuments': 100 });
      assert.strictEqual(store.get('settings-overrides').by, 'Dana Admin (3)');
      // no name: the username, never the email (the history and the log are shown to read-only admins)
      const anon = { request: { body: { values: { 'approvals.maxDocuments': 90 }, based_on: O.state().at } }, state: { user: { id: 4, email: 'x@example.test', username: 'ops' } }, status: 200, body: null };
      await S.controller.update(anon);
      assert.strictEqual(store.get('settings-overrides').by, 'ops (4)');
      const noName = { request: { body: { values: { 'approvals.maxDocuments': 80 }, based_on: O.state().at } }, state: { user: { id: 5, email: 'y@example.test' } }, status: 200, body: null };
      await S.controller.update(noName);
      assert.strictEqual(store.get('settings-overrides').by, 'admin (5)');
      assert.ok(!JSON.stringify(store.get('settings-overrides')).includes('@example.test'), 'no email stored');
      c = ctx({ values: {}, based_on: null });
      await S.controller.update(c);
      assert.deepStrictEqual([c.status, c.body.error.code], [409, 'stale']);
      c = ctx({ values: {}, based_on: O.state().at });
      await S.controller.update(c);
      assert.strictEqual(c.status, 200);
      assert.deepStrictEqual(store.get('settings-overrides').values, {});
    } finally {
      V2.build = build;
    }
  } finally {
    Object.assign(C, saved);
    O.setForTests({});
    delete global.strapi;
  }
});

test('overrides: inherited names are not settings; two approvers cannot sit below the automatic limit', () => {
  const f = FILE({ automaticMax: 4, twoApproverAbove: 8, maxDocuments: 40 });
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.strictEqual(code(() => O.validate(JSON.parse(`{"${k}": 5}`), f)), 'invalid_override', k);
  }
  assert.deepStrictEqual(O.approvals(f.approvals, { constructor: 1, toString: 2 }), f.approvals, 'stored inherited names change nothing');
  assert.strictEqual(code(() => O.validate({ 'approvals.twoApproverAbove': 2 }, f)), 'invalid_override', 'below the file automaticMax');
  assert.deepStrictEqual(O.validate({ 'approvals.automaticMax': 2, 'approvals.twoApproverAbove': 2 }, f), { 'approvals.automaticMax': 2, 'approvals.twoApproverAbove': 2 });
  assert.strictEqual(code(() => O.validate({ 'approvals.automaticMax': 3, 'approvals.twoApproverAbove': 2 }, f)), 'invalid_override');
  // a tampered stored value below the minimum is held at the minimum
  const r = O.approvals(f.approvals, { 'approvals.automaticMax': -7, 'approvals.maxDocuments': -1, 'approvals.twoApproverAbove': -3 });
  assert.deepStrictEqual([r.automaticMax, r.maxDocuments, r.twoApproverAbove], [0, 1, 0]);
});

test('overrides: a stored entry with a missing or invalid time neither stops startup nor breaks the page', async () => {
  const store = new Map([['settings-overrides', { values: { 'approvals.escalate.publish': true }, by: 'x', at: 'garbage', log: [{ by: 'y' }, null, 'z', { by: 'w', at: 5 }, { by: 'v', at: 1e300 }] }]]);
  const st = fakeStrapi({}, store);
  await O.start(st);
  O.stop();
  const s = O.state();
  assert.strictEqual(s.at, null);
  assert.deepStrictEqual(s.values, { 'approvals.escalate.publish': true });
  assert.deepStrictEqual(s.log.map((e) => [e.by, e.at]), [['v', null], ['w', new Date(5).toISOString()]]);
  store.set('settings-overrides', { values: [1], by: { x: 1 }, at: 3, log: 'nope' });
  await O.load(st);
  assert.deepStrictEqual([O.state().values, O.state().by, O.state().log], [{}, null, []]);
  await O.save(st, {}, 'Dana\nAdmin (1)');
  assert.ok(st.logs.some(([l, m]) => l === 'warn' && m.includes('"Dana\\nAdmin (1)"')), 'the name is quoted in the log line');
  O.setForTests({});
});

test('view: an approval value adjusted to fit the other limits is shown as derived, with the value before', async () => {
  // defaults: twoApproverAbove 25,000 is held at maxDocuments (9,000 here)
  const cfg = { approvals: { maxDocuments: 9000 } };
  let r = rowsOf(await V.build(fakeStrapi(cfg), deps(cfg, { approvals: { maxDocuments: 9000 } })));
  assert.deepStrictEqual([r['approvals.twoApproverAbove'].value, r['approvals.twoApproverAbove'].source, r['approvals.twoApproverAbove'].adjusted], [9000, 'derived', { from: 25000, source: 'default' }]);
  assert.strictEqual(r['approvals.maxDocuments'].adjusted, undefined);
  // configured below automaticMax: raised to it
  const cfg2 = { approvals: { automaticMax: 50, twoApproverAbove: 10 } };
  r = rowsOf(await V.build(fakeStrapi(cfg2), deps(cfg2, cfg2)));
  assert.deepStrictEqual([r['approvals.twoApproverAbove'].value, r['approvals.twoApproverAbove'].source, r['approvals.twoApproverAbove'].adjusted], [50, 'derived', { from: 10, source: 'config' }]);
  assert.deepStrictEqual([r['approvals.automaticMax'].source, r['approvals.automaticMax'].adjusted], ['config', undefined]);
  // tightened at runtime: still "runtime", with the adjustment noted
  O.setForTests({ 'approvals.maxDocuments': 100 });
  try {
    r = rowsOf(await V.build(fakeStrapi(cfg), deps(cfg, { approvals: { maxDocuments: 9000 } })));
    assert.deepStrictEqual([r['approvals.twoApproverAbove'].value, r['approvals.twoApproverAbove'].source], [9000, 'derived']);
    assert.deepStrictEqual([r['approvals.maxDocuments'].value, r['approvals.maxDocuments'].source, r['approvals.maxDocuments'].file], [100, 'runtime', 9000]);
  } finally {
    O.setForTests({});
  }
});

test('session-only policy: only an admin panel session passes (admin API tokens, transfer tokens and odd states fail)', () => {
  const server = require('../strapi-server');
  const p = server.policies['session-only'];
  assert.strictEqual(typeof p, 'function');
  const user = { id: 1 };
  const st = (auth, u) => ({ state: { auth, user: u } });
  assert.strictEqual(p(st({ strategy: { name: 'admin' } }, user)), true);
  for (const [label, ctx] of [
    ['admin API token', st({ strategy: { name: 'admin-token' } }, user)], ['transfer token', st({ strategy: { name: 'data-transfer' } }, user)],
    ['api token', st({ strategy: { name: 'api-token' } }, user)], ['no auth', st(undefined, user)], ['no strategy', st({}, user)],
    ['session without a user', st({ strategy: { name: 'admin' } }, undefined)], ['no state', {}],
  ]) assert.strictEqual(p(ctx), false, label);
});

test('gate.ceiling: a dry run reports the limit the Settings page tightened, as a start applies it', () => {
  const C = require('../server/approval/control');
  const { gate } = require('../server/approval/gate');
  C.ST.approvalsCfg = { maxDocuments: 9000 };
  try {
    assert.strictEqual(gate.ceiling({ maxDocuments: 5000 }), 9000);
    O.setForTests({ 'approvals.maxDocuments': 300 });
    assert.strictEqual(gate.ceiling({ maxDocuments: 5000 }), 300);
  } finally {
    O.setForTests({});
    C.ST.approvalsCfg = undefined;
  }
});

test('controller: based_on is required (a save cannot skip the stale-page check)', async () => {
  global.strapi = fakeStrapi({}, new Map());
  try {
    const c = { request: { body: { values: {} } }, state: { user: { id: 3 } }, status: 200, body: null };
    await S.controller.update(c);
    assert.deepStrictEqual([c.status, c.body.error.code], [400, 'invalid_override']);
    assert.match(c.body.error.message, /based_on is required/);
  } finally {
    delete global.strapi;
  }
});

test('overrides: with approvals off in the config file only automaticMax can be tightened (the rest would not run)', () => {
  const f = FILE({ enabled: false });
  assert.deepStrictEqual(O.validate({ 'approvals.automaticMax': 100, 'media.disabled': ['images.example.com'] }, f), { 'approvals.automaticMax': 100, 'media.disabled': ['images.example.com'] });
  for (const [k, v] of [['approvals.escalate.publish', true], ['approvals.escalate.relations', true], ['approvals.requesterMayApprove', false],
    ['approvals.maxDocuments', 10], ['approvals.twoApproverAbove', 4000], ['approvals.approverQuietHours', 48]]) {
    let err;
    try { O.validate({ [k]: v }, f); } catch (e) { err = e; }
    assert.ok(err && err.code === 'invalid_override' && /approvals are off/.test(err.message), k);
  }
  // a stored value saved while approvals were on is not applied (or shown) once the file turns them off
  const s = T.settings({ enabled: false }, 5000);
  const r = O.approvals(s, { 'approvals.escalate.publish': true, 'approvals.maxDocuments': 10, 'approvals.automaticMax': 7 });
  assert.deepStrictEqual([r.escalate.publish, r.maxDocuments, r.automaticMax], [false, s.maxDocuments, 7]);
  assert.strictEqual(T.ceiling(r), 7);
});

test('overrides: a store that cannot be read at startup is logged as an error (the file values run until a re-read)', async () => {
  const store = new Map();
  store.fail = true;
  const st = fakeStrapi({}, store);
  // a fresh copy of the module (ST.loaded is per process); the original goes back into the cache afterwards
  const id = require.resolve('../server/settings/overrides');
  const orig = require.cache[id];
  delete require.cache[id];
  const O2 = require('../server/settings/overrides');
  try {
    await O2.load(st);
    assert.ok(st.logs.some(([l, m]) => l === 'error' && /at startup/.test(m)), JSON.stringify(st.logs));
    store.fail = false;
    await O2.load(st);
    store.fail = true;
    st.logs.length = 0;
    await O2.load(st);
    assert.ok(st.logs.some(([l]) => l === 'warn') && !st.logs.some(([l]) => l === 'error'), 'later failures warn once');
  } finally {
    require.cache[id] = orig;
  }
});

test('view: media.allow entries that would not parse and could hold a secret (module off, so not validated) are hidden', async () => {
  const cfg = { media: { allow: ['a.example', 'https://user:secret@b.example.com/', 'https://c.example/x?q=1', 'cdn.example.org/assets/'] } };
  const v = await V.build(fakeStrapi(cfg), deps(cfg, cfg));
  const r = rowsOf(v);
  assert.ok(!JSON.stringify(v).includes('secret') && !JSON.stringify(v).includes('q=1'), JSON.stringify(r['media.allow']));
  assert.deepStrictEqual(r['media.allow'].value, ['a.example', '(invalid entry hidden)', '(invalid entry hidden)', 'cdn.example.org/assets/']);
  assert.deepStrictEqual(v.media_file_allow, ['a.example', 'cdn.example.org/assets/']);
});
