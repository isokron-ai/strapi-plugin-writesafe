'use strict';

// 1.0 unit tests: baseVersion adapter (with a stub Document Service), built-in tool rewrite, module registry,
// compat report, blocks key scope, lenient arguments. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { errors } = require('@strapi/utils');
const BV = require('../server/compat/base-version');
const MCP = require('../server/compat/mcp');
const C = require('../server/compat');
const G = require('../server/guidance');
const MOD = require('../server/modules');
const M = require('../server/model');
const CFG = require('../server/config');

class ConflictError extends errors.ApplicationError {
  constructor(message, details) { super(message, details); this.name = 'ConflictError'; }
}
// #27506 adds errors.ConflictError to @strapi/utils; the adapter only probes when it is there.
const withConflictError = async (fn) => {
  const had = errors.ConflictError;
  errors.ConflictError = ConflictError;
  try { return await fn(); } finally { if (had) errors.ConflictError = had; else delete errors.ConflictError; }
};

/** A stub Strapi whose Document Service behaves like strapi/strapi#27506 (or like 5.62.0 when withBaseVersion=false). */
function stubStrapi({ withBaseVersion, rowUpdatedAt = '2026-11-13T10:00:00.000Z', strictParams = false }) {
  const calls = [];
  const strapi = {
    contentTypes: { 'api::page.page': { uid: 'api::page.page', kind: 'collectionType', options: { draftAndPublish: true }, attributes: {} } },
    config: { get: () => undefined },
    db: { transaction: async (fn) => fn() },
    documents: () => ({
      async update(params) {
        calls.push(params);
        if ('baseVersion' in params) {
          if (!withBaseVersion) {
            if (strictParams) throw new errors.ValidationError('Invalid key baseVersion');
            // 5.62.0 without strictParams: unknown root keys are ignored
          } else {
            const bv = params.baseVersion;
            const d = typeof bv === 'string' && bv ? new Date(bv) : undefined;
            if (!d || Number.isNaN(d.getTime()) || d.toISOString() !== bv) throw new errors.ValidationError('baseVersion must be a valid ISO timestamp');
            if (bv !== rowUpdatedAt) throw new ConflictError('The document has changed since it was loaded', { expected: bv, current: rowUpdatedAt });
          }
        }
        if (params.documentId === '__writesafe_probe_does_not_exist__') return null;
        return { documentId: params.documentId, updatedAt: rowUpdatedAt };
      },
    }),
  };
  return { strapi, calls };
}

test('baseVersion: detected on a Strapi with the #27506 check, and passed through on draft & publish writes', async () => {
  const { strapi, calls } = stubStrapi({ withBaseVersion: true });
  const st = await withConflictError(() => BV.detect(strapi, 'auto'));
  assert.strictEqual(st.supported, true);
  calls.length = 0;
  await BV.update(strapi, 'api::page.page', { documentId: 'd1', data: { title: 'x' } }, { baseVersion: '2026-11-13T10:00:00.000Z', draftAndPublish: true });
  assert.strictEqual(calls[0].baseVersion, '2026-11-13T10:00:00.000Z');
  // no draft & publish: never passed (Strapi ignores it there anyway)
  await BV.update(strapi, 'api::page.page', { documentId: 'd1', data: {} }, { baseVersion: '2026-11-13T10:00:00.000Z', draftAndPublish: false });
  assert.ok(!('baseVersion' in calls[1]));
});

test("baseVersion: Strapi's ConflictError becomes BaseVersionConflict (mapped to version_conflict by the engine)", async () => {
  const { strapi } = stubStrapi({ withBaseVersion: true, rowUpdatedAt: '2026-11-13T10:00:05.000Z' });
  await withConflictError(() => BV.detect(strapi, 'auto'));
  await assert.rejects(
    BV.update(strapi, 'api::page.page', { documentId: 'd1', data: {} }, { baseVersion: '2026-11-13T10:00:00.000Z', draftAndPublish: true }),
    (e) => e instanceof BV.BaseVersionConflict && e.details.current === '2026-11-13T10:00:05.000Z',
  );
  assert.ok(BV.isConflictError(new ConflictError('x')));
  assert.ok(!BV.isConflictError(new errors.ValidationError('x')));
});

test('baseVersion: on 5.62.0 (no ConflictError in @strapi/utils) the probe never calls the Document Service', async () => {
  const { strapi, calls } = stubStrapi({ withBaseVersion: true });
  const had = errors.ConflictError;
  delete errors.ConflictError;
  try {
    const st = await BV.detect(strapi, 'auto');
    assert.strictEqual(st.supported, false);
    assert.strictEqual(calls.length, 0);
  } finally { if (had) errors.ConflictError = had; }
});

test('baseVersion: disable() turns the passthrough off at runtime', async () => {
  const { strapi, calls } = stubStrapi({ withBaseVersion: true });
  await withConflictError(() => BV.detect(strapi, 'auto'));
  BV.disable('test');
  calls.length = 0;
  await BV.update(strapi, 'api::page.page', { documentId: 'd1', data: {} }, { baseVersion: '2026-11-13T10:00:00.000Z', draftAndPublish: true });
  assert.ok(!('baseVersion' in calls[0]));
  assert.strictEqual(BV.state.supported, false);
});

test('baseVersion: not detected when the key is ignored, nor with strictParams; never passed then', async () => {
  for (const strictParams of [false, true]) {
    const { strapi, calls } = stubStrapi({ withBaseVersion: false, strictParams });
    const st = await withConflictError(() => BV.detect(strapi, 'auto'));
    assert.strictEqual(st.supported, false, `strictParams=${strictParams}`);
    calls.length = 0;
    await BV.update(strapi, 'api::page.page', { documentId: 'd1', data: {} }, { baseVersion: '2026-11-13T10:00:00.000Z', draftAndPublish: true });
    assert.ok(!('baseVersion' in calls[0]));
  }
});

test("baseVersion: config 'off' skips the probe and never passes it", async () => {
  const { strapi, calls } = stubStrapi({ withBaseVersion: true });
  const st = await BV.detect(strapi, 'off');
  assert.strictEqual(st.supported, false);
  assert.strictEqual(calls.length, 0, 'no probe call');
});

test('baseVersion: the probe runs in a transaction that is always rolled back', async () => {
  const { strapi } = stubStrapi({ withBaseVersion: true });
  let rolledBack = false;
  strapi.db.transaction = async (fn) => { try { return await fn(); } catch (e) { rolledBack = true; throw e; } };
  await withConflictError(() => BV.detect(strapi, 'auto'));
  assert.ok(rolledBack);
});

const cmDef = (name, op, uid, extra = {}) => ({
  name, title: name, description: `Content-manager ${op} for ${uid}.`, telemetry: { source: 'content-manager', name: op },
  auth: { policies: [{ action: `plugin::content-manager.explorer.${op === 'write' ? 'update' : op}`, subject: uid }] },
  createHandler: () => async () => ({ content: [{ type: 'text', text: 'BUILTIN RAN' }] }), ...extra,
});

function pageStrapi(existing = true, existingAny = existing) {
  return {
    contentTypes: {
      'api::page.page': { uid: 'api::page.page', kind: 'collectionType', options: { draftAndPublish: true }, attributes: {
        title: { type: 'string' }, sections: { type: 'dynamiczone', components: ['blocks.text'] }, items: { type: 'component', repeatable: true, component: 'shared.item' },
        seo: { type: 'component', component: 'shared.seo' }, body: { type: 'blocks' }, author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' }, cover: { type: 'media' },
      } },
      'api::homepage.homepage': { uid: 'api::homepage.homepage', kind: 'singleType', options: { draftAndPublish: true }, attributes: { headline: { type: 'string' }, blocks: { type: 'dynamiczone', components: ['blocks.text'] } } },
      'api::author.author': { uid: 'api::author.author', kind: 'collectionType', options: {}, attributes: { name: { type: 'string' } } },
    },
    documents: () => ({ findFirst: async () => (existing ? { documentId: 'h1' } : null) }),
    db: { query: () => ({ findOne: async () => (existingAny ? { id: 1 } : null) }) },
  };
}
const withGuide = (st) => {
  st.contentTypes['api::guide.guide'] = { uid: 'api::guide.guide', kind: 'collectionType', options: { draftAndPublish: true }, pluginOptions: { i18n: { localized: true } }, attributes: {
    title: { type: 'string', pluginOptions: { i18n: { localized: true } } },
    items: { type: 'component', repeatable: true, component: 'shared.item', pluginOptions: { i18n: { localized: true } } },
    facts: { type: 'component', repeatable: true, component: 'shared.item', pluginOptions: { i18n: { localized: false } } },
  } };
  return st;
};

test('matchBuiltin: only content-manager update/write/publish definitions of covered uids', () => {
  const covered = ['api::page.page'];
  assert.deepStrictEqual(MCP.matchBuiltin(cmDef('update_page', 'update', 'api::page.page'), covered), { uid: 'api::page.page', op: 'update' });
  assert.strictEqual(MCP.matchBuiltin(cmDef('get_page', 'get', 'api::page.page'), covered), null);
  assert.strictEqual(MCP.matchBuiltin(cmDef('update_plugin-users-permissions_user', 'update', 'plugin::users-permissions.user'), covered), null);
  assert.strictEqual(MCP.matchBuiltin({ name: 'update_page', description: 'look-alike from another plugin', auth: { policies: [{ action: 'x', subject: 'api::page.page' }] } }, covered), null);
});

test('builtinUpdates keep/guide/guard/hide rewrite the right definitions', async () => {
  const strapi = pageStrapi(true);
  const upd = cmDef('update_page', 'update', 'api::page.page');
  const pub = cmDef('publish_page', 'publish', 'api::page.page');
  const wr = cmDef('write_homepage', 'write', 'api::homepage.homepage');
  const authorUpd = cmDef('update_author', 'update', 'api::author.author');
  assert.strictEqual(G.rewriteFor(strapi, 'keep')(upd, { uid: 'api::page.page', op: 'update' }), upd);
  const guided = G.rewriteFor(strapi, 'guide')(upd, { uid: 'api::page.page', op: 'update' });
  assert.match(guided.description, /ws_patch/);
  assert.match(guided.description, /replaces every list field/);
  assert.match(G.rewriteFor(strapi, 'guide')(authorUpd, { uid: 'api::author.author', op: 'update' }).description, /no version check/);
  assert.doesNotMatch(G.rewriteFor(strapi, 'guide')(authorUpd, { uid: 'api::author.author', op: 'update' }).description, /list field/);
  assert.match(G.rewriteFor(strapi, 'guide')(pub, { uid: 'api::page.page', op: 'publish' }).description, /ws_publish/);
  // guard: publish not listed; update refuses list/component fields, passes scalar/relation/media
  assert.strictEqual(G.rewriteFor(strapi, 'guard')(pub, { uid: 'api::page.page', op: 'publish' }), null);
  const guarded = G.rewriteFor(strapi, 'guard')(upd, { uid: 'api::page.page', op: 'update' });
  const h = guarded.createHandler(strapi, {});
  for (const f of ['sections', 'items', 'seo', 'body']) {
    const r = await h({ args: { documentId: 'd', data: { title: 't', [f]: [] } } });
    assert.ok(r.isError, f);
    const e = JSON.parse(r.content[0].text).error;
    assert.strictEqual(e.code, 'use_ws_patch');
    assert.deepStrictEqual(e.fields, [f]);
  }
  const okr = await h({ args: { documentId: 'd', data: { title: 't', author: 'a1', cover: 3 } } });
  assert.strictEqual(okr.content[0].text, 'BUILTIN RAN');
  // hide: update and publish not listed; write_ (single type) only creates
  assert.strictEqual(G.rewriteFor(strapi, 'hide')(upd, { uid: 'api::page.page', op: 'update' }), null);
  assert.strictEqual(G.rewriteFor(strapi, 'hide')(pub, { uid: 'api::page.page', op: 'publish' }), null);
  const hw = G.rewriteFor(strapi, 'hide')(wr, { uid: 'api::homepage.homepage', op: 'write' }).createHandler(strapi, {});
  const refused = await hw({ args: { data: { headline: 'x' } } });
  assert.ok(refused.isError);
  const empty = pageStrapi(false);
  const hw2 = G.rewriteFor(empty, 'hide')(wr, { uid: 'api::homepage.homepage', op: 'write' }).createHandler(empty, {});
  assert.strictEqual((await hw2({ args: { data: { headline: 'x', blocks: [] } } })).content[0].text, 'BUILTIN RAN');
  // guard on a single type: creating with lists is fine, editing lists is refused
  const gw = G.rewriteFor(empty, 'guard')(wr, { uid: 'api::homepage.homepage', op: 'write' }).createHandler(empty, {});
  assert.strictEqual((await gw({ args: { data: { blocks: [] } } })).content[0].text, 'BUILTIN RAN');
  const gw2 = G.rewriteFor(strapi, 'guard')(wr, { uid: 'api::homepage.homepage', op: 'write' }).createHandler(strapi, {});
  assert.ok((await gw2({ args: { data: { blocks: [] } } })).isError);
});

test('guard on a new locale: only non-localized list fields are refused (they would overwrite the existing locales)', async () => {
  const st = withGuide(pageStrapi(false, true)); // the document exists, but not in the requested locale
  const def = cmDef('update_guide', 'update', 'api::guide.guide');
  const h = G.rewriteFor(st, 'guard')(def, { uid: 'api::guide.guide', op: 'update' }).createHandler(st, {});
  assert.strictEqual((await h({ args: { documentId: 'g', locale: 'fr', data: { title: 't', items: [] } } })).content[0].text, 'BUILTIN RAN');
  const r = await h({ args: { documentId: 'g', locale: 'fr', data: { title: 't', facts: [] } } });
  assert.ok(r.isError);
  assert.deepStrictEqual(JSON.parse(r.content[0].text).error.fields, ['facts']);
  // the same locale existing: every list field refused
  const st2 = withGuide(pageStrapi(true, true));
  const h2 = G.rewriteFor(st2, 'guard')(def, { uid: 'api::guide.guide', op: 'update' }).createHandler(st2, {});
  assert.deepStrictEqual(JSON.parse((await h2({ args: { documentId: 'g', locale: 'en', data: { items: [], facts: [] } } })).content[0].text).error.fields, ['items', 'facts']);
});

test('discard_draft and unpublish(discardDraft): warned in guide, discardDraft refused in guard/hide, discard hidden in hide', async () => {
  const st = pageStrapi();
  const disc = cmDef('discard_page_draft', 'discard_draft', 'api::page.page');
  const unp = cmDef('unpublish_page', 'unpublish', 'api::page.page');
  assert.match(G.rewriteFor(st, 'guide')(disc, { uid: 'api::page.page', op: 'discard_draft' }).description, /unpublished change is lost/);
  assert.match(G.rewriteFor(st, 'guide')(unp, { uid: 'api::page.page', op: 'unpublish' }).description, /discardDraft/);
  assert.strictEqual(G.rewriteFor(st, 'hide')(disc, { uid: 'api::page.page', op: 'discard_draft' }), null);
  assert.ok(G.rewriteFor(st, 'guard')(disc, { uid: 'api::page.page', op: 'discard_draft' }));
  for (const mode of ['guard', 'hide']) {
    const h = G.rewriteFor(st, mode)(unp, { uid: 'api::page.page', op: 'unpublish' }).createHandler(st, {});
    assert.ok((await h({ args: { documentId: 'd', discardDraft: true } })).isError, mode);
    assert.strictEqual((await h({ args: { documentId: 'd' } })).content[0].text, 'BUILTIN RAN', mode);
  }
});

test('interceptBuiltinTools wraps registerTool once and records what it did', () => {
  const registered = [];
  const svc = { registerTool(def) { registered.push(def.name); }, isEnabled: () => true };
  const strapi = { ai: { mcp: svc }, log: { warn() {} } };
  const seen = MCP.interceptBuiltinTools(strapi, ['api::page.page'], G.rewriteFor(pageStrapi(), 'hide'));
  strapi.ai.mcp.registerTool(cmDef('update_page', 'update', 'api::page.page'));
  strapi.ai.mcp.registerTool(cmDef('get_page', 'get', 'api::page.page'));
  strapi.ai.mcp.registerTool({ name: 'ws_patch', auth: { policies: [{ action: 'x', subject: 'api::page.page' }] } });
  assert.deepStrictEqual(registered, ['get_page', 'ws_patch']);
  assert.deepStrictEqual(seen, [{ name: 'update_page', uid: 'api::page.page', op: 'update', result: 'hidden' }]);
});

test('server instructions name the ws_* tools and the mode', () => {
  const t = G.instructions(['api::page.page'], 'guide');
  for (const w of ['ws_get', 'ws_patch', 'ws_publish', 'expected_version', 'version_conflict', 'api::page.page']) assert.ok(t.includes(w), w);
  assert.match(G.instructions([], 'hide'), /not offered/);
});

test('config validator refuses bad values', () => {
  assert.throws(() => CFG.validator({ builtinUpdates: 'remove' }));
  assert.throws(() => CFG.validator({ baseVersion: true }));
  assert.throws(() => CFG.validator({ modules: { bulk: 'yes' } }));
  assert.doesNotThrow(() => CFG.validator({ builtinUpdates: 'hide', modules: { bulk: true }, lenientArgs: false }));
});

test('module registry: only enabled modules load; hooks run; ops cannot shadow built-ins', async () => {
  const log = [];
  const a = { name: 'alpha', tools: () => [{ name: 'alpha_tool' }], hooks: {
    beforeWrite: async (ctx, info) => log.push(['before', info.action]),
    afterWrite: async (ctx, info, before, after) => ({ seen: [before.v, after.v] }),
  }, ops: { copy: { apply: () => {} } } };
  const b = { name: 'beta', tools: () => [{ name: 'beta_tool' }], hooks: { beforeWrite: async () => log.push(['beta']) } };
  MOD.setModulesForTests([a, b]);
  try {
    assert.deepStrictEqual(MOD.load(null, { modules: { alpha: true } }), ['alpha']);
    assert.deepStrictEqual(MOD.tools(null, {}).map((t) => t.name), ['alpha_tool']);
    await MOD.beforeWrite({}, { action: 'patch' });
    assert.deepStrictEqual(log, [['before', 'patch']]);
    assert.deepStrictEqual(await MOD.afterWrite({}, {}, { v: 1 }, { v: 2 }), { alpha: { seen: [1, 2] } });
    assert.deepStrictEqual(Object.keys(MOD.ops()), ['copy']);
    MOD.setModulesForTests([{ name: 'bad', ops: { update: { apply() {} } } }]);
    assert.throws(() => MOD.load(null, { modules: { bad: true } }), /cannot redefine/);
    MOD.setModulesForTests([{ name: 'bad2', ops: { copy: { schema: { key: 1 }, apply() {} } } }]);
    assert.throws(() => MOD.load(null, { modules: { bad2: true } }), /redefines op properties key/);
    MOD.setModulesForTests([{ name: 'x', ops: { copy: { apply() {} } } }, { name: 'y', ops: { copy: { apply() {} } } }]);
    assert.throws(() => MOD.load(null, { modules: { x: true, y: true } }), /two modules/);
  } finally {
    MOD.setModulesForTests(null);
    MOD.load(null, { modules: {} });
  }
});

test('blocks row keys are bound to uid, document, locale and field (1.0 key safety)', () => {
  const node = { type: 'paragraph', children: [{ type: 'text', text: 'same' }] };
  const a = M.rowKey('blocks', {}, node, 0, M.keyScope('api::page.page', 'docA', null, 'body'));
  const b = M.rowKey('blocks', {}, node, 0, M.keyScope('api::page.page', 'docB', null, 'body'));
  const fr = M.rowKey('blocks', {}, node, 0, M.keyScope('api::page.page', 'docA', 'fr', 'body'));
  const other = M.rowKey('blocks', {}, node, 0, M.keyScope('api::page.page', 'docA', null, 'intro'));
  assert.strictEqual(new Set([a, b, fr, other]).size, 4);
  assert.strictEqual(a, M.rowKey('blocks', {}, node, 0, M.keyScope('api::page.page', 'docA', null, 'body')), 'stable');
  assert.notStrictEqual(a, M.rowKey('blocks', {}, node, 1, M.keyScope('api::page.page', 'docA', null, 'body')), 'index is part of the key');
});

test('compat report lists every internal with a status and the tested versions', () => {
  C.note('db.row_lock', true, 'x');
  const r = C.report({ config: { get: (k) => (k === 'info.strapi' ? '5.62.0' : undefined) } });
  assert.strictEqual(r.strapi, '5.62.0');
  assert.strictEqual(r.tested_version, true);
  assert.ok(r.features.length >= 8);
  assert.strictEqual(r.features.find((f) => f.feature === 'db.row_lock').ok, true);
  const untested = C.report({ config: { get: (k) => (k === 'info.strapi' ? '5.70.0' : undefined) } });
  assert.strictEqual(untested.tested_version, false);
});

test('diff: rows by key (changed, removed, added, reordered) and by content (draft vs live)', () => {
  const Dm = require('../server/diff');
  const before = [{ _key: 'a:1', label: 'x', qty: 1 }, { _key: 'a:2', label: 'y', qty: 2 }, { _key: 'a:3', label: 'z', qty: 3 }];
  const after = [{ _key: 'a:3', label: 'z', qty: 3 }, { _key: 'a:1', label: 'x', qty: 9 }, { _key: 'a:9', label: 'n', qty: 1 }];
  const d = Dm.listDiff(before, after, 'key');
  assert.deepStrictEqual(d.changed, [{ key: 'a:1', fields: { qty: { before: 1, after: 9 } } }]);
  assert.deepStrictEqual(d.removed.map((x) => x.key), ['a:2']);
  assert.deepStrictEqual(d.added.map((x) => x.key), ['a:9']);
  assert.strictEqual(d.reordered, true);
  // same content, other ids (published rows): no difference
  const live = before.map((r, i) => ({ ...r, _key: `a:${100 + i}` }));
  assert.deepStrictEqual(Dm.diffViews({ items: 'repeatable' }, { items: live }, { items: before }, { matchRows: 'content' }), {});
  const d2 = Dm.diffViews({ items: 'repeatable', note: 'scalar' }, { items: live, note: 'a' }, { items: after, note: 'b' }, { matchRows: 'content' });
  assert.deepStrictEqual(d2.note, { before: 'a', after: 'b' });
  assert.deepStrictEqual(d2.items.added.map((x) => x.row.label), ['x', 'n']);
  assert.deepStrictEqual(d2.items.removed.map((x) => x.row.label), ['x', 'y']);
});
