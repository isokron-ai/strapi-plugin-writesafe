'use strict';
// Unit tests for 1.0 hardening stream B (locking): the one ordered lock (compat/db.js lockDocuments, item 11, N6),
// the Document Service lock (compat/document-lock.js, item 11 with 16a), the widened retry set (item 16, N11) and the
// config switch. The deadlock itself is measured against real databases: tests/test_locking.py and
// tests/stress/lock_soak.py. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };
const DB = require('../server/compat/db');
// Loaded leniently so that this file reports each item red, one by one, against a build without them (rc.2).
const optional = (m) => { try { return require(m); } catch { return null; } };
const DL = optional('../server/compat/document-lock') || {
  middleware: () => { throw new Error('compat/document-lock.js missing'); }, install: () => { throw new Error('compat/document-lock.js missing'); },
  stats: {}, ACTIONS: new Set(),
};
const CFG = require('../server/config');
const C = require('../server/compat');

const PAGE = 'api::page.page';
const GUIDE = 'api::guide.guide';
const NODP = 'api::author.author';

/**
 * A strapi double: queryBuilder records each statement (uid, select, where, orderBy, forUpdate) and returns `rows`;
 * db.transaction joins one transactor per "connection" (a new one per top-level call, the same one when nested), as
 * Strapi's does.
 */
function fakeStrapi(client, rowsFor = () => []) {
  const statements = [];
  let current = null;
  let n = 0;
  const contentTypes = {
    [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true } },
    [GUIDE]: { uid: GUIDE, kind: 'collectionType', options: { draftAndPublish: true }, pluginOptions: { i18n: { localized: true } } },
    [NODP]: { uid: NODP, kind: 'collectionType', options: { draftAndPublish: false } },
  };
  const strapi = {
    contentTypes,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    transactions: 0,
    raws: [],
    db: {
      config: { connection: { client } },
      queryBuilder(uid) {
        const st = { uid, forUpdate: false };
        const qb = {
          select(cols) { st.select = cols; return qb; },
          where(w) { st.where = w; return qb; },
          orderBy(o) { st.orderBy = o; return qb; },
          forUpdate() { st.forUpdate = true; return qb; },
          first() { st.first = true; return qb; },
          async execute() { statements.push(st); return rowsFor(st); },
        };
        return qb;
      },
      async transaction(cb) {
        if (current) return cb({ trx: current });
        strapi.transactions += 1;
        current = { id: (n += 1), raw: async (sql) => { strapi.raws.push(sql); } };
        try { return await cb({ trx: current }); } finally { current = null; }
      },
    },
  };
  return { strapi, statements };
}
// Each lock runs its statement until two runs agree (review of PR #15, item 2): fold the repeats.
const uniq = (sts) => sts.filter((s, i) => !(i && sts[i - 1].uid === s.uid && JSON.stringify(sts[i - 1].where) === JSON.stringify(s.where)));

// ---------------------------------------------------------------- item 11: one ordered lock
test('item 11: lockDocuments locks every locale draft row, one statement per document, types then documents sorted, ORDER BY id', async () => {
  const { strapi, statements } = fakeStrapi('postgres');
  await DB.lockDocuments(strapi, [
    { uid: PAGE, documentId: 'b' }, { uid: GUIDE, documentId: 'g1' }, { uid: PAGE, documentId: 'a' }, { uid: PAGE, documentId: 'b' },
  ]);
  assert.deepStrictEqual(uniq(statements).map((s) => [s.uid, s.where.documentId]), [[GUIDE, 'g1'], [PAGE, 'a'], [PAGE, 'b']],
    'content types in uid order, documents in documentId order, duplicates folded, the same single-document statement for every caller');
  for (const s of statements) {
    assert.strictEqual(s.forUpdate, true);
    assert.deepStrictEqual(s.orderBy, { id: 'asc' });
    assert.notStrictEqual(s.first, true, 'no .first(): every matching row is locked (N6)');
    assert.strictEqual('locale' in s.where, false, 'no locale filter: every locale of the document');
    assert.strictEqual(s.where.publishedAt, null, 'draft rows only on draft & publish types');
    assert.strictEqual(typeof s.where.documentId, 'string', 'never IN (...): MySQL may scan another index for a list');
  }
  assert.ok(statements[0].select.includes('locale'), 'localized types return each row\'s locale');
});

test('item 11: a type without draft & publish locks every row of the document (no publishedAt filter)', async () => {
  const { strapi, statements } = fakeStrapi('mysql');
  await DB.lockDocuments(strapi, [{ uid: NODP, documentId: 'x' }]);
  assert.deepStrictEqual(statements[0].where, { documentId: 'x' });
});

test('item 11: a transaction does not lock a document twice; opts.rows re-reads it with the locking read', async () => {
  const { strapi, statements } = fakeStrapi('postgres', (st) => [{ id: 7, documentId: st.where.documentId, updatedAt: 't' }]);
  await strapi.db.transaction(async ({ trx }) => {
    await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }]);
    assert.strictEqual(DB.holds(trx, PAGE, 'a'), true);
    assert.strictEqual(DB.holds(trx, PAGE, 'b'), false);
    await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }]);
    assert.strictEqual(uniq(statements).length, 1, 'held document: no second statement');
    await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }, { uid: PAGE, documentId: 'b' }]);
    assert.strictEqual(uniq(statements).length, 2);
    assert.strictEqual(uniq(statements)[1].where.documentId, 'b', 'only the document not yet held');
    const rows = await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }], { rows: true });
    assert.strictEqual(uniq(statements).length, 3, 'rows wanted: the locking read runs (latest committed values)');
    assert.strictEqual(uniq(statements)[2].forUpdate, true);
    assert.deepStrictEqual(rows, [{ id: 7, documentId: 'a', updatedAt: 't', uid: PAGE }]);
  });
  await strapi.db.transaction(async ({ trx }) => {
    assert.strictEqual(DB.holds(trx, PAGE, 'a'), false, 'a new transaction holds nothing');
  });
});

test('item 11: SQLite takes no row lock (the transaction serialises writers); rows are still read when asked for', async () => {
  const { strapi, statements } = fakeStrapi('better-sqlite3', () => [{ id: 1, documentId: 'a', updatedAt: 't' }]);
  assert.deepStrictEqual(await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }]), []);
  assert.strictEqual(statements.length, 0);
  const rows = await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }], { rows: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(statements[0].forUpdate, false);
});

test('item 11 (N6): the old lockRows (it took .first()) is gone; lockDocuments is the only lock', () => {
  assert.strictEqual(DB.lockRows, undefined);
});

test('item 11 (N6): bulk lockMany locks every locale of the chunk through the same helper', async () => {
  const U = require('../server/modules/_bulk/util');
  const { strapi, statements } = fakeStrapi('mysql');
  await strapi.db.transaction(() => U.lockMany(strapi, GUIDE, ['d2', 'd1'], 'fr'));
  assert.deepStrictEqual(uniq(statements).map((s) => s.where), [{ documentId: 'd1', publishedAt: null }, { documentId: 'd2', publishedAt: null }],
    'no locale filter (rc.2 locked the job locale only), documents in order');
  assert.deepStrictEqual(statements[0].orderBy, { id: 'asc' });
  assert.ok(U.DEFAULTS.bulk.chunkSize === 25 && U.DEFAULTS.bulk.chunkTimeMs > 0, 'chunks stay at 25 and are time-capped');
});

// ---------------------------------------------------------------- the Document Service lock
const run = (strapi, ctx) => DL.middleware(strapi)(ctx, async () => 'next');

test('document lock: update, delete, publish, unpublish and discardDraft lock the document before next()', async () => {
  for (const action of ['update', 'delete', 'publish', 'unpublish', 'discardDraft']) {
    const { strapi, statements } = fakeStrapi('postgres');
    let lockedBeforeNext = null;
    const out = await DL.middleware(strapi)({ action, uid: GUIDE, params: { documentId: 'g', locale: 'fr' } }, async () => {
      lockedBeforeNext = uniq(statements).length;
      return 'next';
    });
    assert.strictEqual(out, 'next');
    assert.strictEqual(lockedBeforeNext, 1, `${action}: locked before Strapi writes`);
    assert.deepStrictEqual(statements[0].where, { documentId: 'g', publishedAt: null }, `${action}: every locale, not only fr`);
    assert.strictEqual(strapi.transactions, 1, `${action}: in one transaction with the write`);
  }
});

test('document lock: other actions, no documentId, unknown types and SQLite pass straight through', async () => {
  for (const [client, ctx] of [
    ['postgres', { action: 'create', uid: PAGE, params: {} }],
    ['postgres', { action: 'findOne', uid: PAGE, params: { documentId: 'a' } }],
    ['postgres', { action: 'clone', uid: PAGE, params: { documentId: 'a' } }],
    ['postgres', { action: 'update', uid: PAGE, params: {} }],
    ['postgres', { action: 'update', uid: 'api::nope.nope', params: { documentId: 'a' } }],
    ['sqlite', { action: 'update', uid: PAGE, params: { documentId: 'a' } }],
  ]) {
    const { strapi, statements } = fakeStrapi(client);
    assert.strictEqual(await run(strapi, ctx), 'next');
    assert.strictEqual(statements.length, 0, JSON.stringify(ctx));
    assert.strictEqual(strapi.transactions, 0, `no transaction opened: ${client} ${ctx.action}`);
  }
});

test('document lock: nested in a transaction that already holds the document, it does not lock again', async () => {
  const { strapi, statements } = fakeStrapi('mysql', (st) => [{ id: 1, documentId: st.where.documentId }]);
  const before = DL.stats.alreadyHeld;
  await strapi.db.transaction(async () => {
    await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'a' }]); // writesafe's own lock (engine)
    assert.strictEqual(await run(strapi, { action: 'update', uid: PAGE, params: { documentId: 'a' } }), 'next');
    assert.strictEqual(await run(strapi, { action: 'publish', uid: PAGE, params: { documentId: 'a' } }), 'next');
  });
  assert.strictEqual(uniq(statements).length, 1);
  assert.strictEqual(DL.stats.alreadyHeld - before, 2);
  assert.strictEqual(strapi.transactions, 1, 'joined the running transaction');
});

test('document lock: a failed lock is counted and the write does not run', async () => {
  const { strapi } = fakeStrapi('postgres', () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); });
  const before = DL.stats.errors;
  let ran = false;
  await assert.rejects(DL.middleware(strapi)({ action: 'update', uid: PAGE, params: { documentId: 'a' } }, async () => { ran = true; }), /deadlock/);
  assert.strictEqual(ran, false);
  assert.strictEqual(DL.stats.errors - before, 1);
});

test('document lock: install registers once when on; off or missing documents.use registers nothing', () => {
  const used = [];
  const strapi = { documents: { use: (fn) => used.push(fn) }, log: { warn() {} } };
  assert.strictEqual(DL.install(strapi, false), false);
  assert.strictEqual(used.length, 0);
  assert.strictEqual(C.status['db.document_service_lock'].ok, true);
  assert.match(C.status['db.document_service_lock'].detail, /off/);
  assert.strictEqual(DL.install({ documents: {}, log: { warn() {} } }, true), false);
  assert.strictEqual(C.status['db.document_service_lock'].ok, false);
  assert.strictEqual(DL.install(strapi, true), true);
  assert.strictEqual(used.length, 1);
  assert.strictEqual(C.status['db.document_service_lock'].ok, true);
  assert.ok(C.VERSION_TABLE.some((r) => r.feature === 'db.document_service_lock'), 'listed in the compat table');
});

test('documentServiceLock: on by default, boolean only', () => {
  assert.strictEqual(CFG.defaults.documentServiceLock, true);
  assert.doesNotThrow(() => CFG.validator({ documentServiceLock: false }));
  assert.throws(() => CFG.validator({ documentServiceLock: 'no' }), /documentServiceLock must be a boolean/);
});

test('strapi-server: the Document Service lock is the first thing register() installs', () => {
  const src = require('node:fs').readFileSync(require.resolve('../strapi-server.js'), 'utf8');
  const reg = src.slice(src.indexOf('register({ strapi })'));
  const first = reg.indexOf("require('./server/compat/document-lock').install(strapi, cfg.documentServiceLock)");
  assert.ok(first > 0, 'installed in register()');
  for (const later of ['setVersionKey', 'compatCm.probe', 'interceptBuiltinTools', 'tools.register']) assert.ok(reg.indexOf(later) > first, `${later} comes after it`);
});

// ---------------------------------------------------------------- item 16: retry set
test('item 16 (N11): the retry set covers Postgres 55P03 and SQLITE_BUSY, and still not unrelated errors', () => {
  for (const s of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '40P01 deadlock detected', '40001 could not serialize', '55P03 canceling statement due to lock timeout',
    '55P03 could not obtain lock on row in relation "pages"', 'SQLITE_BUSY database is locked', 'SQLITE_BUSY_SNAPSHOT']) {
    assert.ok(DB.RETRYABLE.test(s), s);
  }
  for (const s of ['23505 duplicate key', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT', '42P01 relation does not exist', 'ECONNRESET']) assert.ok(!DB.RETRYABLE.test(s), s);
});

test('item 16 (N10): writes that name their documents lock them first, before the idempotency lookup', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server/engine.js'), 'utf8');
  const once = src.slice(src.indexOf('async function runOnce('));
  const lock = once.indexOf('await DB.lockDocuments(strapi, pre)');
  assert.ok(lock > 0 && lock < once.indexOf('storedOutcome('), 'the prelock is the transaction\'s first statement');
  for (const t of ['ws_patch', 'ws_publish', 'ws_batch', 'ws_delete', 'ws_localize']) assert.ok(src.includes(`'${t}'`), t);
});

test('item 16: deadlock retries hold up under a slow database: 8 attempts, exponential backoff with jitter', () => {
  const E = require('../server/engine');
  assert.strictEqual(E.MAX_ATTEMPTS, 8);
  for (let a = 1; a < 8; a += 1) {
    const base = Math.min(800, 25 * 2 ** (a - 1));
    for (let i = 0; i < 20; i += 1) { const d = E.retryDelay(a); assert.ok(d >= base * 0.5 && d <= base * 1.5, `${a}: ${d}`); }
  }
});
