'use strict';
// #41: input and output schemas are built once per process and key. Strapi's MCP service calls resolveInputSchema every
// time it binds the tools to an SDK server (every MCP session); zod 3.25's zod/v4 build (@strapi/utils 5.47.0 to
// 5.52.1) keeps .describe() metadata in a strong Map, so rebuilding them each time grew the heap until Strapi died.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const v8 = require('node:v8');
const vm = require('node:vm');
const { z } = require('@strapi/utils');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {}, debug() {} } };

const PAGE = 'api::page.page';
const ART = 'api::article.article';
const BLOG = 'api::blog.blog';

function registryStrapi(cfg, extraTypes = {}) {
  const defs = [];
  const strapi = {
    contentTypes: {
      [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'page' }, attributes: { title: { type: 'string' }, items: { type: 'component', repeatable: true, component: 'shared.item' } } },
      [ART]: { uid: ART, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'article' }, pluginOptions: { i18n: { localized: true } }, attributes: { title: { type: 'string', pluginOptions: { i18n: { localized: true } } } } },
      ...extraTypes,
    },
    components: { 'shared.item': { attributes: { label: { type: 'string' } } } },
    config: { get: (k) => (k === 'plugin::writesafe' ? cfg : undefined) },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    ai: { mcp: { registerTool: (d) => defs.push(d), isRunning: () => false, isEnabled: () => true } },
    plugin: () => undefined,
  };
  return { strapi, defs };
}
const ALL = { history: true, find: true, bulk: true, replace: true, create: true, delete: true, localize: true, media: true, copy: true };
const tools = () => require('../server/tools');
const resetModules = () => require('../server/modules').load(null, { modules: {} });
const register = (cfg, extraTypes) => {
  const r = registryStrapi(cfg, extraTypes);
  tools().register(r.strapi);
  return r;
};
// what Strapi's McpToolRegistry.bind does for each session: resolve every tool's schemas with that session's context
const bindSession = (defs, i) => defs.map((d) => ({
  input: d.resolveInputSchema ? d.resolveInputSchema({ userAbility: {}, user: { id: i } }) : undefined,
  output: d.resolveOutputSchema ? d.resolveOutputSchema({ userAbility: {}, user: { id: i } }) : undefined,
}));

test('#41: every tool resolves the same schema objects on every session (all modules on); none is built again', () => {
  try {
    const { defs } = register({ modules: ALL });
    assert.ok(defs.length > 10, `${defs.length} tools`);
    const first = bindSession(defs, 0);
    const builds = tools()._schemaBuilds();
    for (let i = 1; i <= 200; i++) {
      const again = bindSession(defs, i);
      again.forEach((s, j) => {
        assert.strictEqual(s.input, first[j].input, `${defs[j].name}: same input schema on session ${i}`);
        assert.strictEqual(s.output, first[j].output, `${defs[j].name}: same output schema on session ${i}`);
      });
    }
    assert.strictEqual(tools()._schemaBuilds(), builds, '200 sessions built no schema');
  } finally { resetModules(); }
});

test('#41: a changed key (config, modules or content types) builds a new schema, with the change in it', () => {
  try {
    const base = register({ modules: { bulk: true } });
    const patchOf = (r) => r.defs.find((d) => d.name === 'ws_patch').resolveInputSchema({});
    const p0 = patchOf(base);
    assert.strictEqual(patchOf(base), p0, 'same key: same object');
    // allowForce changes the shape (force is offered); the same instance's config is what changed
    const cfgObj = { modules: { bulk: true } };
    const r = registryStrapi(cfgObj); tools().register(r.strapi);
    const before = patchOf(r);
    assert.ok(!z.toJSONSchema(before, { unrepresentable: 'any' }).properties.force, 'no force by default (guard)');
    cfgObj.allowForce = true; r.defs.length = 0; tools().register(r.strapi); // config takes effect through register()
    const after = patchOf(r);
    assert.notStrictEqual(after, before, 'config changed: new schema');
    assert.ok(z.toJSONSchema(after, { unrepresentable: 'any' }).properties.force, 'the new schema offers force');
    // a new content type on the SAME instance and registration joins the uid enum (the key has the content types)
    const same = registryStrapi({ modules: { bulk: true } });
    tools().register(same.strapi);
    const s0 = patchOf(same);
    same.strapi.contentTypes[BLOG] = { uid: BLOG, kind: 'collectionType', options: {}, info: { singularName: 'blog' }, attributes: { title: { type: 'string' } } };
    const s1 = patchOf(same);
    assert.notStrictEqual(s1, s0, 'content types changed: new schema');
    assert.ok(z.toJSONSchema(s1, { unrepresentable: 'any' }).properties.uid.enum.includes(BLOG), 'blog in the uid enum');
    assert.ok(!z.toJSONSchema(s0, { unrepresentable: 'any' }).properties.uid.enum.includes(BLOG), 'the first schema is unchanged');
    assert.strictEqual(patchOf(same), s1, 'and cached again');
    // a module switched on takes effect through register(), which starts a fresh cache: ws_find appears
    const modCfg = { modules: { bulk: true, find: false } };
    const m = registryStrapi(modCfg); tools().register(m.strapi);
    assert.ok(!m.defs.some((d) => d.name === 'ws_find'), 'no ws_find (guard)');
    const patchBefore = patchOf(m);
    modCfg.modules.find = true; m.defs.length = 0; tools().register(m.strapi);
    assert.ok(m.defs.some((d) => d.name === 'ws_find'), 'ws_find registered');
    assert.notStrictEqual(patchOf(m), patchBefore, 're-register: a fresh cache, a new schema');
  } finally { resetModules(); }
});

test('#41: cached schemas still follow lenientArgs at parse time, and strict stays the default', () => {
  const T = tools();
  try {
    const { defs } = register({ modules: {} });
    const s = defs.find((d) => d.name === 'ws_patch').resolveInputSchema({});
    T._setLenient(false);
    assert.ok(!s.safeParse({ uid: PAGE, documentId: 'd', dry_run: 'true' }).success, 'strict refuses "true"');
    T._setLenient(true);
    const r = s.safeParse({ uid: PAGE, documentId: 'd', dry_run: 'true' });
    assert.ok(r.success && r.data.dry_run === true, 'lenient decodes the same cached schema');
    T._setLenient(false);
    // register() with the default config sets strict again
    register({ modules: {} });
    assert.ok(!s.safeParse({ uid: PAGE, documentId: 'd', dry_run: 'true' }).success, 'strict after register with the default config');
  } finally { T._setLenient(false); resetModules(); }
});

test('#41: heap stays flat over 300 sessions of every tool (heap-delta guard)', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  try {
    const { defs } = register({ modules: ALL });
    bindSession(defs, 0); // warm: the one set of schemas
    gc(); gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 1; i <= 300; i++) bindSession(defs, i);
    gc(); gc();
    const grownMb = (process.memoryUsage().heapUsed - h0) / 1e6;
    // before the fix: one full described schema set per session (zod 3.25 keeps every one); 300 sets is far above this
    assert.ok(grownMb < 8, `heap grew ${grownMb.toFixed(1)} MB over 300 sessions`);
    // deterministic where the registry is a strong Map (zod 3.25's zod/v4 build): its size does not move at all
    const map = z.globalRegistry && z.globalRegistry._map;
    if (map instanceof Map) {
      const n0 = map.size;
      for (let i = 1; i <= 300; i++) bindSession(defs, i);
      assert.strictEqual(map.size, n0, 'no metadata entries added by 300 sessions');
    }
  } finally { resetModules(); }
});
