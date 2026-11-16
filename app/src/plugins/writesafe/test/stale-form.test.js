'use strict';

// The stale form guard's server half (server/compat/stale-form.js): route recognition, the 409 error, the revision
// reader the version code can use (D1 follow-up). The database paths run in tests/test_stale_form.py.
const test = require('node:test');
const assert = require('node:assert');
const SF = require('../server/compat/stale-form');

const strapi = {
  contentTypes: { 'api::page.page': { kind: 'collectionType' }, 'api::homepage.homepage': { kind: 'singleType' } },
  db: { config: { connection: { client: 'postgres' } } },
};

test('cmRoute: Content Manager entry routes, collection and single types', () => {
  assert.deepStrictEqual(SF.cmRoute(strapi, '/content-manager/collection-types/api::page.page/abc'), { uid: 'api::page.page', documentId: 'abc', action: null });
  assert.deepStrictEqual(SF.cmRoute(strapi, '/content-manager/collection-types/api::page.page/abc/actions/publish'), { uid: 'api::page.page', documentId: 'abc', action: 'publish' });
  assert.deepStrictEqual(SF.cmRoute(strapi, '/content-manager/single-types/api::homepage.homepage/actions/discard'), { uid: 'api::homepage.homepage', documentId: null, action: 'discard' });
  assert.strictEqual(SF.cmRoute(strapi, '/content-manager/collection-types/api::page.page/actions/bulkPublish'), null);
  assert.strictEqual(SF.cmRoute(strapi, '/content-manager/collection-types/api::homepage.homepage/x'), null, 'kind must match');
  assert.strictEqual(SF.cmRoute(strapi, '/api/pages/abc'), null);
});

test('conflictError: an exposed 409 ConflictError with details.code stale_form', () => {
  const e = SF.conflictError('m', { reason: 'conflict' });
  assert.strictEqual(e.status, 409);
  assert.strictEqual(e.expose, true);
  assert.strictEqual(e.name, 'ConflictError');
  assert.deepStrictEqual(e.details, { code: 'stale_form', reason: 'conflict' });
  const { errors } = require('@strapi/utils');
  assert.ok(e instanceof errors.HttpError, 'strapi::errors answers an HttpError with its status');
});

test('revision: reads the document\'s counter (0 when absent), with a locking read on request', async () => {
  const seen = [];
  const rows = { [SF.docKey('api::page.page', 'abc')]: { rev: '7' } };
  const conn = (table) => {
    const q = { table, lock: false, k: null };
    const api = {
      select() { return api; },
      where(w) { q.k = w.k; return api; },
      forUpdate() { q.lock = true; return api; },
      async first() { seen.push(q); return rows[q.k]; },
    };
    return api;
  };
  assert.strictEqual(await SF.revision(strapi, 'api::page.page', 'abc', conn), 7);
  assert.strictEqual(await SF.revision(strapi, 'api::page.page', 'none', conn, { lock: true }), 0);
  assert.strictEqual(seen[0].table, SF.REV);
  assert.deepStrictEqual(seen.map((x) => x.lock), [false, true]);
});

test('D1: the version token binds the content revision: the same content after A -> B -> A gives a new token', () => {
  const M = require('../server/model');
  const strapi2 = { contentTypes: { 'api::page.page': { attributes: { title: { type: 'string' } } } }, components: {} };
  const at = (title, rev) => Object.assign({ documentId: 'd1', title }, rev === undefined ? {} : { [M.REVISION]: rev });
  const a0 = M.versionOf(strapi2, 'api::page.page', at('A', 0));
  const b1 = M.versionOf(strapi2, 'api::page.page', at('B', 1));
  const a2 = M.versionOf(strapi2, 'api::page.page', at('A', 2));
  assert.notStrictEqual(a0, b1);
  assert.notStrictEqual(a0, a2, 'A -> B -> A: the old token never matches again');
  assert.strictEqual(M.versionOf(strapi2, 'api::page.page', at('A')), a0, 'no revision attached reads as 0');
  assert.ok(M.versionMatches(strapi2, 'api::page.page', a2, at('A', 2)));
  assert.ok(!M.versionMatches(strapi2, 'api::page.page', a0, at('A', 2)));
  const spread = { ...at('A', 2) };
  assert.strictEqual(M.versionOf(strapi2, 'api::page.page', spread), a2, 'an object spread keeps the revision');
  assert.ok(!JSON.stringify(at('A', 2)).includes('2'), 'the revision never reaches JSON');
  assert.ok(M.isVersionToken(a2));
  const E = require('../server/engine');
  assert.throws(() => E.assertVersion(`v2.${a2.slice(3)}`), (e) => e.payload.code === 'version_format' && e.payload.requires_reread === true && /before writesafe bound/.test(e.payload.message),
    'a v2 token (before the upgrade) has its own code, not "the document changed"');
});

test('D1: SF.attach puts the revision on Document Service results', () => {
  const M = require('../server/model');
  const one = SF.attach({ documentId: 'x' }, 4);
  assert.strictEqual(one[M.REVISION], 4);
  const many = SF.attach([{ documentId: 'x' }, { documentId: 'y' }, null], 5);
  assert.deepStrictEqual(many.filter(Boolean).map((d) => d[M.REVISION]), [5, 5]);
  const r = SF.attach({ documentId: 'x', entries: [{ id: 1 }] }, 6);
  assert.strictEqual(r.entries[0][M.REVISION], 6);
});

test('D1: the content revision moves when the draft content changes, not on a write that leaves it (SQLite, knex)', async (t) => {
  let knex;
  try { knex = require('knex'); } catch { t.skip('knex not installed here'); return; }
  const M = require('../server/model');
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const strapi3 = { contentTypes: { 'api::page.page': { attributes: { title: { type: 'string' } } } }, components: {}, db: { connection: db, config: { connection: { client: 'sqlite' } } }, log: { error() {} } };
  strapi3.db.getSchemaConnection = () => db.schema;
  try {
    assert.ok(await SF.ensureTables(strapi3));
    const doc = (title, id = 1) => ({ documentId: 'd1', title, id });
    const step = (b, a) => db.transaction((trx) => SF.contentRevision(strapi3, trx, 'api::page.page', 'd1', '', b, a));
    assert.strictEqual(await step(doc('A'), doc('A', 9)), 0, 'the same content (a row id moved): no new revision');
    assert.strictEqual(await step(null, doc('B')), 1, 'A -> B');
    assert.strictEqual(await step(null, doc('A')), 2, 'B -> A: a new revision again');
    const tok = (title, rev) => M.versionOf(strapi3, 'api::page.page', { documentId: 'd1', title, [M.REVISION]: rev });
    assert.notStrictEqual(tok('A', 0), tok('A', 2), 'the token after A -> B -> A differs from the first one');
  } finally {
    await db.destroy();
  }
});

test('D1 (review): a delete moves the content revision of a draft that had no row, so a re-create gets a new token', async (t) => {
  let knex;
  try { knex = require('knex'); } catch { t.skip('knex not installed here'); return; }
  const M = require('../server/model');
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const strapi3 = { contentTypes: { 'api::page.page': { kind: 'collectionType', attributes: { title: { type: 'string' } } } }, components: {}, db: { connection: db, config: { connection: { client: 'sqlite' } } }, log: { error() {}, info() {}, warn() {} } };
  strapi3.db.getSchemaConnection = () => db.schema;
  const saved = { ...SF.state };
  try {
    assert.ok(await SF.ensureTables(strapi3));
    Object.assign(SF.state, { tracking: true, enabled: false });
    const tok = (rev) => M.versionOf(strapi3, 'api::page.page', { documentId: 'd1', title: 'A', [M.REVISION]: rev });
    const revOf = async () => { const r = await db(SF.CREV).select(['rev']).where({ k: SF.crevKey('api::page.page', 'd1', '') }).first(); return r ? Number(r.rev) : 0; };
    const t0 = tok(await revOf()); // created through documents().create: no row yet, revision 0
    let called = 0;
    await db.transaction((trx) => SF.around(strapi3, trx, { action: 'delete', params: {} }, 'api::page.page', 'd1', true, async () => { called += 1; return { documentId: 'd1' }; }));
    assert.strictEqual(called, 1);
    assert.strictEqual(await revOf(), 1, 'the delete inserted the row and moved it');
    assert.notStrictEqual(tok(await revOf()), t0, 'the same content re-created under the old documentId: a new token');
    await db.transaction((trx) => SF.around(strapi3, trx, { action: 'delete', params: {} }, 'api::page.page', 'd1', true, async () => ({ documentId: 'd1' })));
    assert.strictEqual(await revOf(), 2, 'each delete moves it again');
    // after the re-create, the first update counts from the deleted mark: the same content A is a new revision
    const r3 = await db.transaction((trx) => SF.contentRevision(strapi3, trx, 'api::page.page', 'd1', '', null, { documentId: 'd1', title: 'A' }));
    assert.strictEqual(r3, 3);
  } finally {
    Object.assign(SF.state, saved);
    await db.destroy();
  }
});

test('D1 (review): a delete of every locale moves each locale\'s revision, rows or not', async (t) => {
  let knex;
  try { knex = require('knex'); } catch { t.skip('knex not installed here'); return; }
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const strapi3 = { contentTypes: { 'api::page.page': { kind: 'collectionType', pluginOptions: { i18n: { localized: true } }, attributes: { title: { type: 'string' } } } }, components: {}, db: { connection: db, config: { connection: { client: 'sqlite' } } }, log: { error() {}, info() {}, warn() {} } };
  strapi3.db.getSchemaConnection = () => db.schema;
  strapi3.db.query = () => ({ findMany: async () => [{ locale: 'en' }, { locale: 'fr' }] });
  try {
    assert.ok(await SF.ensureTables(strapi3));
    await db(SF.CREV).insert({ k: SF.crevKey('api::page.page', 'd2', 'de'), uid: 'api::page.page', document_id: 'd2', locale: 'de', rev: 4, fp: 'x', at_ms: 0 });
    const locales = await db.transaction((trx) => SF.deletedLocales(strapi3, trx, 'api::page.page', 'd2', '*'));
    assert.deepStrictEqual(locales.sort(), ['de', 'en', 'fr']);
    await db.transaction((trx) => SF.contentRevisionDeleted(strapi3, trx, 'api::page.page', 'd2', locales));
    const rows = await db(SF.CREV).select(['locale', 'rev', 'fp']).where({ document_id: 'd2' }).orderBy('locale');
    assert.deepStrictEqual(rows.map((r) => [r.locale, Number(r.rev), r.fp]), [['de', 5, 'deleted'], ['en', 1, 'deleted'], ['fr', 1, 'deleted']]);
    assert.deepStrictEqual(await db.transaction((trx) => SF.deletedLocales(strapi3, trx, 'api::page.page', 'd2', 'fr')), ['fr']);
  } finally {
    await db.destroy();
  }
});

test('review: every query on the guard\'s tables names the database schema (Postgres connection.schema)', (t) => {
  let knex;
  try { knex = require('knex'); } catch { t.skip('knex not installed here'); return; }
  const pg = knex({ client: 'pg' }); // builds SQL only, never connects
  const withSchema = { db: { getSchemaName: () => 'cms' } };
  const none = { db: { getSchemaName: () => undefined } };
  assert.match(SF.tb(withSchema, pg, SF.CREV).select('rev').where({ k: 'x' }).toString(), /from "cms"\."writesafe_content_rev"/);
  assert.match(SF.tb(none, pg, SF.REV).select('rev').toString(), /from "writesafe_doc_rev"/);
  assert.match(SF.tb({ db: {} }, pg, SF.JOURNAL).select('rev').toString(), /from "writesafe_journal"/);
  // no raw table query is left without the helper
  const src = require('fs').readFileSync(require.resolve('../server/compat/stale-form'), 'utf8');
  assert.deepStrictEqual(src.match(/\b(?:trx|tx|knex|conn|q|connection)\((?:REV|JOURNAL|CREV)\)/g), null);
  pg.destroy();
});


test('N2 (second review, MySQL): a form write never takes a locking read of a missing counter row; it inserts it first', async (t) => {
  let knex;
  try { knex = require('knex'); } catch { t.skip('knex not installed here'); return; }
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const strapi3 = { contentTypes: { 'api::page.page': { kind: 'collectionType', attributes: { title: { type: 'string' } } } }, components: {}, db: { connection: db, config: { connection: { client: 'sqlite' } } }, log: { error() {}, info() {}, warn() {} } };
  strapi3.db.getSchemaConnection = () => db.schema;
  const log = [];
  const onQuery = (q) => { const w = String(q.sql).split(' ')[0].toLowerCase(); if (w === 'select' || w === 'insert') log.push(w); };
  try {
    assert.ok(await SF.ensureTables(strapi3));
    // from here on the guard takes MySQL's path (FOR UPDATE); SQLite ignores the lock clause, the order is what counts
    strapi3.db.config.connection.client = 'mysql2';
    db.on('query', onQuery);
    const run = (doc) => db.transaction((trx) => {
      const rec = (name) => { const b = trx(name); const fu = b.forUpdate.bind(b); b.forUpdate = (...a) => { log.push('for-update'); return fu(...a); }; return b; };
      return SF.lockRev(strapi3, rec, 'api::page.page', doc, true);
    });
    const first = await run('fresh');
    assert.deepStrictEqual(log, ['select', 'insert', 'for-update', 'select'], 'missing row: plain read, insert, then the locking read');
    assert.ok(!first.missing && first.rev === 0 && first.jrev === 0);
    log.length = 0;
    await run('fresh');
    assert.deepStrictEqual(log, ['select', 'for-update', 'select'], 'existing row: no insert, a record lock');
    // every caller in the guard asks for the row to be made first (Saves, publishes, discards, agent writes, opaque entries)
    const src = require('fs').readFileSync(require.resolve('../server/compat/stale-form'), 'utf8');
    const calls = src.match(/await lockRev\(strapi, trx, uid, documentId, [^)]*\)/g) || [];
    assert.ok(calls.length >= 3, calls.join('\n'));
    assert.deepStrictEqual(calls.filter((c) => !/, true\)$/.test(c)), [], 'a lockRev call without create');
  } finally {
    db.removeListener('query', onQuery);
    await db.destroy();
  }
});
