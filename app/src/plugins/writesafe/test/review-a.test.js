'use strict';
// Unit tests for the second-agent review of PR #17 (stream A: versions and keys), findings 1, 3, 4, 5 and 8.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/model');
const E = require('../server/engine');
const EPOCH = require('../server/epoch');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };
const log = { warn() {}, info() {}, error() {} };

const PAGE = 'api::page.page';
const base = () => ({
  log,
  contentTypes: {
    [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, attributes: {
      title: { type: 'string' },
      items: { type: 'component', component: 'shared.item', repeatable: true },
      topic: { type: 'relation', relation: 'manyToOne', target: 'api::topic.topic' },
      author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
    } },
    'api::topic.topic': { uid: 'api::topic.topic', kind: 'collectionType', pluginOptions: { i18n: { localized: true } }, attributes: { name: { type: 'string' } } },
    'api::author.author': { uid: 'api::author.author', kind: 'collectionType', attributes: { name: { type: 'string' } } },
  },
  components: {
    'shared.item': { attributes: { label: { type: 'string' }, qty: { type: 'integer' } } },
  },
});

// ---------------------------------------------------------------- finding 1: no fresh keys for unread rows
test('review 1: row_not_found lists row identities, never keys with a MAC', () => {
  const s = base();
  const scope = M.keyScope(PAGE, 'd', null, 'items');
  const rows = [{ id: 1, label: 'a' }, { id: 2, label: 'b' }];
  assert.throws(() => E.applyRowOps(s, PAGE, 'items', s.contentTypes[PAGE].attributes.items, 'repeatable', rows,
    [{ op: 'remove', field: 'items', key: 'shared.item:99:AAAAAAAAAAAAAAAAAAAAAA' }], [], scope),
  (e) => e.payload.code === 'row_not_found' && JSON.stringify(e.payload.current_keys) === JSON.stringify(['shared.item:1', 'shared.item:2']));
});

// ---------------------------------------------------------------- finding 3: constraint errors are not a race
const fakeStrapi = (failWith) => {
  const rows = new Map();
  const q = {
    findOne: async ({ where }) => rows.get(where.key) || null,
    create: async ({ data }) => { rows.set(data.key, { ...data }); return data; },
    update: async ({ where, data }) => { Object.assign(rows.get(where.key) || {}, data); },
  };
  return {
    log, contentTypes: {}, components: {},
    db: {
      inTransaction: () => true, // keeps the epoch refresh out of the way
      query: () => q,
      // a failing transaction rolls its rows back
      transaction: async (cb) => { const snap = new Map(rows); try { return await cb(); } catch (e) { rows.clear(); for (const [k, v] of snap) rows.set(k, v); throw e; } },
    },
    _rows: rows, _failWith: failWith,
  };
};
const notNull = () => Object.assign(new Error('NOT NULL constraint failed: pages.title'), { code: 'SQLITE_CONSTRAINT_NOTNULL' });
const extra = { requestInfo: { headers: { authorization: 'Bearer t-review3' } } };

test('review 3: only a UNIQUE violation is a race; other SQLite constraint errors are not', () => {
  assert.ok(E.isUniqueViolation(Object.assign(new Error('UNIQUE constraint failed: writesafe_receipts.key'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })));
  assert.ok(E.isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint' }));
  assert.ok(E.isUniqueViolation({ code: 'ER_DUP_ENTRY', message: "Duplicate entry 'x' for key" }));
  assert.ok(!E.isUniqueViolation(notNull()), 'NOT NULL');
  assert.ok(!E.isUniqueViolation(Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })), 'FOREIGN KEY');
  assert.ok(!E.isUniqueViolation(Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT' })), 'bare SQLITE_CONSTRAINT');
});

test('review 3: a not-null failure in a versioned write is write_failed, not busy (no retry loop)', async () => {
  const saved = E.KEYS.indexed;
  E.KEYS.indexed = true;
  try {
    const s = fakeStrapi();
    const args = { uid: 'api::x.x', documentId: 'd', expected_version: `v2.${'A'.repeat(43)}`, set: { title: null } };
    await assert.rejects(() => E.runWrite(s, { user: { id: 1 } }, 'ws_patch', args, async () => { throw notNull(); }, extra),
      (e) => e.payload && e.payload.code === 'write_failed');
    const keyed = { ...args, idempotency_key: 'review-3-key-0001' };
    await assert.rejects(() => E.runWrite(s, { user: { id: 1 } }, 'ws_patch', keyed, async () => { throw notNull(); }, extra),
      (e) => e.payload && e.payload.code === 'write_failed', 'explicit idempotency_key: also write_failed, not in_progress');
  } finally {
    E.KEYS.indexed = saved;
  }
});

// ---------------------------------------------------------------- finding 4: changes the version could not see
test('review 4: a relation to a localized type is hashed with its locale (and populated with it)', () => {
  const s = base();
  const d = (loc) => ({ documentId: 'p1', locale: 'en', title: 't', items: [], topic: { id: 3, documentId: 'tp', locale: loc }, author: { id: 4, documentId: 'au' } });
  assert.notStrictEqual(M.versionOf(s, PAGE, d('en')), M.versionOf(s, PAGE, d('fr')), 'the linked locale is content');
  const p = M.populateFor(s, PAGE);
  assert.deepStrictEqual(p.topic.fields.sort(), ['documentId', 'locale']);
  assert.deepStrictEqual(p.author, { fields: ['documentId'] }, 'a type without i18n has no locale');
});

test('review 4: types the version cannot cover (morph relations, nesting deeper than the populate) are not offered', () => {
  const s = base();
  s.contentTypes['api::m.m'] = { uid: 'api::m.m', kind: 'collectionType', attributes: { title: { type: 'string' }, owner: { type: 'relation', relation: 'morphToOne' } } };
  s.contentTypes['api::n.n'] = { uid: 'api::n.n', kind: 'collectionType', attributes: { c: { type: 'component', component: 'x.c0', repeatable: false } } };
  for (let i = 0; i < 12; i += 1) s.components[`x.c${i}`] = { attributes: i < 11 ? { next: { type: 'component', component: `x.c${i + 1}`, repeatable: true } } : { v: { type: 'string' } } };
  s.contentTypes['api::z.z'] = { uid: 'api::z.z', kind: 'collectionType', attributes: { z: { type: 'dynamiczone', components: ['x.mz'] } } };
  s.components['x.mz'] = { attributes: { any: { type: 'relation', relation: 'morphToMany' } } };
  const uids = E.writableUids(s);
  assert.ok(uids.includes(PAGE));
  // re-review N6: a top-level morph relation is read and hashed (as __type, documentId), so its type stays covered
  assert.ok(uids.includes('api::m.m'), 'a top-level morph relation is covered since N6');
  assert.ok(!uids.includes('api::z.z'), 'a morph relation inside a zone component');
  assert.ok(!uids.includes('api::n.n'), 'components nested deeper than the populate depth');
  assert.strictEqual(M.unhashable(s, 'api::m.m'), null);
  assert.match(M.unhashable(s, 'api::z.z'), /polymorphic relation inside a component/);
  assert.match(M.unhashable(s, 'api::n.n'), /deeper/);
  assert.strictEqual(M.unhashable(s, PAGE), null);
});

// ---------------------------------------------------------------- finding 5: epoch recreation fails closed
test('review 5: when the epoch cannot be read or recreated, a fresh random epoch is used (old keys refused)', async () => {
  M.setRowEpoch('epoch-from-db', true);
  const broken = { log, db: { inTransaction: () => false, getSchemaConnection: () => ({ hasTable: async () => { throw new Error('connection lost'); } }) } };
  await EPOCH.refresh(broken);
  const now = M.rowEpoch();
  assert.notStrictEqual(now.epoch, 'epoch-from-db');
  assert.strictEqual(now.fromDb, false);
});

// ---------------------------------------------------------------- finding 8: liveDiff keys from the full draft
test('review 8: compare published shows the keys a write computes, also for a token with hidden sub-fields', async () => {
  const s = base();
  const draft = { documentId: 'd', locale: null, title: 't', items: [{ id: 7, label: 'new', qty: 5 }] };
  s.documents = () => ({ findOne: async () => ({ documentId: 'd', locale: null, title: 't', items: [], publishedAt: '2026-11-13T00:00:00.000Z' }) });
  const pc = {
    cannot: { read: () => false },
    sanitizeOutput: async (r) => ({ ...r, items: (r.items || []).map(({ qty, ...rest }) => rest) }), // items.qty hidden
  };
  const out = await E.liveDiff(s, pc, PAGE, 'd', undefined, draft);
  const added = out.diff.items.added;
  const want = M.rowHandle(s, 'repeatable', s.contentTypes[PAGE].attributes.items, draft.items[0], 0, M.keyScope(PAGE, 'd', null, 'items'));
  assert.strictEqual(added[0].key, want);
});
