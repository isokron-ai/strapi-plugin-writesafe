'use strict';
// Unit tests for the second-agent review of PR #18 (stream F): each finding that can be shown without a database.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };

const RO = require('../server/refops');
const C = require('../server/modules/history/capture');
const UJ = require('../server/modules/history/undo-job');

/** A receipts table in memory: the locking read sees the latest row, a consistent read may see an older snapshot. */
function fakeDb({ latest, stale }) {
  const updates = [];
  const loaded = { full: 0, ids: 0 };
  const rows = latest;
  const strapi = {
    db: {
      queryBuilder: () => {
        const qb = { cols: null, w: null };
        const api = {
          select(c) { qb.cols = c; return api; },
          where(w) { qb.w = w; return api; },
          forUpdate() { return api; },
          first() { return api; },
          async execute() {
            const r = rows.find((x) => Object.entries(qb.w).every(([k, v]) => x[k] === v));
            if (!r) return null;
            return Object.fromEntries(Object.entries(r).filter(([k]) => !qb.cols || qb.cols.includes(k)));
          },
        };
        return api;
      },
      query: () => ({
        async findOne({ where, select }) {
          const src = stale || rows;
          const r = src.find((x) => Object.entries(where).every(([k, v]) => x[k] === v));
          if (r && (!select || select.includes('moduleData'))) loaded.full += 1;
          return r || null;
        },
        async findMany({ where, select, orderBy, limit }) {
          let out = rows.filter((x) => {
            if (where.receiptId && where.receiptId.$startsWith) { if (!String(x.receiptId).startsWith(where.receiptId.$startsWith)) return false; } else if (where.receiptId && x.receiptId !== where.receiptId) return false;
            if (where.id && where.id.$lte !== undefined && !(x.id <= where.id.$lte)) return false;
            if (where.id && where.id.$lt !== undefined && !(x.id < where.id.$lt)) return false;
            return true;
          });
          if (orderBy && orderBy.id === 'desc') out = out.sort((a, b) => b.id - a.id);
          out = out.slice(0, limit || 1e9);
          if (select && !select.includes('moduleData')) { loaded.ids += out.length; return out.map((x) => Object.fromEntries(select.map((k) => [k, x[k]]))); }
          loaded.full += out.length;
          return out;
        },
        async update({ where, data }) { updates.push({ where, data }); const r = rows.find((x) => x.id === where.id); if (r) Object.assign(r, data); return r; },
      }),
    },
  };
  return { strapi, updates, loaded };
}
const hist = (h) => ({ history: h });

test('review M1: undone marks are read in the locking query, not from an older snapshot', async () => {
  const latest = [{ id: 1, receiptId: 'r1', moduleData: hist({ e: [{ i: 0 }, { i: 1 }], undone_items: { 0: 'u_a' } }) }];
  const stale = [{ id: 1, receiptId: 'r1', moduleData: hist({ e: [{ i: 0 }, { i: 1 }] }) }];
  const { strapi, updates } = fakeDb({ latest, stale });
  await C.markUndone(strapi, { id: 'r1', items: [1] }, 'u_b');
  const h = updates[updates.length - 1].data.moduleData.history;
  assert.deepStrictEqual(h.undone_items, { 0: 'u_a', 1: 'u_b' }, 'the other undo\'s mark (written after the snapshot) is kept');
  const latest2 = [{ id: 2, receiptId: 'r2', moduleData: hist({ e: [{ i: 0 }], undone_items: { 0: 'u_x' } }) }];
  const f2 = fakeDb({ latest: latest2, stale: [{ id: 2, receiptId: 'r2', moduleData: hist({ e: [{ i: 0 }] }) }] });
  await C.clearOrigin(f2.strapi, 'r2', 0);
  assert.deepStrictEqual(f2.updates[0].data.moduleData.history.undone_items, {}, 'clearOrigin clears the mark it reads under the lock');
});

test('review M5: a relation ref op becomes connect/disconnect of only its own links', () => {
  const p = RO.relationOps(['a', 'b', 'c'], [{ op: 'remove', ref: 'a' }, { op: 'add', ref: 'n' }, { op: 'add', ref: 'b' }, { op: 'remove', ref: 'zz' }]);
  assert.deepStrictEqual(p.payload, { disconnect: [{ documentId: 'a' }], connect: [{ documentId: 'n', position: { end: true } }] });
  assert.deepStrictEqual(p.statuses, ['removed', 'added', 'already_linked', 'not_linked']);
  assert.strictEqual(RO.relationOps(['a'], [{ op: 'add', ref: 'a' }]).payload, null, 'no-ops: no payload');
  assert.strictEqual(RO.relationOps(['a'], [{ op: 'add', ref: 'x' }, { op: 'remove', ref: 'x' }]).payload, null, 'add then remove nets out');
  assert.deepStrictEqual(RO.relationOps(['a', 'b'], [{ op: 'add', ref: 'n', position: 'start' }]).payload.connect, [{ documentId: 'n', position: { start: true } }]);
  assert.deepStrictEqual(RO.relationOps(['a', 'b'], [{ op: 'add', ref: 'n', position: { after: 'a' } }]).payload.connect, [{ documentId: 'n', position: { after: 'a' } }]);
  assert.deepStrictEqual(RO.relationOps(['a', 'b'], [{ op: 'add', ref: 'n', position: { index: 1 } }]).payload.connect, [{ documentId: 'n', position: { before: 'b' } }]);
  assert.deepStrictEqual(RO.relationOps(['a', 'b'], [{ op: 'remove', ref: 'b' }, { op: 'add', ref: 'b', position: 'start' }]).payload, { connect: [{ documentId: 'b', position: { start: true } }] }, 'remove then add: a move');
});

test('review M7: the undo job reads ids first and loads receipt rows one at a time', async () => {
  const rows = [10, 11, 12, 13, 14].map((id) => ({ id, receiptId: `J~r${id}`, createdAt: new Date(), moduleData: hist({ e: [{ i: 0 }, { i: 1 }, { i: 2 }] }) }));
  const { strapi, loaded } = fakeDb({ latest: rows });
  const g = await UJ.gather(strapi, { receipt_id: 'J', single: false, cursor: null }, 4);
  assert.deepStrictEqual(g.entries.map((e) => `${e.rid}:${e.i}`), ['J~r14:2', 'J~r14:1', 'J~r14:0', 'J~r13:2']);
  assert.ok(loaded.full <= 2, `loaded ${loaded.full} full rows for 4 entries`);
});

test('review L1: clearing a component that holds lists is a nested list change', () => {
  const S = { components: { 'x.f': { attributes: { people: { type: 'relation', relation: 'manyToMany', target: 'api::a.a' }, inner: { type: 'component', repeatable: false, component: 'x.i' } } }, 'x.i': { attributes: { tags: { type: 'relation', relation: 'manyToMany', target: 'api::a.a' }, label: { type: 'string' } } }, 'x.p': { attributes: { label: { type: 'string' } } } } };
  assert.deepStrictEqual(RO.nestedListChanges(S, 'x.f', { inner: null }, { id: 1, people: [], inner: { id: 2, tags: ['t'] } }, 'feature'), ['feature.inner']);
  assert.ok(RO.hasNestedList(S, 'x.f') && !RO.hasNestedList(S, 'x.p'));
});

test('review L4: a legacy whole-receipt too-large mark makes every entry not undoable, creates too', () => {
  const v = UJ.rowView({ id: 1, receiptId: 'r', createdAt: new Date(), moduleData: hist({ t: 1, e: [{ i: 0, op: 'create' }, { i: 1, op: 'update' }] }) });
  assert.deepStrictEqual(v.history.e.map((e) => e.t), [1, 1]);
});

test('review L7: stored chunk records keep no driver text', () => {
  assert.deepStrictEqual(UJ.storedError({ code: 'write_failed', message: 'm', driver_error: 'secret value', details: [1] }), { code: 'write_failed', message: 'm', details: [1] });
});

test('review L8: an undo job without a per-token identity says what it needs', async () => {
  class WsError extends Error { constructor(p) { super(p.message); this.payload = p; } }
  const E = { WsError, requireUniqueIndex() {}, tokenScope() { throw new WsError({ code: 'unsupported', message: 'no header' }); } };
  await assert.rejects(UJ.handle({}, {}, E, { receipt_id: 'J' }, {}), (e) => e.payload.code === 'unsupported' && /undo job/.test(e.payload.message) && /Authorization/.test(e.payload.message));
});
