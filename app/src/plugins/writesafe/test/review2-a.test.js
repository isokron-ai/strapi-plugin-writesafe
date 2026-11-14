'use strict';
// Unit tests for the second review round of PR #17 (stream A): N1 (implicit claim retention), N4 (transient epoch
// errors), N5 (row keys from raw relation refs), N6 (morph relations hashed, uncovered types named), N7.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../server/model');
const E = require('../server/engine');
const G = require('../server/guidance');
const RET = require('../server/retention');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };
const log = { warn() {}, info() {}, error() {} };
const PAGE = 'api::page.page';
const base = () => ({
  log,
  contentTypes: {
    [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, attributes: {
      title: { type: 'string' },
      sections: { type: 'dynamiczone', components: ['l10n.figure'] },
      owner: { type: 'relation', relation: 'morphToOne' },
    } },
    'api::topic.topic': { uid: 'api::topic.topic', kind: 'collectionType', pluginOptions: { i18n: { localized: true } }, attributes: { name: { type: 'string' } } },
  },
  components: { 'l10n.figure': { attributes: { caption: { type: 'string' }, topic: { type: 'relation', relation: 'manyToOne', target: 'api::topic.topic' } } } },
});

// ---------------------------------------------------------------- N1
test('N1: implicit claims have their own short retention (default 10 minutes); keys keep keyHours', () => {
  assert.strictEqual(RET.DEFAULTS.implicitClaimMinutes, 10);
  assert.strictEqual(RET.DEFAULTS.keyHours, 72);
  assert.throws(() => RET.configure({ implicitClaimMinutes: -1 }));
  RET.configure({});
});

// ---------------------------------------------------------------- N4: transient errors do not flip the epoch
const fresh = () => { delete require.cache[require.resolve('../server/epoch')]; return require('../server/epoch'); };
test('N4: a query or connection error keeps the last epoch read from the database', async () => {
  const EP = fresh();
  M.setRowEpoch('epoch-from-db', true);
  EP._markLoaded(Date.now());
  await EP.refresh({ log, db: { inTransaction: () => false, getSchemaConnection: () => ({ hasTable: async () => { throw new Error('Knex: Timeout acquiring a connection'); } }) } });
  assert.deepStrictEqual(M.rowEpoch(), { epoch: 'epoch-from-db', fromDb: true });
});

test('N4: the table read fine but is gone and cannot be recreated: fail closed at once', async () => {
  const EP = fresh();
  M.setRowEpoch('epoch-from-db', true);
  EP._markLoaded(Date.now());
  await EP.refresh({ log, db: { inTransaction: () => false, getSchemaConnection: () => ({ hasTable: async () => false, createTable: async () => { throw new Error('permission denied'); } }) } });
  assert.notStrictEqual(M.rowEpoch().epoch, 'epoch-from-db');
  assert.strictEqual(M.rowEpoch().fromDb, false);
});

test('N4: errors that last longer than the grace period fail closed', async () => {
  const EP = fresh();
  M.setRowEpoch('epoch-from-db', true);
  EP._markLoaded(Date.now() - 61000);
  await EP.refresh({ log, db: { inTransaction: () => false, getSchemaConnection: () => ({ hasTable: async () => { throw new Error('connection reset'); } }) } });
  assert.notStrictEqual(M.rowEpoch().epoch, 'epoch-from-db');
});

// ---------------------------------------------------------------- N5: keys bind a relation's linked locale
test('N5: a row key changes when a relation inside the row links another locale', () => {
  const s = base();
  const attr = s.contentTypes[PAGE].attributes.sections;
  const scope = M.keyScope(PAGE, 'd', 'en', 'sections');
  const row = (loc) => ({ id: 5, __component: 'l10n.figure', caption: 'c', topic: { id: 9, documentId: 't1', locale: loc } });
  const en = M.rowHandle(s, 'dynamiczone', attr, row('en'), 0, scope);
  assert.notStrictEqual(M.rowHandle(s, 'dynamiczone', attr, row('fr'), 0, scope), en);
  // ws_get read the row while its topic linked en; a colleague switched the link to fr (the normalized row, a bare
  // documentId, is identical): the key read before must be stale, and the key ws_get shows now must work
  const rawEn = { documentId: 'd', locale: 'en', title: 't', sections: [row('en')] };
  const rawFr = { documentId: 'd', locale: 'en', title: 't', sections: [row('fr')] };
  const keyEn = M.presentDoc(s, PAGE, rawEn, undefined, { full: rawEn }).rows.sections[0];
  const keyFr = M.presentDoc(s, PAGE, rawFr, undefined, { full: rawFr }).rows.sections[0];
  assert.notStrictEqual(keyEn, keyFr, 'ws_get shows another key once the linked locale changed');
  const norm = M.normalize(s, PAGE, rawFr).sections;
  assert.throws(() => E.applyRowOps(s, PAGE, 'sections', attr, 'dynamiczone', norm, [{ op: 'update', field: 'sections', key: keyEn, data: { caption: 'y' } }], [], scope, rawFr.sections),
    (e) => e.payload.code === 'stale_row_key', 'a key read while the relation linked en is stale once it links fr');
  const r = E.applyRowOps(s, PAGE, 'sections', attr, 'dynamiczone', norm, [{ op: 'update', field: 'sections', key: keyFr, data: { caption: 'x' } }], [], scope, rawFr.sections);
  assert.strictEqual(r.list[0].caption, 'x');
});

// ---------------------------------------------------------------- N6
test('N6: a morph relation is hashed as (__type, documentId) and populated; the type stays covered', () => {
  const s = base();
  const d = (type) => ({ documentId: 'd', locale: null, title: 't', sections: [], owner: { __type: type, id: 3, documentId: 'o1' } });
  assert.notStrictEqual(M.versionOf(s, PAGE, d('api::a.a')), M.versionOf(s, PAGE, d('api::b.b')));
  assert.ok(M.populateFor(s, PAGE).owner, 'the morph relation is read');
  assert.strictEqual(M.unhashable(s, PAGE), null);
  assert.ok(E.writableUids(s).includes(PAGE));
});

test('N6: types the version cannot cover are named in the instructions, with the reason', () => {
  const text = G.instructions(['api::page.page'], 'guard', [], [{ uid: 'api::deep.deep', reason: 'its components are nested deeper than 8 levels (x.c8)' }]);
  assert.match(text, /api::deep\.deep/);
  assert.match(text, /nested deeper than 8/);
  assert.doesNotMatch(G.instructions(['api::page.page'], 'guard', []), /not covered/i);
  const s = base();
  s.contentTypes['api::deep.deep'] = { uid: 'api::deep.deep', kind: 'collectionType', attributes: { c: { type: 'component', component: 'x.c0' } } };
  for (let i = 0; i < 10; i += 1) s.components[`x.c${i}`] = { attributes: { next: { type: 'component', component: `x.c${i + 1}` } } };
  s.components['x.c10'] = { attributes: { v: { type: 'string' } } };
  assert.deepStrictEqual(E.uncoveredUids(s).map((x) => x.uid), ['api::deep.deep']);
});

// ---------------------------------------------------------------- N7
test('N7: create and delete pass the raw versions to the history hooks', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'modules', f, 'index.js'), 'utf8');
  assert.match(src('create'), /versions:/);
  assert.match(src('delete'), /versions:/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'tools.js'), 'utf8'), /rows you added or named/);
});
