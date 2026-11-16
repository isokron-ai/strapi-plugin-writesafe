'use strict';
// Filters and field-level read rules, with Strapi's own permission checker (content-manager) and CASL abilities.
// Strapi's read sanitizer and validateQuery accept a filter field that ANY read rule allows, whatever its conditions,
// and the read conditions are the OR of every rule's conditions (nothing at all when one rule has none). A filter field
// must be readable on every document the selection may count (modules/_lib/filters.js, unreadableFilterPaths).
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const APP_NM = path.resolve(__dirname, '../../../../node_modules');
const { createMongoAbility } = require(path.join(APP_NM, '@casl/ability'));
const PM = require(path.join(APP_NM, '@strapi/admin/dist/server/server/src/services/permission/permissions-manager/index.js'));
const CMPC = require(path.join(APP_NM, '@strapi/content-manager/dist/server/services/permission-checker.js'));

const PAGE = 'api::page.page';
const CAT = 'api::category.category';
const R = 'plugin::content-manager.explorer.read';
const U = 'plugin::content-manager.explorer.update';
const ME = 7;
const own = { 'createdBy.id': ME };
const DOCS = [
  { id: 1, documentId: 'mine', title: 'Mine', secretCode: 'K-1', createdBy: { id: ME } },
  { id: 2, documentId: 'theirs', title: 'Theirs', secretCode: 'K-2', createdBy: { id: 8 } },
];

/** A tiny evaluator for the filters these queries send: $and, $or, field {$eq}, createdBy {id}. */
const matches = (d, f) => {
  if (!f || !Object.keys(f).length) return true;
  return Object.entries(f).every(([k, v]) => {
    if (k === '$and') return v.every((x) => matches(d, x));
    if (k === '$or') return v.some((x) => matches(d, x));
    if (k === 'createdBy') return d.createdBy && d.createdBy.id === (v.id && typeof v.id === 'object' ? v.id.$eq : v.id);
    if (v && typeof v === 'object' && '$eq' in v) return d[k] === v.$eq;
    if (v && typeof v === 'object' && '$startsWith' in v) return String(d[k] || '').startsWith(v.$startsWith);
    return true;
  });
};

function realStrapi() {
  const schema = {
    uid: PAGE, kind: 'collectionType', modelType: 'contentType', options: { draftAndPublish: false }, info: { singularName: 'page' },
    attributes: {
      title: { type: 'string' }, note: { type: 'text' }, secretCode: { type: 'string' },
      seo: { type: 'component', component: 'shared.seo' },
      category: { type: 'relation', relation: 'manyToOne', target: CAT },
      createdBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
    },
  };
  const cat = { uid: CAT, kind: 'collectionType', modelType: 'contentType', options: { draftAndPublish: false }, info: { singularName: 'category' }, attributes: { name: { type: 'string' }, budget: { type: 'integer' } } };
  const seo = { uid: 'shared.seo', modelType: 'component', attributes: { metaTitle: { type: 'string' }, metaSecret: { type: 'string' } } };
  const seen = [];
  const strapi = {
    contentTypes: { [PAGE]: schema, [CAT]: cat }, components: { 'shared.seo': seo },
    getModel: (u) => ({ [PAGE]: schema, [CAT]: cat, 'shared.seo': seo })[u] || { uid: u, attributes: { id: {} } },
    config: { get: () => undefined },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    db: { config: { connection: { client: 'sqlite' } }, transaction: async (cb) => cb({}), query: () => ({ findOne: async () => null, findMany: async () => [], count: async () => 0 }) },
    documents: () => ({
      count: async (p) => { seen.push(p.filters); return DOCS.filter((d) => matches(d, p.filters)).length; },
      findMany: async (p) => { seen.push(p.filters); return DOCS.filter((d) => matches(d, p.filters)).map((d) => ({ ...d })); },
    }),
  };
  strapi.service = (n) => (n === 'admin::permission' ? { createPermissionsManager: PM, actionProvider: { unstable_aliases: () => [] } } : undefined);
  const checker = CMPC.default({ strapi });
  strapi.plugin = (n) => (n === 'content-manager' ? { service: () => checker } : undefined);
  global.strapi = strapi;
  return { strapi, seen };
}
const ctxFor = (rules) => ({ userAbility: createMongoAbility(rules), user: { id: ME } });
const quiet = () => require('../server/modules').load(null, { modules: { history: false } });

const MIXED = [{ action: U, subject: PAGE }, { action: R, subject: PAGE, fields: ['title'] }, { action: R, subject: PAGE, fields: ['title', 'secretCode'], conditions: own }];
const GUESS = { secretCode: { $eq: 'K-2' } };

test('two read rules (title on every page; title and secretCode on own pages): ws_bulk/ws_replace selection refuses a filter on secretCode', async () => {
  quiet();
  const { strapi, seen } = realStrapi();
  const J = require('../server/modules/_bulk/jobs');
  const ctx = ctxFor(MIXED);
  let err = null;
  try { await J.match(strapi, ctx, PAGE, undefined, GUESS, 'patch', 1000); } catch (e) { err = e.payload || { message: e.message }; }
  assert.ok(err, 'refused');
  assert.strictEqual(err.code, 'invalid');
  assert.deepStrictEqual(err.fields, ['secretCode']);
  assert.strictEqual(seen.length, 0, 'nothing counted');
  // a field readable on every page still filters
  const ok = await J.match(strapi, ctx, PAGE, undefined, { title: { $eq: 'Theirs' } }, 'patch', 1000);
  assert.strictEqual(ok.count, 1);
});

test('the same token: ws_find refuses a filter on secretCode (no rows of other users\' pages by guessed value)', async () => {
  quiet();
  const { strapi, seen } = realStrapi();
  const tools = require('../server/tools');
  const FIND = require('../server/modules/find');
  const def = FIND.tools(strapi, tools.apiFor(strapi)).find((d) => d.name === 'ws_find');
  const r = await def.createHandler(strapi, ctxFor(MIXED))({ args: { uid: PAGE, filters: GUESS } });
  assert.ok(r.isError, JSON.stringify(r.structuredContent));
  assert.strictEqual(r.structuredContent.error.code, 'invalid');
  assert.ok(!JSON.stringify(r).includes('theirs'));
  assert.strictEqual(seen.length, 0);
});

test('one read rule on own pages (every field): a filter on secretCode is allowed and counts only own pages', async () => {
  quiet();
  const { strapi } = realStrapi();
  const J = require('../server/modules/_bulk/jobs');
  const ctx = ctxFor([{ action: U, subject: PAGE }, { action: R, subject: PAGE, conditions: own }]);
  const hit = await J.match(strapi, ctx, PAGE, undefined, GUESS, 'patch', 1000);
  const miss = await J.match(strapi, ctx, PAGE, undefined, { secretCode: { $eq: 'K-9' } }, 'patch', 1000);
  const mine = await J.match(strapi, ctx, PAGE, undefined, { secretCode: { $eq: 'K-1' } }, 'patch', 1000);
  assert.strictEqual(hit.count, 0, 'another user\'s value gives no signal');
  assert.strictEqual(miss.count, 0);
  assert.deepStrictEqual(mine.ids, ['mine']);
});

test('field-level rules: accepted when a rule without conditions allows the field, or every read rule does', () => {
  const FL = require('../server/modules/_lib/filters');
  const { strapi } = realStrapi();
  const bad = (rules, p, locale) => FL.unreadableFilterPaths(strapi, PAGE, createMongoAbility(rules), locale, [p]);
  assert.deepStrictEqual(bad(MIXED, 'title'), [], 'title: a condition-free rule allows it');
  assert.deepStrictEqual(bad(MIXED, 'secretCode'), ['secretCode']);
  assert.deepStrictEqual(bad([{ action: R, subject: PAGE, fields: ['title', 'secretCode'], conditions: own }], 'secretCode'), [], 'every rule allows it');
  assert.deepStrictEqual(bad([{ action: R, subject: PAGE, conditions: own }, { action: R, subject: PAGE, fields: ['title'], conditions: { 'createdBy.id': 9 } }], 'secretCode'), ['secretCode'], 'two conditional rules, one without the field');
  const loc = [{ action: R, subject: PAGE, fields: ['title', 'secretCode'], conditions: { locale: { $in: ['en'] } } }, { action: R, subject: PAGE, fields: ['title'], conditions: own }];
  assert.deepStrictEqual(bad(loc, 'secretCode', 'en'), [], 'a locale-only rule containing this locale counts as condition-free');
  assert.deepStrictEqual(bad(loc, 'secretCode', 'fr'), ['secretCode'], 'not for another locale');
  assert.deepStrictEqual(bad([{ action: R, subject: PAGE }, { action: R, subject: PAGE, fields: ['secretCode'], inverted: true }], 'title'), ['title'], 'an inverted rule: fail closed');
  assert.deepStrictEqual(FL.unreadableFilterPaths(strapi, PAGE, {}, undefined, ['title']), ['title'], 'no rules known: fail closed');
});

test('filter paths: components by sub-field (whole only under a comparison), relations as refs to their target, $and/$or/$not followed', () => {
  const FL = require('../server/modules/_lib/filters');
  const strapi = {
    contentTypes: { [PAGE]: { attributes: { title: { type: 'string' }, seo: { type: 'component', component: 'shared.seo' }, author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' } } } },
    components: { 'shared.seo': { attributes: { metaTitle: { type: 'string' } } } },
  };
  const r = FL.filterPaths(strapi, PAGE, { $and: [{ title: { $eq: 'x' } }, { $or: [{ seo: { metaTitle: { $eq: 'y' } } }, { $not: { documentId: { $eq: 'd' } } }] }], author: { name: { $eq: 'n' } } });
  assert.deepStrictEqual(r.paths.sort(), ['author', 'seo.metaTitle', 'title']);
  assert.deepStrictEqual(r.refs.map((x) => [x.path, x.target]), [['author', 'api::author.author']]);
  assert.deepStrictEqual(FL.filterPaths(strapi, PAGE, { seo: { $null: true } }).paths, ['seo'], 'compared whole');
  assert.deepStrictEqual(FL.filterPaths(strapi, PAGE, { seo: { $not: { metaTitle: 'x' } } }).paths, ['seo.metaTitle'], 'a logical operator is not a comparison of the whole');
});

test('a job stored before the upgrade (qfilters without the read conditions) only touches documents the token can read now', async () => {
  quiet();
  const { strapi, seen } = realStrapi();
  const J = require('../server/modules/_bulk/jobs');
  const ctx = ctxFor([{ action: U, subject: PAGE }, { action: R, subject: PAGE, conditions: own }]);
  const job = { uid: PAGE, locale: null, qfilters: { title: { $startsWith: '' } } };
  const still = await J.stillMatching(strapi, job, ['mine', 'theirs'], ctx);
  assert.deepStrictEqual([...still], ['mine']);
  assert.ok(JSON.stringify(seen[seen.length - 1]).includes('createdBy'), 'the read conditions are applied again');
});

// ---------------------------------------------------------------- review of #47
const SUPER = [{ action: U, subject: PAGE }, { action: R, subject: PAGE }, { action: R, subject: CAT }];
const findCall = async (strapi, rules, args) => {
  const tools = require('../server/tools');
  const FIND = require('../server/modules/find');
  const def = FIND.tools(strapi, tools.apiFor(strapi)).find((d) => d.name === 'ws_find');
  return def.createHandler(strapi, ctxFor(rules))({ args: { uid: PAGE, ...args } });
};

test('ws_find sort: the two-role token may not sort by secretCode (the order would show other users\' values)', async () => {
  quiet();
  const { strapi, seen } = realStrapi();
  const r = await findCall(strapi, MIXED, { sort: 'secretCode:asc' });
  assert.ok(r.isError, JSON.stringify(r.structuredContent));
  assert.strictEqual(r.structuredContent.error.code, 'invalid');
  assert.strictEqual(seen.length, 0);
  const ok = await findCall(strapi, MIXED, { sort: 'title:asc' });
  assert.ok(!ok.isError, JSON.stringify(ok.structuredContent));
});

test('relation filters: a super admin may filter on category.name (ws_bulk\'s own example); the two-role token may not filter on a target field only a conditional rule allows', async () => {
  quiet();
  const { strapi } = realStrapi();
  const J = require('../server/modules/_bulk/jobs');
  const FL = require('../server/modules/_lib/filters');
  const sup = await J.match(strapi, ctxFor(SUPER), PAGE, undefined, { category: { name: { $eq: 'News' } } }, 'patch', 1000);
  assert.strictEqual(typeof sup.count, 'number', 'accepted');
  const twoRoleCat = [...MIXED, { action: R, subject: CAT, fields: ['name'] }, { action: R, subject: CAT, fields: ['name', 'budget'], conditions: own }];
  const ab = createMongoAbility(twoRoleCat);
  // MIXED's page rules do not list `category` itself, so the relation path is refused too; the target field is named
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, ab, undefined, { category: { budget: { $gt: 1 } } }), ['category', 'category.budget']);
  let err = null;
  try { await J.match(strapi, ctxFor(twoRoleCat.concat([{ action: R, subject: PAGE, fields: ['category'] }])), PAGE, undefined, { category: { budget: { $gt: 1 } } }, 'patch', 1000); } catch (e) { err = e.payload; }
  assert.ok(err && err.code === 'invalid' && err.fields.includes('category.budget'), JSON.stringify(err));
  // inside a relation only a condition-free rule counts: the target's conditions are not part of the page query
  const ownCats = createMongoAbility([{ action: R, subject: PAGE }, { action: R, subject: CAT, conditions: own }]);
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, ownCats, undefined, { category: { name: { $eq: 'x' } } }), ['category.name']);
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, createMongoAbility([{ action: R, subject: PAGE }]), undefined, { category: { name: 'x' } }), ['category.name'], 'no read rule on the target: refused');
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, createMongoAbility([{ action: R, subject: PAGE }]), undefined, { category: { documentId: 'c1' } }), [], 'the target\'s identity is always free');
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, createMongoAbility([{ action: R, subject: PAGE }]), undefined, { createdBy: { firstname: 'Ann' } }), ['createdBy.firstname'], 'admin users: refused');
  // media: the file type's fields follow the Media Library's read permission (plugin::upload.read)
  strapi.contentTypes['plugin::upload.file'] = { uid: 'plugin::upload.file', attributes: { name: { type: 'string' } } };
  strapi.contentTypes[PAGE].attributes.cover = { type: 'media', multiple: false };
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, createMongoAbility([{ action: R, subject: PAGE }, { action: 'plugin::upload.read', subject: 'plugin::upload.file' }]), undefined, { cover: { name: { $contains: 'x' } } }), []);
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, createMongoAbility([{ action: R, subject: PAGE }, { action: 'plugin::upload.read', subject: 'plugin::upload.file', conditions: { 'createdBy.id': ME } }]), undefined, { cover: { name: { $contains: 'x' } } }), ['cover.name'], 'own files only: refused');
});

test('component compared whole: allowed when a rule covers every leaf, refused when a leaf is only conditionally readable', () => {
  const FL = require('../server/modules/_lib/filters');
  const { strapi } = realStrapi();
  const ownAll = createMongoAbility([{ action: R, subject: PAGE, fields: ['title', 'seo.metaTitle', 'seo.metaSecret'], conditions: own }]);
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, ownAll, undefined, { seo: { $null: true } }), []);
  const mixed = createMongoAbility([{ action: R, subject: PAGE, fields: ['title', 'seo.metaTitle'] }, { action: R, subject: PAGE, fields: ['title', 'seo.metaTitle', 'seo.metaSecret'], conditions: own }]);
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, mixed, undefined, { seo: { $null: true } }), ['seo']);
  assert.deepStrictEqual(FL.filterProblems(strapi, PAGE, mixed, undefined, { seo: { metaTitle: { $eq: 'x' } } }), []);
});

test('a running job whose token lost read access to the type skips every document', async () => {
  quiet();
  const { strapi, seen } = realStrapi();
  const J = require('../server/modules/_bulk/jobs');
  const job = { uid: PAGE, locale: null, qfilters: {} };
  const still = await J.stillMatching(strapi, job, ['mine', 'theirs'], ctxFor([{ action: U, subject: PAGE }]));
  assert.deepStrictEqual([...still], []);
  assert.strictEqual(seen.length, 0);
});
