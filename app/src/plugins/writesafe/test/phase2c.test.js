'use strict';
// Unit tests for writesafe hardening phase 2, stream C: item 12 (ws_localize row map, target-only rows), item 13
// (guard/hide fail closed, end-to-end instructions probe) and item 14 (media cleanup, dedup across replicas, pixel check
// without sharp). Item 10 (publish/delete previews) needs a running Strapi: tests/test_phase2_c.py.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

global.strapi = { log: { warn() {}, info() {}, error() {} } };

const M = require('../server/model');
const B = require('../server/modules/localize/build');
const G = require('../server/guidance');
const MCP = require('../server/compat/mcp');
const C = require('../server/compat');

// ---------------------------------------------------------------- item 12: translation row map
const loc = { pluginOptions: { i18n: { localized: true } } };
function l10nStrapi() {
  return {
    contentTypes: {
      'api::a.a': { uid: 'api::a.a', kind: 'collectionType', options: { draftAndPublish: true }, pluginOptions: { i18n: { localized: true } }, attributes: {
        title: { type: 'string', ...loc },
        sections: { type: 'dynamiczone', components: ['c.hero', 'c.fig'], ...loc },
      } },
    },
    components: {
      'c.hero': { uid: 'c.hero', attributes: { heading: { type: 'string' }, tone: { type: 'enumeration', enum: ['a', 'b'] } } },
      'c.fig': { uid: 'c.fig', attributes: { caption: { type: 'string' }, image: { type: 'media' }, slides: { type: 'component', repeatable: true, component: 'c.slide' } } },
      'c.slide': { uid: 'c.slide', attributes: { label: { type: 'string' }, pic: { type: 'media' } } },
    },
    plugin: () => { throw new Error('no i18n service in unit tests'); },
    db: { query: () => ({ findOne: async () => null }) },
  };
}
const UID = 'api::a.a';
const opts = (strapi, extra = {}) => ({ strapi, translations: {}, targetLocale: 'fr', relations: 'map', copyNonText: false, ...extra });
const hero = (id, heading, tone = 'a') => ({ __component: 'c.hero', id, heading, tone });
const fig = (id, caption, image, slides) => ({ __component: 'c.fig', id, caption, image, ...(slides ? { slides } : {}) });

test('item 12: recorded links pair rows across a reorder and an insert; target media and enums stay on their rows', async () => {
  const strapi = l10nStrapi();
  // en: the two figures swapped, a new hero inserted first; fr has its own image on fig 11 and its own tone on hero 10
  const src = { title: 'T', sections: [hero(30, 'New'), hero(1, 'One'), fig(3, 'Fig B', 'mB'), fig(2, 'Fig A', 'mA')] };
  const tgt = { title: 'FR T', sections: [hero(10, 'FR One', 'b'), fig(11, 'FR Fig A', 'mFR'), fig(12, 'FR Fig B', 'mB')] };
  const links = new Map([['c.hero:1', 10], ['c.fig:2', 11], ['c.fig:3', 12]]);
  const b = await B.buildTarget(opts(strapi, { links }), UID, src, tgt);
  assert.deepStrictEqual(b.ambiguous, []);
  const out = b.data.sections;
  assert.deepStrictEqual(out.map((r) => r.id), [undefined, 10, 12, 11], 'source order, each source row on its own fr row');
  assert.strictEqual(out[2].caption, 'FR Fig B');
  assert.strictEqual(out[3].image, 'mFR', "fr's own image stays on Fig A");
  assert.strictEqual(out[1].tone, 'b', "fr's own enumeration stays on hero One");
  assert.strictEqual(out[0].heading, 'New', 'the new row is copied from the source');
  assert.deepStrictEqual(b.rows.sections, { matched: 3, added: 1, kept: 0, removed: 0 });
});

test('item 12: same-type rows without a recorded map are ambiguous; a row_map resolves them', async () => {
  const strapi = l10nStrapi();
  const src = { sections: [hero(1, 'First'), hero(2, 'Second'), fig(3, 'Only fig', 'm')] };
  const tgt = { sections: [hero(10, 'Deuxième'), hero(11, 'Premier'), fig(12, 'Seule', 'm')] };
  const b = await B.buildTarget(opts(strapi), UID, src, tgt);
  assert.strictEqual(b.ambiguous.length, 1);
  assert.deepStrictEqual(b.ambiguous[0], {
    // rows as structural positions, like the unit paths: no database ids handed out
    field: 'sections', component: 'c.hero', source: ['0:c.hero', '1:c.hero'], target: ['0:c.hero', '1:c.hero'],
    proposed: { '0:c.hero': '0:c.hero', '1:c.hero': '1:c.hero' }, // the order-based guess, for the caller to check
  });
  assert.strictEqual(b.rowMap.sections['2:c.fig'], '2:c.fig', 'a unique type still pairs');
  // the agent decides by meaning
  const b2 = await B.buildTarget(opts(strapi, { rowMap: { sections: { 'c.hero:1': 'c.hero:11', 'c.hero:2': 'c.hero:10' } } }), UID, src, tgt);
  assert.deepStrictEqual(b2.ambiguous, []);
  assert.deepStrictEqual(b2.data.sections.map((r) => [r.id, r.heading || r.caption]), [[11, 'Premier'], [10, 'Deuxième'], [12, 'Seule']]);
  // structural refs (index:component), the form the plan shows
  const b3 = await B.buildTarget(opts(strapi, { rowMap: { sections: { '0:c.hero': '1:c.hero', '1:c.hero': '0:c.hero' } } }), UID, src, tgt);
  assert.deepStrictEqual(b3.data.sections.map((r) => r.id), [11, 10, 12]);
  // a source row mapped to null is a new row
  const b4 = await B.buildTarget(opts(strapi, { rowMap: { sections: { 'c.hero:1': null, 'c.hero:2': 'c.hero:10' } }, removeExtraRows: true }), UID, src, tgt);
  assert.deepStrictEqual(b4.data.sections.map((r) => r.id), [undefined, 10, 12]);
  // ws_get's content-bound keys (stream A, "<component>:<id>:<mac>") are accepted and matched by identity
  const b5 = await B.buildTarget(opts(strapi, { rowMap: { sections: { 'c.hero:1:AAAAAAAAAAAAAAAAAAAAAA': 'c.hero:11:BBBBBBBBBBBBBBBBBBBBBB', '1:c.hero': '0:c.hero' } } }), UID, src, tgt);
  assert.deepStrictEqual(b5.data.sections.map((r) => r.id), [11, 10, 12]);
  await assert.rejects(() => B.buildTarget(opts(strapi, { rowMap: { sections: { 'c.hero:1': 'c.fig:12' } } }), UID, src, tgt), (e) => e.code === 'invalid' && /c\.fig:12/.test(e.message));
  await assert.rejects(() => B.buildTarget(opts(strapi, { rowMap: { sections: { 'c.hero:1': 'c.hero:10', 'c.hero:2': 'c.hero:10' } } }), UID, src, tgt), (e) => e.code === 'invalid');
  await assert.rejects(() => B.buildTarget(opts(strapi, { rowMap: { sections: { 'c.hero:99': 'c.hero:10' } } }), UID, src, tgt), (e) => e.code === 'invalid');
});

test('item 12: target-only rows are kept in place unless removeExtraRows', async () => {
  const strapi = l10nStrapi();
  const src = { sections: [hero(1, 'Top')] };
  // fr: hero 10 recorded for en 1, an fr-only fig 13, hero 14 recorded for en 4 (deleted in en)
  const tgt = { sections: [hero(10, 'FR Top'), fig(13, 'Seulement en français', 'mFR'), hero(14, 'FR gone')] };
  const links = new Map([['c.hero:1', 10], ['c.hero:4', 14]]);
  const b = await B.buildTarget(opts(strapi, { links }), UID, src, tgt);
  assert.deepStrictEqual(b.ambiguous, []);
  assert.deepStrictEqual(b.built.sections.map((r) => r.id), [10, 13, 14], 'kept rows stay right after the target row they followed');
  assert.deepStrictEqual(b.targetOnly.map((x) => [x.key, x.reason, x.action]), [['1:c.fig', 'only_in_target', 'keep'], ['2:c.hero', 'source_row_removed', 'keep']]);
  assert.deepStrictEqual(b.rows.sections, { matched: 1, added: 0, kept: 2, removed: 0 });
  const r = await B.buildTarget(opts(strapi, { links, removeExtraRows: true }), UID, src, tgt);
  assert.deepStrictEqual(r.data.sections.map((x) => x.id), [10]);
  assert.deepStrictEqual(r.rows.sections, { matched: 1, added: 0, kept: 0, removed: 2 });
  assert.ok(r.targetOnly.every((x) => x.action === 'remove'));
});

test('item 12: a row recorded for a source row that is gone is ambiguous next to a new source row of its type (review finding 1)', async () => {
  const strapi = l10nStrapi();
  // en hero 1 was deleted and hero 5 added, OR hero 1 was recreated as 5 (discardDraft, whole-list replace): undecidable
  const b = await B.buildTarget(opts(strapi, { links: new Map([['c.hero:1', 10]]) }), UID, { sections: [hero(5, 'Hello')] }, { sections: [hero(10, 'Bonjour')] });
  assert.deepStrictEqual(b.ambiguous.map((x) => [x.component, x.source, x.target]), [['c.hero', ['0:c.hero'], ['0:c.hero']]]);
  // the caller's row_map decides; the map is then recorded for the new id
  const ok = await B.buildTarget(opts(strapi, { links: new Map([['c.hero:1', 10]]), rowMap: { sections: { 'c.hero:5': 'c.hero:10' } } }), UID, { sections: [hero(5, 'Hello')] }, { sections: [hero(10, 'Bonjour')] });
  assert.deepStrictEqual(ok.built.sections.map((r) => [r.id, r.heading]), [[10, 'Bonjour']]);
  assert.deepStrictEqual(B.linksAfterWrite(strapi, UID, ok, { sections: [hero(10, 'Bonjour')] }), [['c.hero', 5, 10]]);
});

test('item 12: nested repeatables use the same map; new rows get links after the write', async () => {
  const strapi = l10nStrapi();
  const src = { sections: [fig(2, 'F', 'm', [{ id: 21, label: 'b', pic: 'p2' }, { id: 20, label: 'a', pic: 'p1' }])] };
  const tgt = { sections: [fig(11, 'FR F', 'm', [{ id: 30, label: 'FR a', pic: 'pFR' }, { id: 31, label: 'FR b', pic: 'p2' }])] };
  const links = new Map([['c.fig:2', 11], ['c.slide:20', 30], ['c.slide:21', 31]]);
  const b = await B.buildTarget(opts(strapi, { links }), UID, src, tgt);
  assert.deepStrictEqual(b.data.sections[0].slides.map((s) => [s.id, s.label, s.pic]), [[31, 'FR b', 'p2'], [30, 'FR a', 'pFR']]);
  // links for the written result: matched rows by id, new rows by position in the written list
  const src2 = { sections: [hero(1, 'One'), hero(7, 'Added')] };
  const tgt2 = { sections: [hero(10, 'FR One')] };
  const b2 = await B.buildTarget(opts(strapi, { links: new Map([['c.hero:1', 10]]) }), UID, src2, tgt2);
  const written = { sections: [hero(10, 'FR One'), hero(55, 'Added')] };
  assert.deepStrictEqual(B.linksAfterWrite(strapi, UID, b2, written, tgt2).sort(), [['c.hero', 1, 10], ['c.hero', 7, 55]].sort());
});

test('item 12: refs: structural index:cuid, ws_get keys (cuid:id:mac) and identities (cuid:id)', () => {
  assert.deepStrictEqual(B.parseRef('3:blocks.hero'), { cuid: 'blocks.hero', index: 3 });
  assert.deepStrictEqual(B.parseRef('blocks.hero:12:ab12cd34ef56ab12cd34ef'), { cuid: 'blocks.hero', id: 12 });
  assert.deepStrictEqual(B.parseRef('blocks.hero:12'), { cuid: 'blocks.hero', id: 12 });
  assert.strictEqual(B.parseRef('nonsense'), null);
  assert.strictEqual(B.parseRef('#0:abcd1234'), null, 'a blocks node is not a row');
});

test('item 12: the recorded row map is bound to the row-key epoch (stream A, 16b)', async () => {
  const LK = require('../server/modules/localize/links');
  const rows = new Map();
  let nextId = 1;
  const q = {
    findOne: async ({ where }) => rows.get(where.key) || null,
    create: async ({ data }) => { const r = { id: nextId++, ...data }; rows.set(data.key, r); return r; },
    update: async ({ where, data }) => { for (const r of rows.values()) if (r.id === where.id) Object.assign(r, data); return null; },
  };
  const qb = () => { let k; const b = { select: () => b, where: (w) => { k = w.key; return b; }, forUpdate: () => b, first: () => b, execute: async () => rows.get(k) || null }; return b; };
  const st = { db: { query: () => q, queryBuilder: qb }, contentTypes: {}, components: {} };
  const before = M.rowEpoch();
  try {
    M.setRowEpoch('epoch-one', true);
    await LK.write(st, 'api::a.a', 'd1', 'en', 'fr', [['c.hero', 1, 10]]);
    assert.deepStrictEqual([...(await LK.read(st, 'api::a.a', 'd1', 'en', 'fr'))], [['c.hero:1', 10]]);
    M.setRowEpoch('epoch-two', true); // an import into a fresh database: a new epoch
    assert.deepStrictEqual([...(await LK.read(st, 'api::a.a', 'd1', 'en', 'fr'))], [], 'a map from another epoch is not used');
    M.setRowEpoch('epoch-three', false); // per-process epoch (the database's could not be read): nothing recorded
    assert.strictEqual(await LK.write(st, 'api::a.a', 'd1', 'en', 'fr', [['c.hero', 1, 10]]), false);
  } finally { M.setRowEpoch(before.epoch, before.fromDb); }
});

// ---------------------------------------------------------------- item 13: guard and hide fail closed
const cmDef = (name, op, uid) => ({
  name, title: name, description: `Content-manager ${op} for ${uid}.`, telemetry: { source: 'content-manager', name: op },
  auth: { policies: [{ action: `plugin::content-manager.explorer.${op === 'write' ? 'update' : op}`, subject: uid }] },
  createHandler: () => async () => ({ content: [{ type: 'text', text: 'BUILTIN RAN' }] }),
});
function pageStrapi() {
  return {
    contentTypes: {
      'api::page.page': { uid: 'api::page.page', kind: 'collectionType', options: { draftAndPublish: true }, attributes: {
        title: { type: 'string' }, sections: { type: 'dynamiczone', components: ['blocks.text'] },
      } },
    },
    documents: () => ({ findFirst: async () => ({ documentId: 'p1' }) }),
    db: { query: () => ({ findOne: async () => ({ id: 1 }) }) },
    log: { warn() {}, info() {}, error() {} },
  };
}

test('item 13: guard refuses a built-in call whose input has no args (unknown handler input shape)', async () => {
  const strapi = pageStrapi();
  for (const mode of ['guard', 'hide']) {
    for (const op of ['update', 'write']) {
      const d = G.rewriteFor(strapi, mode)(cmDef(`${op}_page`, op, 'api::page.page'), { uid: 'api::page.page', op });
      if (!d) continue;
      const h = d.createHandler(strapi, {});
      for (const input of [undefined, {}, { arguments: { data: { sections: [] } } }]) {
        const r = await h(input);
        assert.ok(r.isError, `${mode} ${op} ${JSON.stringify(input)}`);
        assert.strictEqual(JSON.parse(r.content[0].text).error.code, 'guard_unavailable');
      }
    }
  }
});

test('item 13 (N21): create_ and delete_ are matched; hidden or steered when ws_create / ws_delete are on', () => {
  const covered = ['api::page.page'];
  assert.deepStrictEqual(MCP.matchBuiltin(cmDef('delete_page', 'delete', 'api::page.page'), covered), { uid: 'api::page.page', op: 'delete' });
  assert.deepStrictEqual(MCP.matchBuiltin(cmDef('create_page', 'create', 'api::page.page'), covered), { uid: 'api::page.page', op: 'create' });
  const strapi = pageStrapi();
  const del = cmDef('delete_page', 'delete', 'api::page.page');
  const cre = cmDef('create_page', 'create', 'api::page.page');
  const on = () => ['create', 'delete'];
  const off = () => [];
  assert.strictEqual(G.rewriteFor(strapi, 'keep', on)(del, { uid: 'api::page.page', op: 'delete' }), del);
  assert.match(G.rewriteFor(strapi, 'guide', on)(del, { uid: 'api::page.page', op: 'delete' }).description, /ws_delete/);
  assert.match(G.rewriteFor(strapi, 'guide', on)(cre, { uid: 'api::page.page', op: 'create' }).description, /ws_create/);
  assert.strictEqual(G.rewriteFor(strapi, 'guard', on)(del, { uid: 'api::page.page', op: 'delete' }), null);
  assert.match(G.rewriteFor(strapi, 'guard', on)(cre, { uid: 'api::page.page', op: 'create' }).description, /ws_create/);
  assert.strictEqual(G.rewriteFor(strapi, 'hide', on)(del, { uid: 'api::page.page', op: 'delete' }), null);
  assert.strictEqual(G.rewriteFor(strapi, 'hide', on)(cre, { uid: 'api::page.page', op: 'create' }), null);
  // modules off: no ws_* replacement, so the built-ins stay (with a caution in guide/guard)
  assert.match(G.rewriteFor(strapi, 'guard', off)(del, { uid: 'api::page.page', op: 'delete' }).description, /no version check/);
  assert.strictEqual(G.rewriteFor(strapi, 'hide', off)(cre, { uid: 'api::page.page', op: 'create' }).name, 'create_page');
});

function mcpStrapi({ stable = true } = {}) {
  const calls = { registered: [], started: 0 };
  const mk = () => ({
    registerTool(def) { calls.registered.push(def.name); },
    async start() { calls.started += 1; },
    isEnabled: () => true,
  });
  const one = mk();
  const st = { log: { warn() {}, info() {}, error() {} }, calls };
  Object.defineProperty(st, 'ai', { get: () => ({ mcp: stable ? one : mk() }) });
  return st;
}

test('item 13: a lost registerTool wrap in guard/hide is an error at startup, not a silent keep', () => {
  for (const mode of ['guard', 'hide']) {
    assert.throws(() => MCP.interceptBuiltinTools(mcpStrapi({ stable: false }), ['api::page.page'], (d) => d, mode), /builtinUpdates/);
  }
  assert.doesNotThrow(() => MCP.interceptBuiltinTools(mcpStrapi({ stable: false }), ['api::page.page'], (d) => d, 'guide'));
});

test('item 13: in guard/hide the MCP server does not start when no content-manager tool came through the intercept', async () => {
  const st = mcpStrapi();
  const seen = MCP.interceptBuiltinTools(st, ['api::page.page'], (d) => d, 'guard');
  MCP.failClosedStart(st, seen, 'guard', () => ['api::page.page']);
  // only our own tools (which use content-manager permissions too): content-manager's never came through
  st.ai.mcp.registerTool({ name: 'ws_get', description: 'x', auth: { policies: [{ action: 'plugin::content-manager.explorer.read', subject: 'api::page.page' }] } });
  await assert.rejects(() => st.ai.mcp.start(), /not started.*no content-manager MCP tool/);
  assert.strictEqual(st.calls.started, 0);
  assert.strictEqual(C.status['mcp.intercept_builtin_tools'].ok, false);
  // once content-manager's tools are seen, the server starts
  const st2 = mcpStrapi();
  const seen2 = MCP.interceptBuiltinTools(st2, ['api::page.page'], (d) => d, 'guard');
  MCP.failClosedStart(st2, seen2, 'guard', () => ['api::page.page']);
  st2.ai.mcp.registerTool(cmDef('update_page', 'update', 'api::page.page'));
  st2.ai.mcp.registerTool({ name: 'ws_patch', description: 'x', auth: { policies: [{ action: 'plugin::content-manager.explorer.update', subject: 'api::page.page' }] } });
  await st2.ai.mcp.start(); // the plugin's own ws_* tools are not unknown content-manager tools
  assert.strictEqual(st2.calls.started, 1);
  // a content-manager tool for a covered type that the matcher no longer recognises (renamed op) also fails closed
  const st3 = mcpStrapi();
  const seen3 = MCP.interceptBuiltinTools(st3, ['api::page.page'], (d) => d, 'hide');
  MCP.failClosedStart(st3, seen3, 'hide', () => ['api::page.page']);
  st3.ai.mcp.registerTool(cmDef('update_page', 'update', 'api::page.page'));
  st3.ai.mcp.registerTool(cmDef('patch_page', 'patch', 'api::page.page'));
  await assert.rejects(() => st3.ai.mcp.start(), /patch_page/);
  // another plugin's tool that reuses a content-manager permission is not content-manager's (review finding 2)
  const st5 = mcpStrapi();
  const seen5 = MCP.interceptBuiltinTools(st5, ['api::page.page'], (d) => d, 'guard');
  MCP.failClosedStart(st5, seen5, 'guard', () => ['api::page.page']);
  st5.ai.mcp.registerTool(cmDef('update_page', 'update', 'api::page.page'));
  st5.ai.mcp.registerTool({ name: 'seo_suggest_page', telemetry: { source: 'seo-plugin', name: 'suggest' }, auth: { policies: [{ action: 'plugin::content-manager.explorer.update', subject: 'api::page.page' }] } });
  st5.ai.mcp.registerTool({ name: 'seo_check_page', auth: { policies: [{ action: 'plugin::content-manager.explorer.read', subject: 'api::page.page' }] } });
  await st5.ai.mcp.start();
  assert.strictEqual(st5.calls.started, 1);
  // keep and guide never block the server
  const st4 = mcpStrapi();
  const seen4 = MCP.interceptBuiltinTools(st4, ['api::page.page'], (d) => d, 'guide');
  MCP.failClosedStart(st4, seen4, 'guide', () => ['api::page.page']);
  await st4.ai.mcp.start();
  assert.strictEqual(st4.calls.started, 1);
});

test('item 13 (N22): the instructions probe is ok only once an initialize reply carried them', async () => {
  const st = { log: { warn() {}, info() {}, error() {} } };
  assert.strictEqual(MCP.installServerInstructions(st, () => 'WRITESAFE TEXT'), true);
  assert.notStrictEqual(C.status['mcp.server_instructions'].ok, true, 'installing the hook proves nothing yet');
  const sdk = MCP.loadSdk();
  const server = new sdk.McpServer({ name: 't', version: '0' }, { capabilities: {} });
  const reply = await server.server._oninitialize({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } });
  assert.strictEqual(reply.instructions, 'WRITESAFE TEXT');
  assert.strictEqual(C.status['mcp.server_instructions'].ok, true);
  const r = await MCP.probeInstructions();
  assert.strictEqual(r.ok, true);
});

// ---------------------------------------------------------------- item 14: media
// sharp made unresolvable (a Strapi without it) for a fresh load of the media module, until restore()
function loadMediaWithoutSharp() {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function patched(req, ...rest) {
    if (req === 'sharp') { const e = new Error("Cannot find module 'sharp'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return orig.call(this, req, ...rest);
  };
  const file = require.resolve('../server/modules/media');
  delete require.cache[file];
  const media = require(file);
  delete require.cache[file];
  return { media, restore: () => { Module._resolveFilename = orig; } };
}

test('item 14: without sharp the pixel check refuses images (fails closed)', async () => {
  const { media, restore } = loadMediaWithoutSharp();
  try {
    const st = { log: { warn() {}, info() {}, error() {} } };
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-c14-')), 'x.png');
    fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await assert.rejects(() => media._internal.checkPixels(st, f, 'image/png', 'png', 1000), (e) => e.code === 'pixel_check_unavailable' && /sharp/.test(e.message));
    // not an image: no pixel check needed
    await media._internal.checkPixels(st, f, 'application/pdf', 'pdf', 1000);
    // an image format sharp never decodes is not checked with sharp either, so it is not refused (review finding 4)
    await media._internal.checkPixels(st, f, 'image/bmp', 'bmp', 1000);
  } finally { restore(); }
});

function fakeMediaStrapi({ failIndex = false } = {}) {
  const removed = [];
  const indexRows = [];
  const st = {
    log: { warn() {}, info() {}, error() {} },
    removed, indexRows,
    plugin: () => ({ service: () => ({
      upload: async () => [{ id: 7, documentId: 'f7', name: 'x.png', mime: 'image/png' }],
      remove: async (file) => { removed.push(file.id); },
    }) }),
    db: { query: (uid) => ({
      create: async ({ data }) => { if (failIndex && uid === 'plugin::writesafe.media-import') throw new Error('index insert failed'); indexRows.push(data); return { id: indexRows.length, ...data }; },
      findOne: async () => ({ id: 7 }),
    }) },
  };
  return st;
}

test('item 14: a failed index insert removes the uploaded file and reports the item as failed', async () => {
  const { _internal: I } = require('../server/modules/media');
  const st = fakeMediaStrapi({ failIndex: true });
  await assert.rejects(() => I.storeNew(st, { user: null }, { fileObj: {}, fileInfo: {}, sha256: 'a'.repeat(64), finalUrl: 'https://x/y.png', bytes: 10, mime: 'image/png' }),
    (e) => e.code === 'index_failed');
  assert.deepStrictEqual(st.removed, [7], 'the uploaded file was removed');
  const ok = fakeMediaStrapi();
  const created = await I.storeNew(ok, { user: null }, { fileObj: {}, fileInfo: {}, sha256: 'b'.repeat(64), finalUrl: 'https://x/z.png', bytes: 10, mime: 'image/png' });
  assert.strictEqual(created.id, 7);
  assert.deepStrictEqual(ok.removed, []);
  assert.strictEqual(ok.indexRows.length, 1);
});

/** A receipts table with a unique key, shared by two "replicas" (two loads of the media module). */
function sharedReceipts() {
  const rows = new Map();
  let next = 1;
  return {
    rows,
    query: () => ({
      create: async ({ data }) => {
        await new Promise((r) => setImmediate(r));
        if (rows.has(data.key)) { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e; }
        const row = { id: next++, ...data, createdAt: new Date(), updatedAt: new Date() };
        rows.set(data.key, row);
        return row;
      },
      findOne: async ({ where }) => rows.get(where.key) || null,
      update: async ({ where }) => { for (const r of rows.values()) if (r.id === where.id) r.updatedAt = new Date(); return null; },
      delete: async ({ where }) => { for (const [k, r] of rows) if (r.id === where.id) rows.delete(k); return null; },
      deleteMany: async ({ where }) => { let n = 0; for (const [k, r] of rows) if (r.id === where.id && (!where.updatedAt || r.updatedAt < where.updatedAt.$lt)) { rows.delete(k); n += 1; } return { count: n }; },
    }),
  };
}

test('item 14: the per-content-hash lock holds across replicas (database claim, not a process-local map)', async () => {
  const file = require.resolve('../server/modules/media');
  delete require.cache[file];
  const r1 = require(file);
  delete require.cache[file];
  const r2 = require(file);
  assert.notStrictEqual(r1, r2, 'two module instances, as on two replicas');
  const table = sharedReceipts();
  const st = { log: { warn() {}, info() {}, error() {} }, db: { query: table.query } };
  const keys = { indexed: true };
  let inside = 0;
  let overlap = false;
  const work = async () => {
    inside += 1;
    if (inside > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 40));
    inside -= 1;
  };
  const sha = 'c'.repeat(64);
  await Promise.all([r1._internal.withShaClaim(st, sha, work, { waitMs: 2000, keys }), r2._internal.withShaClaim(st, sha, work, { waitMs: 2000, keys }), r1._internal.withShaClaim(st, sha, work, { waitMs: 2000, keys })]);
  assert.strictEqual(overlap, false, 'never two imports of one content hash at once');
  assert.strictEqual(table.rows.size, 0, 'claims released');
  // a stale claim (a replica that died mid-import) is taken over
  table.rows.set(`claim:media-sha:${sha}`, { id: 99, key: `claim:media-sha:${sha}`, tool: 'claim', createdAt: new Date(0), updatedAt: new Date(0) });
  let ran = false;
  await r2._internal.withShaClaim(st, sha, async () => { ran = true; }, { waitMs: 500, staleMs: 1000, keys });
  assert.ok(ran);
  // a live claim held too long: the caller gets a retryable busy error, not a duplicate import
  table.rows.set(`claim:media-sha:${sha}`, { id: 100, key: `claim:media-sha:${sha}`, tool: 'claim', createdAt: new Date(), updatedAt: new Date() });
  await assert.rejects(() => r1._internal.withShaClaim(st, sha, async () => {}, { waitMs: 150, keys }), (e) => e.code === 'in_progress');
});
