'use strict';
// Unit tests for the second-agent review of PR #15 (stream B, locking), items 1-4 and 6. Each fails on the reviewed
// head (e42e19f). The database-level checks are in tests/test_locking.py and tests/stress/lock_soak.py (arms
// `discard` and `order`). Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };
const DB = require('../server/compat/db');
const DL = require('../server/compat/document-lock');
const E = require('../server/engine');
const optional = (m) => { try { return require(m); } catch { return null; } };
const CO = optional('../server/compat/custom-order');

const PAGE = 'api::page.page';
const GUIDE = 'api::guide.guide';
const USER = 'plugin::users-permissions.user';

/** A strapi double that records statements, raw SQL on the transactor and order locks, in one shared event log. */
function fake(client, { rowsFor = () => [], orderEnabled = new Set(), localeRowExists = true, inTx = false } = {}) {
  const log = [];
  let current = null;
  let n = 0;
  const contentTypes = {
    [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true } },
    [GUIDE]: { uid: GUIDE, kind: 'collectionType', options: { draftAndPublish: true }, pluginOptions: { i18n: { localized: true } } },
    [USER]: { uid: USER, kind: 'collectionType', options: { draftAndPublish: false } },
  };
  const customOrder = {
    isEnabled: (uid) => orderEnabled.has(uid),
    withOrderLock: async (uid, fn) => { log.push(`order:${uid}`); return fn(); },
  };
  const strapi = {
    contentTypes,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    service: (name) => (name === 'plugin::content-manager.custom-order' ? customOrder : undefined),
    plugin: (name) => (name === 'i18n' ? { service: () => ({ find: async () => [{ code: 'en' }, { code: 'fr' }], getDefaultLocale: async () => 'en' }) } : undefined),
    db: {
      config: { connection: { client } },
      metadata: { get: () => ({ tableName: 't', attributes: {} }) },
      inTransaction: () => inTx || Boolean(current),
      connection: () => {
        const q = { select: () => q, where: () => q, whereNull: () => q, first: async () => { log.push('exists?'); return localeRowExists ? { id: 1 } : undefined; } };
        return q;
      },
      queryBuilder(uid) {
        const st = { uid };
        const qb = {
          select() { return qb; }, where(w) { st.where = w; return qb; }, orderBy() { return qb; },
          forUpdate() { st.forUpdate = true; return qb; },
          async execute() { log.push(`lock:${uid}:${st.where.documentId}`); return rowsFor(st, log); },
        };
        return qb;
      },
      async transaction(cb) {
        if (current) return cb({ trx: current });
        current = { id: (n += 1), raw: async (sql) => { log.push(`raw:${sql}`); } };
        try { return await cb({ trx: current }); } finally { current = null; }
      },
    },
  };
  return { strapi, log };
}
const next = (log) => async () => { log.push('next'); return 'result'; };

// ---------------------------------------------------------------- item 1: custom order
test('review 1: an update that creates a locale of a custom-ordered type takes the order lock before the document lock', async () => {
  assert.ok(CO, 'compat/custom-order.js missing');
  const { strapi, log } = fake('postgres', { orderEnabled: new Set([GUIDE]), localeRowExists: false, rowsFor: () => [{ id: 1 }] });
  await DL.middleware(strapi)({ action: 'update', uid: GUIDE, params: { documentId: 'g', locale: 'fr' } }, next(log));
  const order = log.indexOf(`order:${GUIDE}`);
  const lock = log.indexOf(`lock:${GUIDE}:g`);
  assert.ok(order >= 0 && lock > order && log.indexOf('next') > lock, log.join(' '));
});

test('review 1: no order lock when the locale row exists, the type is not ordered, or the action is not update', async () => {
  for (const [opts, ctx] of [
    [{ orderEnabled: new Set([GUIDE]), localeRowExists: true }, { action: 'update', uid: GUIDE, params: { documentId: 'g', locale: 'fr' } }],
    [{ orderEnabled: new Set(), localeRowExists: false }, { action: 'update', uid: GUIDE, params: { documentId: 'g', locale: 'fr' } }],
    [{ orderEnabled: new Set([GUIDE]), localeRowExists: false }, { action: 'publish', uid: GUIDE, params: { documentId: 'g', locale: 'fr' } }],
  ]) {
    const { strapi, log } = fake('mysql', { ...opts, rowsFor: () => [{ id: 1 }] });
    await DL.middleware(strapi)(ctx, next(log));
    assert.ok(!log.some((x) => x.startsWith('order:')), JSON.stringify([opts, ctx, log]));
  }
});

test('review 1: ws_localize and ws_create on an ordered type take the order lock first; other tools do not', async () => {
  assert.ok(typeof E.prelockTargets === 'function', 'prelockTargets not exported');
  const { strapi } = fake('postgres', { orderEnabled: new Set([GUIDE]) });
  assert.deepStrictEqual((await E.prelockTargets(strapi, 'ws_localize', { uid: GUIDE, documentId: 'g', locale: 'fr' })).orderUids, [GUIDE]);
  assert.deepStrictEqual((await E.prelockTargets(strapi, 'ws_create', { uid: GUIDE, data: {} })).orderUids, [GUIDE]);
  assert.strictEqual((await E.prelockTargets(strapi, 'ws_patch', { uid: GUIDE, documentId: 'g' })).orderUids, undefined);
  assert.strictEqual((await E.prelockTargets(strapi, 'ws_create', { uid: PAGE, data: {} })).orderUids, undefined);
  const src = require('node:fs').readFileSync(require.resolve('../server/engine.js'), 'utf8');
  const once = src.slice(src.indexOf('async function runOnce('));
  assert.ok(once.indexOf('CO.lockOrder') < once.indexOf('DB.lockDocuments(strapi, pre)'), 'order lock before the document prelock');
});

// ---------------------------------------------------------------- item 2: rows recreated while waiting
test('review 2: the lock statement runs again until two runs return the same ids; rows recreated while waiting are locked', async () => {
  let runs = 0;
  const { strapi, log } = fake('postgres', { rowsFor: () => { runs += 1; return runs === 1 ? [] : [{ id: 9, documentId: 'g' }]; } });
  let rows;
  await strapi.db.transaction(async ({ trx }) => {
    rows = await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'g' }], { rows: true });
    assert.strictEqual(DB.holds(trx, PAGE, 'g'), true);
  });
  assert.deepStrictEqual(rows.map((r) => r.id), [9], log.join(' '));
  assert.strictEqual(rows.changed, true, 'the caller learns the rows changed while it waited');
  assert.ok(runs >= 3);
});

test('review 2 / 6: a lock that found no row is never recorded as held', async () => {
  const { strapi } = fake('mysql', { rowsFor: () => [] });
  await strapi.db.transaction(async ({ trx }) => {
    await DB.lockDocuments(strapi, [{ uid: PAGE, documentId: 'gone' }]);
    assert.strictEqual(DB.holds(trx, PAGE, 'gone'), false);
  });
});

test('review 2: no rows after they changed under the wait is a retry (busy, own signal), not not_found', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server/engine.js'), 'utf8');
  const lr = src.slice(src.indexOf('async function lockAndRead('), src.indexOf('async function lockAndRead(') + 1500);
  assert.ok(/!locked && rows\.changed\) staleRetry\(/.test(lr), 'lockAndRead retries when the rows changed and none is left');
  const d = E.retryDecision({ e: Object.assign(new E.WsError({ code: 'busy' }), { retryAttempt: true }), watch: { retryable: { code: 'ROWS_CHANGED', own: true } }, attempt: 1, lockWaits: 0, elapsedMs: 0 });
  assert.strictEqual(d.retry, true);
});

// ---------------------------------------------------------------- item 3: what runs after the middleware
test('review 3a: the middleware leaves plugin and admin types alone (writesafe types only)', async () => {
  const { strapi, log } = fake('postgres', { rowsFor: () => [{ id: 1 }] });
  await DL.middleware(strapi)({ action: 'update', uid: USER, params: { documentId: 'u' } }, next(log));
  assert.deepStrictEqual(log, ['next']);
});

test('review 3b: Postgres, when the middleware opened the transaction: SELECT 1 after the write; not when nested, not on MySQL', async () => {
  const a = fake('postgres', { rowsFor: () => [{ id: 1 }] });
  await DL.middleware(a.strapi)({ action: 'update', uid: PAGE, params: { documentId: 'p' } }, next(a.log));
  assert.ok(a.log.indexOf('raw:select 1') > a.log.indexOf('next'), a.log.join(' '));
  const b = fake('postgres', { rowsFor: () => [{ id: 1 }], inTx: true });
  await DL.middleware(b.strapi)({ action: 'update', uid: PAGE, params: { documentId: 'p' } }, next(b.log));
  assert.ok(!b.log.includes('raw:select 1'), b.log.join(' '));
  const c = fake('mysql', { rowsFor: () => [{ id: 1 }] });
  await DL.middleware(c.strapi)({ action: 'update', uid: PAGE, params: { documentId: 'p' } }, next(c.log));
  assert.ok(!c.log.includes('raw:select 1'), c.log.join(' '));
});

// ---------------------------------------------------------------- item 4: retry bounds
test('review 4: retry only when the FINAL error is retryable; lock waits at most twice; a 25 s budget per call', () => {
  assert.ok(typeof E.retryDecision === 'function', 'retryDecision missing');
  const dl = Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
  const lw = Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
  const pgTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const base = { attempt: 1, lockWaits: 0, elapsedMs: 0, watch: {} };
  assert.strictEqual(E.retryDecision({ ...base, e: dl }).retry, true);
  assert.strictEqual(E.retryDecision({ ...base, e: Object.assign(new E.WsError({ code: 'write_failed' }), { cause: dl }) }).retry, true, 'through the cause chain');
  assert.strictEqual(E.retryDecision({ ...base, e: lw }).kind, 'lock_wait');
  assert.strictEqual(E.retryDecision({ ...base, e: lw, lockWaits: 1 }).retry, true);
  assert.strictEqual(E.retryDecision({ ...base, e: lw, lockWaits: 2 }).retry, false, 'a third lock wait timeout ends the call');
  assert.strictEqual(E.retryDecision({ ...base, e: pgTimeout, lockWaits: 2 }).retry, false);
  assert.strictEqual(E.retryDecision({ ...base, e: dl, elapsedMs: E.RETRY_BUDGET_MS - 1 }).retry, false, 'the next pause must fit in the budget');
  assert.strictEqual(E.RETRY_BUDGET_MS, 25000);
  // a deadlock some query saw and someone handled, then a validation failure: not a retry
  const v = new E.WsError({ code: 'invalid', message: 'bad' });
  assert.strictEqual(E.retryDecision({ ...base, e: v, watch: { retryable: { code: 'ER_LOCK_DEADLOCK' }, errors: [{ code: 'ER_LOCK_DEADLOCK', message: 'Deadlock' }] } }).retry, false);
  // MySQL: Strapi's failed restore hides the deadlock behind an SQL error: a database error after a deadlock is retried
  const masked = Object.assign(new Error('You have an error in your SQL syntax'), { code: 'ER_PARSE_ERROR', errno: 1064, sqlMessage: 'syntax' });
  assert.strictEqual(E.retryDecision({ ...base, e: masked, watch: { errors: [{ code: 'ER_LOCK_DEADLOCK', message: 'Deadlock found' }] } }).retry, true);
  assert.strictEqual(E.retryDecision({ ...base, e: masked, watch: {} }).retry, false, 'the same SQL error without a deadlock is not retried');
  assert.strictEqual(E.retryDecision({ ...base, e: dl, attempt: E.MAX_ATTEMPTS }).retry, false);
});
