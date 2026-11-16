'use strict';
// Unit tests for 1.0 hardening Phase 2, stream A: the semantic version (item 15), content-bound row keys and
// stale_row_key (16b), the precondition rule for set/unset (16c) and implicit idempotency (16d).
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/model');
const R = require('../server/reply');
const E = require('../server/engine');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };

const PAGE = 'api::page.page';
const strapi = {
  contentTypes: {
    [PAGE]: { attributes: {
      title: { type: 'string' }, body: { type: 'blocks' }, data: { type: 'json' },
      seo: { type: 'component', component: 'shared.seo', repeatable: false },
      items: { type: 'component', component: 'shared.item', repeatable: true },
      groups: { type: 'component', component: 'shared.group', repeatable: true },
      sections: { type: 'dynamiczone', components: ['blocks.text', 'blocks.hero', 'blocks.note'] },
      author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
      tags: { type: 'relation', relation: 'manyToMany', target: 'api::tag.tag' },
      cover: { type: 'media', multiple: false },
    } },
  },
  components: {
    'shared.seo': { attributes: { metaTitle: { type: 'string' } } },
    'shared.meta': { attributes: { note: { type: 'string' } } },
    'shared.item': { attributes: { label: { type: 'string' }, qty: { type: 'integer' }, meta: { type: 'component', component: 'shared.meta', repeatable: false } } },
    'shared.group': { attributes: { name: { type: 'string' }, entries: { type: 'component', component: 'shared.meta', repeatable: true } } },
    'blocks.text': { attributes: { body: { type: 'text' } } },
    'blocks.note': { attributes: { body: { type: 'text' } } }, // same fields as blocks.text: only the type differs
    'blocks.hero': { attributes: { heading: { type: 'string' }, link: { type: 'relation', relation: 'manyToOne', target: 'api::page.page' } } },
  },
};
const A = strapi.contentTypes[PAGE].attributes;

/** A draft as the Document Service returns it (ids at every depth, relations and media as objects). */
const draft = (o = {}) => ({
  id: 10, documentId: 'doc1', locale: 'en', updatedAt: '2026-11-13T10:00:00.000Z', title: 'T',
  seo: { id: 1, metaTitle: 'm' },
  items: [{ id: 21, label: 'a', qty: 1, meta: { id: 31, note: 'n1' } }, { id: 22, label: 'b', qty: 2, meta: null }],
  groups: [{ id: 41, name: 'g', entries: [{ id: 51, note: 'e1' }, { id: 52, note: 'e2' }] }],
  sections: [{ id: 61, __component: 'blocks.text', body: 'x' }, { id: 62, __component: 'blocks.hero', heading: 'h', link: { id: 3, documentId: 'p3' } }],
  body: [{ type: 'image', image: { id: 7, url: '/a.png' }, children: [{ type: 'text', text: '' }] }],
  author: { id: 5, documentId: 'au1' }, tags: [{ id: 8, documentId: 't8' }, { id: 9, documentId: 't9' }], cover: { id: 4, documentId: 'f4' },
  ...o,
});
const v = (d, uid = PAGE) => M.versionOf(strapi, uid, M.normalize(strapi, uid, d));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- item 15: semantic version
test('item 15 (D1): the token is "v3." and a full-length HMAC (43 base64url characters)', () => {
  assert.match(v(draft()), /^v3\.[A-Za-z0-9_-]{43}$/);
  assert.ok(M.isVersionToken(v(draft())));
  assert.ok(!M.isVersionToken('2026-11-13T10:00:00.000Z~0123456789ab'), 'the rc.2 form is not a v2 token');
  assert.ok(M.isLegacyVersionToken('2026-11-13T10:00:00.000Z~0123456789ab'));
});

test('item 15: component row ids are dropped at every depth; updatedAt is not part of the version', () => {
  const d = draft();
  const e = clone(d);
  e.updatedAt = '2027-01-01T00:00:00.000Z';
  e.seo.id = 901; e.items[0].id = 902; e.items[0].meta.id = 903; e.items[1].id = 904;
  e.groups[0].id = 905; e.groups[0].entries[0].id = 906; e.groups[0].entries[1].id = 907;
  e.sections[0].id = 908; e.sections[1].id = 909;
  assert.strictEqual(v(e), v(d), 'recreated rows (new ids only) keep the version');
  assert.ok(M.versionMatches(strapi, PAGE, v(d), M.normalize(strapi, PAGE, e)));
});

test('item 15: a real change of a value, type, order, nesting, relation or media changes the version', () => {
  const d = draft();
  const base = v(d);
  const changed = (fn, what) => { const e = clone(d); fn(e); assert.notStrictEqual(v(e), base, what); };
  changed((e) => { e.title = 'U'; }, 'scalar');
  changed((e) => { e.items[0].meta.note = 'n2'; }, 'nested single component value');
  changed((e) => { e.groups[0].entries[1].note = 'E2'; }, 'nested repeatable value');
  changed((e) => { e.items.reverse(); }, 'order of rows');
  changed((e) => { e.groups[0].entries.reverse(); }, 'order of nested rows');
  changed((e) => { e.sections[0].__component = 'blocks.note'; }, 'type of a dynamic-zone row (same fields)');
  changed((e) => { e.items[1].meta = { id: 99, note: 'b' }; e.items[1].label = undefined; }, 'nesting');
  changed((e) => { e.groups[0].entries.push({ id: 53, note: 'e3' }); }, 'a nested row added');
  changed((e) => { e.groups[0].entries = [e.groups[0].entries[0]]; e.groups.push({ id: 42, name: 'g', entries: [{ id: 52, note: 'e2' }] }); }, 'a nested row moved to another parent');
  changed((e) => { e.author = { id: 6, documentId: 'au2' }; }, 'to-one relation');
  changed((e) => { e.tags.reverse(); }, 'order of a to-many relation');
  changed((e) => { e.sections[1].link = { id: 4, documentId: 'p4' }; }, 'relation inside a zone row');
  changed((e) => { e.cover = { id: 5, documentId: 'f5' }; }, 'media');
  changed((e) => { e.body[0].image.id = 8; }, 'a blocks image reference (its `id` is a file, not a row id)');
});

test('item 15: the version is bound to the uid, the documentId and the locale', () => {
  const d = draft();
  const en = v(d);
  assert.notStrictEqual(v({ ...d, locale: 'fr' }), en, 'same content, other locale');
  assert.notStrictEqual(v({ ...d, documentId: 'doc2' }), en, 'same content, other document');
  strapi.contentTypes['api::other.other'] = strapi.contentTypes[PAGE];
  assert.notStrictEqual(v(d, 'api::other.other'), en, 'same content, other type');
  assert.ok(!M.versionMatches(strapi, PAGE, en, M.normalize(strapi, PAGE, { ...d, locale: 'fr' })), 'an en token is refused for fr');
});

test('item 15: rc.2 / Phase 1 tokens are refused with version_format (requires_reread); others stay invalid', () => {
  assert.throws(() => E.assertVersion('2026-11-13T10:00:00.000Z~0123456789ab'),
    (e) => e.payload.code === 'version_format' && e.payload.requires_reread === true && /ws_get/.test(e.payload.message));
  assert.throws(() => E.assertVersion('2026-11-13T10:00:00.000Z'), (e) => e.payload.code === 'invalid');
  assert.throws(() => E.assertVersion('v2.short'), (e) => e.payload.code === 'invalid');
  assert.doesNotThrow(() => E.assertVersion(v(draft())));
  assert.deepStrictEqual([R.TYPES.version_format, R.TYPES.stale_row_key], [[false, true], [false, true]]);
});

// ---------------------------------------------------------------- item 16b: content-bound row keys
const scope = M.keyScope(PAGE, 'doc1', 'en', 'items');
const key = (row, sc = scope, kind = 'repeatable', attr = A.items) => M.rowHandle(strapi, kind, attr, row, 0, sc);

test('item 16b: a component key is "<component>:<id>:<mac>" (128-bit MAC)', () => {
  assert.match(key({ id: 21, label: 'a' }), /^shared\.item:21:[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(M.keyIdentity(key({ id: 21, label: 'a' })), 'shared.item:21');
  assert.strictEqual(M.keyIdentity('shared.item:21'), 'shared.item:21', 'an rc.2 key has the same identity');
  assert.match(M.rowHandle(strapi, 'blocks', A.body, { type: 'paragraph', children: [] }, 0, scope), /^#0:[0-9a-f]{8}$/, 'blocks keys unchanged');
});

test('item 16b: the key binds the row content (nested rows included), not nested row ids', () => {
  const r = { id: 21, label: 'a', qty: 1, meta: { id: 31, note: 'n' } };
  const k = key(r);
  assert.strictEqual(key(clone(r)), k, 'stable');
  assert.notStrictEqual(key({ ...r, qty: 2 }), k, 'a field change');
  assert.notStrictEqual(key({ ...r, meta: { id: 31, note: 'N' } }), k, 'a nested single component change');
  assert.strictEqual(key({ ...r, meta: { id: 77, note: 'n' } }), k, 'a recreated nested row (new id only)');
  const g = { id: 41, name: 'g', entries: [{ id: 51, note: 'e1' }, { id: 52, note: 'e2' }] };
  const gs = M.keyScope(PAGE, 'doc1', 'en', 'groups');
  const kg = key(g, gs, 'repeatable', A.groups);
  assert.notStrictEqual(key({ ...g, entries: [g.entries[1], g.entries[0]] }, gs, 'repeatable', A.groups), kg, 'nested repeatable order');
  assert.notStrictEqual(key({ ...g, entries: [g.entries[0], { id: 52, note: 'E2' }] }, gs, 'repeatable', A.groups), kg, 'nested repeatable value');
  assert.strictEqual(key({ ...g, entries: [{ id: 81, note: 'e1' }, { id: 82, note: 'e2' }] }, gs, 'repeatable', A.groups), kg, 'nested ids are not content');
});

test('item 16b: identical rows have different keys; the key binds scope, component, id and epoch', () => {
  const a = key({ id: 21, label: 'same', qty: 1 });
  const b = key({ id: 22, label: 'same', qty: 1 });
  assert.notStrictEqual(a, b, 'two identical rows');
  assert.notStrictEqual(key({ id: 21, label: 'same', qty: 1 }, M.keyScope(PAGE, 'doc1', 'fr', 'items')), a, 'locale');
  assert.notStrictEqual(key({ id: 21, label: 'same', qty: 1 }, M.keyScope(PAGE, 'doc2', 'en', 'items')), a, 'document');
  assert.notStrictEqual(key({ id: 21, label: 'same', qty: 1 }, M.keyScope(PAGE, 'doc1', 'en', 'other')), a, 'field');
  const z1 = M.rowHandle(strapi, 'dynamiczone', A.sections, { id: 61, __component: 'blocks.text', body: 'x' }, 0, scope);
  const z2 = M.rowHandle(strapi, 'dynamiczone', A.sections, { id: 61, __component: 'blocks.note', body: 'x' }, 0, scope);
  assert.notStrictEqual(M.keyIdentity(z1), M.keyIdentity(z2), 'component type');
  const before = M.rowEpoch().epoch;
  M.setRowEpoch('epoch-of-another-database', true);
  try {
    assert.notStrictEqual(key({ id: 21, label: 'same', qty: 1 }), a, 'another database epoch: every old key is refused');
  } finally {
    M.setRowEpoch(before, true);
  }
  assert.strictEqual(key({ id: 21, label: 'same', qty: 1 }), a);
});

test('item 16b: row ops refuse a stale key with stale_row_key, an absent row with row_not_found', () => {
  const rows = [{ id: 21, label: 'a', qty: 1 }, { id: 22, label: 'a', qty: 1 }];
  const keys = M.rowHandles(strapi, 'repeatable', A.items, rows, scope);
  const run = (cur, ops) => E.applyRowOps(strapi, PAGE, 'items', A.items, 'repeatable', cur, ops, [], scope);
  // two agents read the same list; agent 1 edits row 21; agent 2 still holds the old key of row 21
  const edited = [{ ...rows[0], qty: 5 }, rows[1]];
  const r = run(edited, [{ op: 'update', field: 'items', key: keys[1], data: { qty: 9 } }]);
  assert.deepStrictEqual(r.list.map((x) => x.qty), [5, 9], 'another row: still applies');
  assert.throws(() => run(edited, [{ op: 'update', field: 'items', key: keys[0], data: { label: 'z' } }]),
    (e) => e.payload.code === 'stale_row_key' && e.payload.requires_reread === true && !('current_key' in e.payload));
  assert.throws(() => run(edited, [{ op: 'move', field: 'items', key: keys[1], position: { after: keys[0] } }]), (e) => e.payload.code === 'stale_row_key', 'a stale anchor');
  assert.throws(() => run(rows, [{ op: 'remove', field: 'items', key: 'shared.item:21' }]), (e) => e.payload.code === 'stale_row_key', 'an rc.2 key without a MAC');
  assert.throws(() => run([rows[1]], [{ op: 'update', field: 'items', key: keys[0], data: { qty: 3 } }]), (e) => e.payload.code === 'row_not_found');
  // a reused id (sequence reset, fresh-database import): same id, other content -> stale, never the other row
  assert.throws(() => run([{ id: 21, label: 'someone else', qty: 7 }], [{ op: 'update', field: 'items', key: keys[0], data: { qty: 3 } }]),
    (e) => e.payload.code === 'stale_row_key');
  // ops of one call name rows by the keys that were read, also after an earlier op of the same call changed the row
  const two = run(rows, [{ op: 'update', field: 'items', key: keys[0], data: { qty: 4 } }, { op: 'move', field: 'items', key: keys[0], position: 'end' }]);
  assert.deepStrictEqual(two.list.map((x) => [x.id, x.qty]), [[22, 1], [21, 4]]);
});

test('item 16b: presentDoc keys come from the full row, so a restricted view gets the keys a write computes', () => {
  const full = draft();
  const visible = clone(full);
  delete visible.items[0].qty; // a sub-field the token cannot read
  const shown = M.presentDoc(strapi, PAGE, visible, undefined, { full });
  const fromFull = M.presentDoc(strapi, PAGE, full).rows.items;
  assert.deepStrictEqual(shown.rows.items, fromFull);
  assert.deepStrictEqual(shown.data.items.map((r) => r._key), fromFull);
  assert.ok(!('qty' in shown.data.items[0]), 'the hidden field stays hidden');
  const work = M.rowHandles(strapi, 'repeatable', A.items, M.normalize(strapi, PAGE, full).items, M.keyScope(PAGE, 'doc1', 'en', 'items'));
  assert.deepStrictEqual(fromFull, work, 'the keys ws_get shows are the keys a row op is matched against');
});

// ---------------------------------------------------------------- item 16c: set and unset need a version
test('item 16c: the precondition names every field and does not hand out a version or advise force', () => {
  const e = E.preconditionFields(['title', 'items'], A);
  assert.strictEqual(e.payload.code, 'precondition_required');
  assert.deepStrictEqual(e.payload.fields, ['title', 'items']);
  assert.match(e.payload.message, /expected_version/);
  assert.match(e.payload.message, /ops/);
  assert.ok(!/force/.test(e.payload.message) && !('current_version' in e.payload));
});

// ---------------------------------------------------------------- item 16d: implicit idempotency
test('item 16d: every version a request carries is found (patch, delete map, localize source, batch items)', () => {
  assert.deepStrictEqual(E.versionsIn('ws_patch', { expected_version: 'v2.a' }), ['v2.a']);
  assert.deepStrictEqual(E.versionsIn('ws_delete', { expected_version: { en: 'v2.a', fr: 'v2.b' } }), ['v2.a', 'v2.b']);
  assert.deepStrictEqual(E.versionsIn('ws_localize', { expected_source_version: 'v2.s', expected_version: 'v2.t' }), ['v2.t', 'v2.s']);
  assert.deepStrictEqual(E.versionsIn('ws_batch', { items: [{ expected_version: 'v2.a' }, { set: {} }] }), ['v2.a']);
  assert.deepStrictEqual(E.versionsIn('ws_patch', { ops: [] }), []);
});

test('item 16d: the implicit record is bound to the token, the target and the whole request (versions included)', async () => {
  const saved = E.KEYS.indexed;
  E.KEYS.indexed = true;
  try {
    const ctx = { user: { id: 1 } };
    const extra = (tok) => ({ requestInfo: { headers: { authorization: `Bearer ${tok}` } } });
    const args = { uid: PAGE, documentId: 'doc1', expected_version: 'v2.a', set: { title: 'x' } };
    const k = await E.implicitKey(strapi, ctx, extra('t1'), 'ws_patch', args, args);
    assert.match(k, /^v:[0-9a-f]{64}$/);
    assert.strictEqual(await E.implicitKey(strapi, ctx, extra('t1'), 'ws_patch', args, { ...args }), k, 'same request: same record');
    assert.notStrictEqual(await E.implicitKey(strapi, ctx, extra('t1'), 'ws_patch', args, { ...args, set: { title: 'y' } }), k, 'other change, same version');
    assert.notStrictEqual(await E.implicitKey(strapi, ctx, extra('t1'), 'ws_patch', args, { ...args, expected_version: 'v2.b' }), k, 'other version');
    assert.notStrictEqual(await E.implicitKey(strapi, ctx, extra('t2'), 'ws_patch', args, args), k, 'other token');
    assert.strictEqual(await E.implicitKey(strapi, ctx, extra('t1'), 'ws_patch', { ...args, idempotency_key: 'k-12345678' }, args), null, 'an explicit key wins');
    assert.strictEqual(await E.implicitKey(strapi, ctx, extra('t1'), 'ws_patch', { ...args, dry_run: true }, args), null, 'dry runs store nothing');
    assert.strictEqual(await E.implicitKey(strapi, ctx, {}, 'ws_patch', args, args), null, 'no per-token identity: no record');
  } finally {
    E.KEYS.indexed = saved;
  }
});
