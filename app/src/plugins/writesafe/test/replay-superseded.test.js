'use strict';
// An implicit (version-bound) replay is answered with the stored reply only while the target still holds what the
// first write produced (MWS-RES-1: a success must mean the state is in effect). Since v3 tokens a fresh read after
// A -> B -> A gives a new token, but an if_match request, a publish after an unpublish and a late retry stay identical.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/model');
const E = require('../server/engine');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };
const log = { warn() {}, info() {}, error() {} };

const sup = (tool, args, replay, now) => E.supersededSince(tool, args, replay, now);

// ---------------------------------------------------------------- the pure rule, per write kind
test('patch: a replay whose produced version is still current is not superseded', () => {
  assert.equal(sup('ws_patch', {}, { version: 'v3.B' }, { current_version: 'v3.B' }), null);
});

test('patch: after the document went back to the requested version (A -> B -> A) the replay is superseded', () => {
  const r = sup('ws_patch', { expected_version: 'v3.A' }, { version: 'v3.B' }, { current_version: 'v3.A' });
  assert.deepStrictEqual(r, { kind: 'patch', produced: 'v3.B', current: 'v3.A' });
});

test('patch: a document that is gone is superseded', () => {
  assert.equal(sup('ws_patch', {}, { version: 'v3.B' }, { current_version: null }).kind, 'patch');
});

test('patch: an unchanged write (version equal to the one sent) stays a replay while that version holds', () => {
  assert.equal(sup('ws_patch', { expected_version: 'v3.A' }, { version: 'v3.A', unchanged: true }, { current_version: 'v3.A' }), null);
});

test('a reply that states nothing comparable is never superseded', () => {
  assert.equal(sup('ws_patch', {}, { ok: true }, { current_version: 'v3.C' }), null);
  assert.equal(sup('ws_publish', {}, { ok: true }, { live_version: null }), null);
});

test('localize: the target locale must still hold the version the translation produced', () => {
  assert.equal(sup('ws_localize', { locale: 'fr' }, { version: 'v3.T1' }, { current_version: 'v3.T1' }), null);
  assert.equal(sup('ws_localize', { locale: 'fr' }, { version: 'v3.T1' }, { current_version: null }).kind, 'patch');
});

test('publish: compared on the live version, which a publish produced (the draft version does not move)', () => {
  assert.equal(sup('ws_publish', {}, { published_version: 'v3.A' }, { current_version: 'v3.A', live_version: 'v3.A' }), null);
  // someone published another draft, then put the draft back: the draft reads as A again, live is not A
  assert.deepStrictEqual(sup('ws_publish', {}, { published_version: 'v3.A' }, { current_version: 'v3.A', live_version: 'v3.B' }),
    { kind: 'publish', produced: 'v3.A', current: 'v3.B' });
  // unpublished since
  assert.equal(sup('ws_publish', {}, { published_version: 'v3.A' }, { current_version: 'v3.A', live_version: null }).kind, 'publish');
});

test('publish: live_version (read back after the publish) wins over published_version', () => {
  // a relation to a target that is only a draft: the live row hashes differently from the draft that was published
  const replay = { published_version: 'v3.Draft', live_version: 'v3.Live' };
  assert.equal(sup('ws_publish', {}, replay, { live_version: 'v3.Live' }), null, 'a plain retry replays');
  assert.equal(sup('ws_publish', {}, replay, { live_version: 'v3.Other' }).kind, 'publish');
  const args = { items: [{ uid: 'u', documentId: 'x', action: 'publish', expected_version: 'v3.Draft' }] };
  assert.equal(sup('ws_batch', args, { items: [{ ref: '0', ...replay }] }, { current_versions: ['v3.Draft'], live_versions: ['v3.Live'] }), null);
});

test('patch with publish: "if_clean": the live row must still be what it published', () => {
  const replay = { version: 'v3.B', published: true, published_version: 'v3.B', live_version: 'v3.L' };
  assert.equal(sup('ws_patch', {}, replay, { current_version: 'v3.B', live_version: 'v3.L' }), null);
  assert.deepStrictEqual(sup('ws_patch', {}, replay, { current_version: 'v3.B', live_version: null }), { kind: 'publish', produced: 'v3.L', current: null });
});

test('delete: superseded only when a deleted locale exists again', () => {
  assert.equal(sup('ws_delete', {}, { deleted: true, previous_version: 'v3.A' }, { existing: [] }), null);
  assert.deepStrictEqual(sup('ws_delete', {}, { deleted: true, previous_version: 'v3.A' }, { existing: ['v3.A'] }),
    { kind: 'delete', produced: null, current: 'v3.A' });
});

test('batch: superseded when an item no longer holds what it produced; the refusal names the item', () => {
  const args = { items: [{ uid: 'u', documentId: 'x' }, { uid: 'u', documentId: 'y', ref: 'second' }] };
  const replay = { items: [{ ref: '0', version: 'v3.B1' }, { ref: 'second', version: 'v3.B2' }] };
  assert.equal(sup('ws_batch', args, replay, { current_versions: ['v3.B1', 'v3.B2'] }), null);
  const r = sup('ws_batch', args, replay, { current_versions: ['v3.B1', 'v3.A2'] });
  assert.equal(r.kind, 'batch');
  assert.deepStrictEqual(r.items, [{ index: 1, ref: 'second', kind: 'patch', produced: 'v3.B2', current: 'v3.A2' }]);
});

test('batch: two patch items of one document (item 16c chain) replay on a plain retry', () => {
  // item 0 moves X from A to V1, item 1 (no expected_version) carries on from V1 to V2: X now reads V2 for both items
  const args = { items: [{ uid: 'u', documentId: 'x', expected_version: 'v3.A' }, { uid: 'u', documentId: 'x' }] };
  const replay = { items: [{ ref: '0', version: 'v3.V1' }, { ref: '1', version: 'v3.V2' }] };
  assert.equal(sup('ws_batch', args, replay, { current_versions: ['v3.V2', 'v3.V2'] }), null);
  // and after A -> ... -> A it is superseded
  assert.equal(sup('ws_batch', args, replay, { current_versions: ['v3.A', 'v3.A'] }).items.length, 2);
});

test('batch: a publish item is judged by its live version', () => {
  const args = { items: [{ uid: 'u', documentId: 'x', expected_version: 'v3.A' }, { uid: 'u', documentId: 'x', action: 'publish' }] };
  const replay = { items: [{ ref: '0', version: 'v3.V1' }, { ref: '1', published_version: 'v3.V1' }] };
  assert.equal(sup('ws_batch', args, replay, { current_versions: ['v3.V1', 'v3.V1'], live_versions: [null, 'v3.V1'] }), null);
  const r = sup('ws_batch', args, replay, { current_versions: ['v3.V1', 'v3.V1'], live_versions: [null, 'v3.Z'] });
  assert.deepStrictEqual(r.items.map((x) => [x.index, x.kind]), [[1, 'publish']]);
});

// ---------------------------------------------------------------- annotateReplay, with a stub Strapi
const PAGE = 'api::page.page';
function stub(docs) {
  return {
    log,
    contentTypes: { [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, attributes: { note: { type: 'string' } } } },
    components: {},
    documents: () => ({ findOne: async ({ documentId, status }) => docs[`${documentId}:${status}`] || null }),
  };
}
const doc = (note) => ({ id: 1, documentId: 'd1', note });

test('annotateReplay: a plain retry right after the write is replayed (implicit record)', async () => {
  const s = stub({ 'd1:draft': doc('review') });
  const vB = M.versionOf(s, PAGE, doc('review'));
  const vA = M.versionOf(s, PAGE, doc('draft'));
  const out = await E.annotateReplay(s, 'ws_patch', { uid: PAGE, documentId: 'd1', expected_version: vA }, { ok: true, version: vB, receipt_id: 'r1', replayed: true }, true);
  assert.equal(out.replayed, true);
  assert.equal(out.current_version, vB);
});

test('annotateReplay: A -> B -> A is refused with replay_superseded, nothing written, current and produced named', async () => {
  const s = stub({ 'd1:draft': doc('draft') });
  const vB = M.versionOf(s, PAGE, doc('review'));
  const vA = M.versionOf(s, PAGE, doc('draft'));
  await assert.rejects(
    E.annotateReplay(s, 'ws_patch', { uid: PAGE, documentId: 'd1', expected_version: vA }, { ok: true, version: vB, receipt_id: 'r1', replayed: true }, true),
    (e) => e.payload.code === 'replay_superseded' && e.payload.requires_reread === true && e.payload.receipt_id === 'r1'
      && e.payload.current_version === vA && e.payload.produced_version === vB
      && /Nothing was written now/.test(e.payload.message) && /idempotency_key/.test(e.payload.message),
  );
});

test('annotateReplay: an idempotency_key replay is never refused as superseded', async () => {
  const s = stub({ 'd1:draft': doc('draft') });
  const vB = M.versionOf(s, PAGE, doc('review'));
  const out = await E.annotateReplay(s, 'ws_patch', { uid: PAGE, documentId: 'd1', idempotency_key: 'k1' }, { ok: true, version: vB, replayed: true }, false);
  assert.equal(out.replayed, true);
  assert.match(out.hint, /idempotency_key already answered/);
});

test('annotateReplay: a publish retry replays while live holds what it published, and is refused once live moved', async () => {
  const vA = M.versionOf(stub({}), PAGE, doc('draft'));
  const okS = stub({ 'd1:draft': doc('draft'), 'd1:published': doc('draft') });
  const out = await E.annotateReplay(okS, 'ws_publish', { uid: PAGE, documentId: 'd1', expected_version: vA }, { ok: true, published_version: vA, replayed: true }, true);
  assert.equal(out.replayed, true);
  const movedS = stub({ 'd1:draft': doc('draft'), 'd1:published': doc('other') });
  await assert.rejects(
    E.annotateReplay(movedS, 'ws_publish', { uid: PAGE, documentId: 'd1', expected_version: vA }, { ok: true, published_version: vA, replayed: true }, true),
    (e) => e.payload.code === 'replay_superseded' && /live version/.test(e.payload.message),
  );
});

test('annotateReplay: a delete retry replays while the document is gone, and is refused once it exists again', async () => {
  const vA = M.versionOf(stub({}), PAGE, doc('draft'));
  const args = { uid: PAGE, documentId: 'd1', expected_version: vA };
  const out = await E.annotateReplay(stub({}), 'ws_delete', args, { ok: true, deleted: true, previous_version: vA, replayed: true }, true);
  assert.equal(out.replayed, true);
  await assert.rejects(
    E.annotateReplay(stub({ 'd1:draft': doc('draft') }), 'ws_delete', args, { ok: true, deleted: true, previous_version: vA, replayed: true }, true),
    (e) => e.payload.code === 'replay_superseded' && /exists again/.test(e.payload.message),
  );
});
