'use strict';
// Unit tests for 1.0 hardening stream F (Phase 3 items 20 and 21): ref-level add/remove ops, nested-list preconditions,
// per-document before-image caps, the job byte budget and the undo job's reverse walk. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };

const RO = require('../server/refops');
const C = require('../server/modules/history/capture');
const UJ = require('../server/modules/history/undo-job');

// A minimal schema: a gallery with a single component and a repeatable component, each holding a to-many relation,
// a multiple media field and a nested repeatable component.
const S = {
  contentTypes: {
    'api::gallery.gallery': {
      uid: 'api::gallery.gallery', kind: 'collectionType', attributes: {
        title: { type: 'string' },
        contributors: { type: 'relation', relation: 'manyToMany', target: 'api::author.author' },
        lead: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
        images: { type: 'media', multiple: true },
        cover: { type: 'media', multiple: false },
        feature: { type: 'component', repeatable: false, component: 'gallery.feature' },
        slides: { type: 'component', repeatable: true, component: 'gallery.slide' },
      },
    },
  },
  components: {
    'gallery.feature': { attributes: { title: { type: 'string' }, images: { type: 'media', multiple: true }, people: { type: 'relation', relation: 'manyToMany', target: 'api::author.author' }, steps: { type: 'component', repeatable: true, component: 'shared.meta' }, inner: { type: 'component', repeatable: false, component: 'gallery.inner' } } },
    'gallery.inner': { attributes: { tags: { type: 'relation', relation: 'manyToMany', target: 'api::author.author' }, label: { type: 'string' } } },
    'gallery.slide': { attributes: { caption: { type: 'string' }, images: { type: 'media', multiple: true }, people: { type: 'relation', relation: 'manyToMany', target: 'api::author.author' }, notes: { type: 'component', repeatable: true, component: 'shared.meta' } } },
    'shared.meta': { attributes: { note: { type: 'string' } } },
  },
};
const GAL = 'api::gallery.gallery';

// ---------------------------------------------------------------- item 20: ref ops on one list
test('item 20: a re-tag by ref ops keeps every other link and reports no-ops', () => {
  const r = RO.applyRefList(['news', 'o1', 'o2', 'late'], [{ op: 'remove', ref: 'news' }, { op: 'add', ref: 'updates' }]);
  assert.deepStrictEqual(r.list, ['o1', 'o2', 'late', 'updates']);
  assert.deepStrictEqual(r.statuses, ['removed', 'added']);
  assert.strictEqual(r.changed, true);
  const n = RO.applyRefList(['o1'], [{ op: 'add', ref: 'o1' }, { op: 'remove', ref: 'news' }]);
  assert.deepStrictEqual(n.list, ['o1']);
  assert.deepStrictEqual(n.statuses, ['already_linked', 'not_linked']);
  assert.strictEqual(n.changed, false, 'a list of no-ops changes nothing (no write)');
  const t = RO.applyRefList([], [{ op: 'add', ref: 'a' }, { op: 'add', ref: 'a' }, { op: 'remove', ref: 'a' }]);
  assert.deepStrictEqual(t.statuses, ['added', 'already_linked', 'removed']);
  assert.strictEqual(t.changed, false, 'add then remove of the same ref nets out');
});

test('item 20: ref positions and ref identity (a file documentId and its numeric id are one file)', () => {
  assert.deepStrictEqual(RO.applyRefList(['a', 'b'], [{ op: 'add', ref: 'c', position: 'start' }]).list, ['c', 'a', 'b']);
  assert.deepStrictEqual(RO.applyRefList(['a', 'b'], [{ op: 'add', ref: 'c', position: { after: 'a' } }]).list, ['a', 'c', 'b']);
  assert.deepStrictEqual(RO.applyRefList(['a', 'b'], [{ op: 'add', ref: 'c', position: { before: 'a' } }]).list, ['c', 'a', 'b']);
  assert.deepStrictEqual(RO.applyRefList(['a', 'b'], [{ op: 'add', ref: 'c', position: { index: 1 } }]).list, ['a', 'c', 'b']);
  assert.throws(() => RO.applyRefList(['a'], [{ op: 'add', ref: 'c', position: { after: 'zz' } }]), (e) => e.payload && e.payload.code === 'invalid');
  // media: refs resolve to file ids; the list holds ids
  const ids = { f1: 1, f2: 2, f3: 3 };
  const r = RO.applyRefList([1, 2], [{ op: 'add', ref: 'f2' }, { op: 'remove', ref: 1 }, { op: 'add', ref: 'f3', position: { before: 'f2' } }], (x) => (typeof x === 'number' ? x : ids[x]));
  assert.deepStrictEqual(r.list, [3, 2]);
  assert.deepStrictEqual(r.statuses, ['already_linked', 'removed', 'added']);
  assert.deepStrictEqual(RO.applyRefList(['a', 'b'], [{ op: 'add', ref: 'b', position: 'start' }]).list, ['a', 'b'], 'position on a linked ref is no move');
});

test('item 20: ref op shapes are recognised and validated against the field', () => {
  assert.ok(RO.isRefOp({ op: 'add', field: 'contributors', ref: 'x' }));
  assert.ok(RO.isRefOp({ op: 'remove', field: 'images', ref: 3 }));
  assert.ok(!RO.isRefOp({ op: 'add', field: 'items', data: {} }));
  assert.ok(!RO.isRefOp({ op: 'remove', field: 'items', key: 'k' }));
  const target = (field, op) => RO.refTarget(S, GAL, { op: 'add', field, ref: 'x', ...op });
  assert.deepStrictEqual(target('contributors'), { kind: 'relation', attr: S.contentTypes[GAL].attributes.contributors, field: 'contributors', path: [], container: null });
  assert.strictEqual(target('images').kind, 'media');
  assert.deepStrictEqual(target('feature', { path: 'people' }).path, ['people']);
  assert.strictEqual(target('feature', { path: 'inner.tags' }).attr.target, 'api::author.author');
  assert.strictEqual(target('slides', { key: 'gallery.slide:1', path: 'images' }).container, 'repeatable');
  const bad = (field, op, re) => assert.throws(() => target(field, op), (e) => e.payload && e.payload.code === 'invalid' && (!re || re.test(e.payload.message)), `${field} ${JSON.stringify(op)}`);
  bad('title', {}, /relation or a multiple media/);
  bad('lead', {}, /set/);
  bad('cover', {}, /set/);
  bad('slides', { path: 'people' }, /key/);
  bad('feature', { path: 'steps' }, /relation or a multiple media/);
  bad('feature', { path: 'nosuch' });
  bad('contributors', { path: 'x' });
  bad('contributors', { key: 'k' });
  bad('contributors', { data: {} });
});

// ---------------------------------------------------------------- item 20: nested lists need a precondition
test('item 20: nested list changes inside a component row are found; echoes and scalars are not', () => {
  const cur = { id: 7, caption: 'c', images: [1, 2], people: ['a1'], notes: [{ id: 30, note: 'n' }] };
  const f = (data) => RO.nestedListChanges(S, 'gallery.slide', data, cur, 'slides');
  assert.deepStrictEqual(f({ caption: 'new' }), []);
  assert.deepStrictEqual(f({ caption: 'x', images: [1, 2], people: ['a1'], notes: [{ note: 'n' }] }), [], 'an unchanged echo (nested ids dropped) is not a change');
  assert.deepStrictEqual(f({ people: ['a2'] }), ['slides.people']);
  assert.deepStrictEqual(f({ images: [2, 1] }), ['slides.images'], 'order is part of the list');
  assert.deepStrictEqual(f({ notes: [{ note: 'x' }] }), ['slides.notes']);
  assert.deepStrictEqual(f({ notes: [] }), ['slides.notes']);
  const fc = { id: 3, title: 't', inner: { id: 4, tags: ['a'], label: 'l' } };
  assert.deepStrictEqual(RO.nestedListChanges(S, 'gallery.feature', { inner: { label: 'm' } }, fc, 'feature'), []);
  assert.deepStrictEqual(RO.nestedListChanges(S, 'gallery.feature', { inner: { tags: ['b'] } }, fc, 'feature'), ['feature.inner.tags'], 'nested single components are followed');
  assert.deepStrictEqual(RO.nestedListChanges(S, 'gallery.feature', { images: [5] }, null, 'feature'), [], 'a new component has no list to lose');
});

test('item 20: a ref op inside a row (path) edits only that nested list', () => {
  const row = { id: 7, caption: 'c', images: [1], people: ['a1'], notes: [{ id: 30, note: 'n' }] };
  const out = RO.applyRefInRow(S, 'gallery.slide', row, ['people'], [{ op: 'add', ref: 'a2' }, { op: 'remove', ref: 'a1' }]);
  assert.deepStrictEqual(out.row, { id: 7, caption: 'c', images: [1], people: ['a2'], notes: [{ id: 30, note: 'n' }] });
  assert.deepStrictEqual(out.statuses, ['added', 'removed']);
  const f = { id: 3, title: 't', inner: { id: 4, tags: ['a'], label: 'l' } };
  const o2 = RO.applyRefInRow(S, 'gallery.feature', f, ['inner', 'tags'], [{ op: 'add', ref: 'b' }]);
  assert.deepStrictEqual(o2.row.inner, { id: 4, tags: ['a', 'b'], label: 'l' }, 'the nested component keeps its id');
  assert.deepStrictEqual(f.inner.tags, ['a'], 'the input row is not mutated');
  const o3 = RO.applyRefInRow(S, 'gallery.feature', null, ['people'], [{ op: 'add', ref: 'b' }]);
  assert.deepStrictEqual(o3.row, { people: ['b'] }, 'an empty single component is created');
});

// ---------------------------------------------------------------- item 21: before-image caps
const entry = (i, size) => ({ i, tool: 'ws_bulk', uid: 'api::page.page', documentId: `d${i}`, locale: null, op: 'update', f: { summary: { b: 'x'.repeat(size), a: 'h' } }, r: {} });

test('item 21: the before-image cap is per document, not per receipt', () => {
  const es = [entry(0, 10), entry(1, 5000), entry(2, 10)];
  const out = C.capEntries(es, { perDocument: 1000, budgetLeft: Infinity });
  assert.strictEqual(out.stripped, 1);
  assert.strictEqual(es[1].t, 1);
  assert.strictEqual(es[1].tr, 'document');
  assert.ok(!('b' in es[1].f.summary), 'only the oversized entry loses its before value');
  assert.strictEqual(es[0].f.summary.b, 'x'.repeat(10));
  assert.strictEqual(es[2].f.summary.b, 'x'.repeat(10));
  assert.ok(!es[0].t && !es[2].t);
  assert.ok(out.bytes > 20 && out.bytes < 1000);
});

test('item 21: the job budget keeps before-images until it is used, then strips the rest', () => {
  const es = [entry(0, 300), entry(1, 300), entry(2, 300), entry(3, 10)];
  const out = C.capEntries(es, { perDocument: 100000, budgetLeft: 900 });
  assert.deepStrictEqual(es.map((e) => e.t || 0), [0, 0, 1, 1], 'after the budget every later entry is stripped, small or not (in order)');
  assert.deepStrictEqual(es.map((e) => e.tr || null), [null, null, 'job', 'job']);
  assert.strictEqual(out.stripped, 2);
  assert.ok(out.bytes <= 900);
  // deletes keep the whole draft: capped the same way
  const del = { i: 0, uid: 'api::page.page', documentId: 'd', op: 'delete', doc: { body: 'y'.repeat(5000) } };
  C.capEntries([del], { perDocument: 1000, budgetLeft: Infinity });
  assert.ok(del.t === 1 && !('doc' in del));
  // publish and create entries carry no before value and are never stripped
  const pub = { i: 0, op: 'publish', uid: 'u', documentId: 'd', vb: 'v' };
  C.capEntries([pub], { perDocument: 1, budgetLeft: 0 });
  assert.ok(!pub.t);
});

// ---------------------------------------------------------------- item 21: the undo job's reverse walk
const rows = () => [
  { id: 10, receiptId: 'J~a', history: { e: [{ i: 0 }, { i: 1 }, { i: 2 }] } },
  { id: 12, receiptId: 'J~b', history: { e: [{ i: 0 }, { i: 1 }] } },
  { id: 15, receiptId: 'J~c', history: { e: [{ i: 0 }, { i: 1 }, { i: 2 }], undone_items: { 1: 'r_x' } } },
];
const desc = () => rows().sort((x, y) => y.id - x.id);

test('item 21: an undo job walks a job newest chunk first, newest entry first, and resumes from its cursor', () => {
  const seen = [];
  let cursor = null;
  for (let n = 0; n < 10; n += 1) {
    const r = UJ.nextEntries(desc(), cursor, 3);
    seen.push(...r.entries.map((e) => `${e.rid}:${e.i}`));
    cursor = r.cursor;
    if (r.exhausted) break;
  }
  assert.deepStrictEqual(seen, ['J~c:2', 'J~c:0', 'J~b:1', 'J~b:0', 'J~a:2', 'J~a:1', 'J~a:0'], 'every entry once, in reverse, entries undone earlier left out');
  // a resume from a saved cursor continues exactly where the committed chunk ended
  const first = UJ.nextEntries(desc(), null, 3);
  const second = UJ.nextEntries(desc(), JSON.parse(JSON.stringify(first.cursor)), 3);
  assert.deepStrictEqual(second.entries.map((e) => `${e.rid}:${e.i}`), ['J~b:0', 'J~a:2', 'J~a:1']);
  // rows after the cursor's row (by id) are never read again; a whole receipt undone earlier is skipped
  const r2 = desc();
  r2[1].history.undone_by = 'r_y';
  const all = UJ.nextEntries(r2, null, 100);
  assert.deepStrictEqual(all.entries.map((e) => `${e.rid}:${e.i}`), ['J~c:2', 'J~c:0', 'J~a:2', 'J~a:1', 'J~a:0']);
  assert.strictEqual(all.exhausted, true);
  assert.strictEqual(all.skipped.already_undone, 3);
});

test('item 21: an undo job id is per caller; the reply never offers force', () => {
  assert.notStrictEqual(UJ.scopeKey('owner-a', { receipt_id: 'J' }), UJ.scopeKey('owner-b', { receipt_id: 'J' }));
  assert.strictEqual(UJ.scopeKey('o', { receipt_id: 'J', on_conflict: 'skip' }), UJ.scopeKey('o', { receipt_id: 'J' }), 'skip is the default');
  assert.notStrictEqual(UJ.scopeKey('o', { receipt_id: 'J', on_conflict: 'stop' }), UJ.scopeKey('o', { receipt_id: 'J' }));
  for (const h of [UJ.HINT_RUNNING, UJ.HINT_CONFLICTS, UJ.HINT_STOPPED]) assert.ok(!/force/.test(h), h);
});
