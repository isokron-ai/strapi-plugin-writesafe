'use strict';

// Unit tests for the 1.0 hardening Phase 3 bulk core (stream E): plan tokens (item 17), the job store and its
// ceiling (item 18), the replacer per chunk (item 22), the status page and the scan limit (item 23).
// Modules are required inside each test, so a missing one fails that test only. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };

const need = (p) => require(p);
const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return (e.payload && e.payload.code) || e.message; } };
const fakeStrapi = (cfg = {}, keys = ['k1', 'k2']) => ({ config: { get: (k) => (k === 'server.app.keys' ? keys : k === 'plugin::writesafe' ? cfg : undefined) }, log: { warn() {}, info() {}, error() {} } });

// ---------------------------------------------------------------- item 17: plan token

const FIELDS = {
  owner: '7:abcdef0123456789', uid: 'api::page.page', locale: 'en', filters: { title: { $startsWith: 'x' } }, action: 'patch', specHash: 'h'.repeat(64),
};

test('item 17: a plan token carries a full-length HMAC-SHA256 and verifies only for its own request and holder', () => {
  const P = need('../server/modules/_bulk/plan');
  P.setKey('unit-key');
  const st = fakeStrapi();
  const idHash = P.idListHash(['a', 'b', 'c']);
  const s = P.sign(st, { ...FIELDS, count: 3, idHash, undoable: true }, 900);
  assert.match(s.token, /^wsp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/, 'wsp1.<payload>.<43-char base64url MAC = 256 bits>');
  const p = P.parse(s.token);
  assert.deepStrictEqual({ n: p.count, h: p.idHash, u: p.undoable }, { n: 3, h: idHash, u: true });
  assert.ok(P.verify(st, p, FIELDS), 'verifies for the same request');
  for (const [k, v] of Object.entries({ owner: '8:abcdef0123456789', uid: 'api::story.story', locale: 'fr', filters: { title: { $startsWith: 'y' } }, action: 'publish', specHash: 'g'.repeat(64) })) {
    assert.strictEqual(P.verify(st, p, { ...FIELDS, [k]: v }), false, `another ${k} does not verify`);
  }
  // the filter is canonical: key order does not matter
  const f2 = { ...FIELDS, filters: { $and: [{ a: 1, b: 2 }] } };
  const s2 = P.sign(st, { ...f2, count: 1, idHash, undoable: false }, 900);
  assert.ok(P.verify(st, P.parse(s2.token), { ...f2, filters: { $and: [{ b: 2, a: 1 }] } }));
});

test('item 17: an altered payload (count, id hash, undoable, expiry) breaks the MAC; garbage does not parse', () => {
  const P = need('../server/modules/_bulk/plan');
  P.setKey('unit-key');
  const st = fakeStrapi();
  const s = P.sign(st, { ...FIELDS, count: 3, idHash: P.idListHash(['a', 'b', 'c']), undoable: false }, 900);
  const [pre, payload, mac] = s.token.split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
  for (const change of [{ n: 4 }, { h: P.idListHash(['a', 'b']) }, { u: 1 }, { e: body.e + 3600 }, { r: 'A'.repeat(16) }]) {
    const forged = `${pre}.${Buffer.from(JSON.stringify({ ...body, ...change })).toString('base64url')}.${mac}`;
    const p = P.parse(forged);
    assert.ok(p, 'still well formed');
    assert.strictEqual(P.verify(st, p, FIELDS), false, `forged ${Object.keys(change)[0]} refused`);
  }
  for (const bad of ['', 'x', 'wsp1.a.b', `wsp2.${payload}.${mac}`, `${pre}.${payload}.${mac.slice(1)}`, 'wsp1.!!!.' + 'a'.repeat(43), 42, null]) assert.strictEqual(P.parse(bad), null, String(bad));
});

test('item 17: the plan key comes from the app keys; another app (other APP_KEYS) cannot verify the token', () => {
  const P = need('../server/modules/_bulk/plan');
  P.setKey('app-one');
  const s = P.sign(fakeStrapi(), { ...FIELDS, count: 1, idHash: P.idListHash(['a']), undoable: false }, 900);
  P.setKey('app-two');
  assert.strictEqual(P.verify(fakeStrapi(), P.parse(s.token), FIELDS), false);
  P.setKey('app-one');
  assert.ok(P.verify(fakeStrapi(), P.parse(s.token), FIELDS));
});

test('item 17: expiry, and the job id derived from the plan', () => {
  const P = need('../server/modules/_bulk/plan');
  P.setKey('unit-key');
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const s = P.sign(fakeStrapi(), { ...FIELDS, count: 1, idHash: P.idListHash(['a']), undoable: false }, 900, now);
  const p = P.parse(s.token);
  assert.strictEqual(s.expires_at, '2026-11-13T12:15:00.000Z', '15 minutes');
  assert.strictEqual(P.expired(p, now + 899000), false);
  assert.strictEqual(P.expired(p, now + 900000), true);
  assert.match(P.jobIdOf(p.mac), /^j[0-9a-f]{23}$/);
  assert.strictEqual(P.jobIdOf(p.mac), P.jobIdOf(P.parse(s.token).mac), 'same plan, same job');
  const s2 = P.sign(fakeStrapi(), { ...FIELDS, count: 1, idHash: P.idListHash(['a']), undoable: false }, 900, now);
  assert.notStrictEqual(P.jobIdOf(P.parse(s2.token).mac), P.jobIdOf(p.mac), 'a new dry run is a new plan, even in the same second');
});

test('item 17/19: the id-list hash binds order, membership and (publish) each draft version', () => {
  const P = need('../server/modules/_bulk/plan');
  const h = P.idListHash(['a', 'b']);
  assert.notStrictEqual(h, P.idListHash(['b', 'a']));
  assert.notStrictEqual(h, P.idListHash(['a', 'b', 'c']));
  assert.strictEqual(h, P.idListHash([{ documentId: 'a' }, { documentId: 'b' }]));
  const v1 = P.idListHash([{ documentId: 'a', version: 'v2.one' }, { documentId: 'b', version: 'v2.two' }]);
  assert.notStrictEqual(v1, P.idListHash([{ documentId: 'a', version: 'v2.one' }, { documentId: 'b', version: 'v2.NEW' }]), 'a newer draft is another plan');
  assert.match(h, /^[A-Za-z0-9_-]{43}$/);
});

// ---------------------------------------------------------------- item 18: ceiling, store, canary, preview

test('item 18: ceiling 5,000 by default; an admin may raise it to the hard 100,000, not past it', () => {
  const U = need('../server/modules/_bulk/util');
  assert.strictEqual(U.HARD_MAX_DOCUMENTS, 100000);
  assert.strictEqual(U.settings(fakeStrapi({})).bulk.maxDocuments, 5000);
  assert.strictEqual(U.settings(fakeStrapi({ bulk: { maxDocuments: 100000 } })).bulk.maxDocuments, 100000);
  assert.strictEqual(codeOf(() => U.validate({ bulk: { maxDocuments: 100000 } })), 'ok');
  assert.match(codeOf(() => U.validate({ bulk: { maxDocuments: 100001 } })), /at most 100000/);
  assert.match(codeOf(() => U.validate({ bulk: { maxDocuments: 0 } })), /integer >= 1/);
  assert.match(codeOf(() => U.validate({ bulk: { paceMs: -1 } })), /integer >= 0/);
  assert.match(codeOf(() => U.validate({ bulk: { paused: 'yes' } })), /boolean/);
  assert.strictEqual(U.settings(fakeStrapi({ bulk: { maxDocuments: 250000 } })).bulk.maxDocuments, 100000, 'clamped even if validation was bypassed');
  const CFG = need('../server/config');
  assert.throws(() => CFG.validator({ bulk: { maxDocuments: 500000 } }), /at most 100000/, 'the plugin config validator refuses it at startup');
});

test('item 18: job store: two tables; the id snapshot is item rows written once in batches; a chunk writes fixed-size job fields', async () => {
  const S = need('../server/modules/_bulk/store');
  assert.deepStrictEqual(Object.keys(S.contentTypes).sort(), ['bulk-item', 'bulk-job']);
  assert.strictEqual(S.contentTypes['bulk-job'].schema.collectionName, 'writesafe_bulk_jobs');
  assert.strictEqual(S.contentTypes['bulk-item'].schema.collectionName, 'writesafe_bulk_items');
  const jobAttrs = Object.keys(S.contentTypes['bulk-job'].schema.attributes);
  for (const k of ['cursor', 'total', 'nOk', 'nFailed', 'nConflict', 'slot', 'state']) assert.ok(jobAttrs.includes(k), k);
  assert.ok(!jobAttrs.includes('ids'), 'no id list in the job row');
  const calls = [];
  const db = { query: (uid) => ({
    create: async (a) => calls.push(['create', uid, a.data]),
    createMany: async (a) => calls.push(['createMany', uid, a.data.length]),
    update: async (a) => calls.push(['update', uid, a.data]),
  }) };
  const st = { db };
  const entries = Array.from({ length: 1001 }, (_, i) => ({ documentId: `d${i}` }));
  await S.createJob(st, { jobId: 'j1', owner: 'o', total: 1001 }, entries);
  assert.deepStrictEqual(calls.map((c) => c[0] === 'createMany' ? c[2] : c[0]), ['create', 200, 200, 200, 200, 200, 1], 'job row, then 1,001 items in 6 batches');
  calls.length = 0;
  const job = { id: 5, state: 'running', cursor: 1000, chunks: 40, nOk: 999, slot: 'o|u' };
  await S.saveJob(st, job, ['state', 'cursor', 'chunks', 'nOk', 'slot']);
  assert.strictEqual(calls.length, 1);
  assert.ok(JSON.stringify(calls[0][2]).length < 200, 'a chunk writes a small fixed-size job update, whatever the job size');
});

test('item 23: a status page reads at most limit + 1 item rows and hands out a cursor', async () => {
  const S = need('../server/modules/_bulk/store');
  const rows = Array.from({ length: 50000 }, (_, i) => ({ ordinal: i, docId: `d${i}`, state: i % 7 ? 'ok' : 'failed' }));
  let read = 0;
  const st = { db: { query: () => ({ findMany: async ({ where, limit }) => {
    const out = rows.filter((r) => r.ordinal > where.ordinal.$gt && (!where.state || where.state.$in.includes(r.state))).slice(0, limit);
    read += out.length;
    return out;
  } }) } };
  const p1 = await S.pageItems(st, 'j', { limit: 200 });
  assert.strictEqual(p1.rows.length, 200);
  assert.strictEqual(read, 201, 'never more than one page plus one row');
  assert.strictEqual(p1.next, 199);
  const p2 = await S.pageItems(st, 'j', { after: p1.next, limit: 200 });
  assert.strictEqual(p2.rows[0].ordinal, 200);
  const f = await S.pageItems(st, 'j', { states: ['failed'], limit: 3 });
  assert.deepStrictEqual(f.rows.map((r) => r.ordinal), [0, 7, 14]);
});

test('item 18: canary: the first chunk pauses the job when a document failed or conflicted, or none changed', () => {
  const J = need('../server/modules/_bulk/jobs');
  const it = (s) => ({ documentId: s, status: s });
  assert.strictEqual(J.canary([it('ok'), it('ok'), it('unchanged')]), null, 'a healthy first chunk');
  assert.strictEqual(J.canary([it('ok'), it('failed')]).code, 'paused_canary');
  assert.strictEqual(J.canary([it('ok'), it('conflict')]).conflict, 1);
  assert.match(J.canary([it('unchanged'), it('skipped')]).why, /changed nothing/);
});

test('item 18: the dry-run preview is spread over the matches (first ... last)', () => {
  const J = need('../server/modules/_bulk/jobs');
  assert.deepStrictEqual(J.previewPositions(2013, 5), [0, 503, 1006, 1509, 2012]);
  assert.deepStrictEqual(J.previewPositions(3, 5), [0, 1, 2]);
  assert.deepStrictEqual(J.previewPositions(10, 1), [0]);
  assert.deepStrictEqual(J.previewPositions(0, 5), []);
});

test('item 17: the spec hash binds what the job does, not how it is run, read or checked', () => {
  const J = need('../server/modules/_bulk/jobs');
  const a = { uid: 'api::page.page', filters: { t: 1 }, set: { s: 'x' } };
  const d = (set) => ({ action: 'patch', spec: { set } });
  const h = J.specHash('ws_bulk', a, d({ s: 'x' }));
  assert.strictEqual(h, J.specHash('ws_bulk', { ...a, dry_run: true, preview: 3, plan_token: 'p', chunk_size: 5, max_chunks: 1, expected_count: 4, agent: 'x', locale: 'en' }, d({ s: 'x' })));
  assert.strictEqual(h, J.specHash('ws_bulk', { ...a, mode: 'stop_on_error', allow_all: false }, d({ s: 'x' })), 'defaults are the same plan');
  assert.notStrictEqual(h, J.specHash('ws_bulk', a, d({ s: 'y' })));
  assert.notStrictEqual(h, J.specHash('ws_bulk', { ...a, mode: 'continue' }, d({ s: 'x' })));
  assert.notStrictEqual(h, J.specHash('ws_bulk', { ...a, allow_all: true }, d({ s: 'x' })));
  assert.notStrictEqual(h, J.specHash('ws_replace', a, d({ s: 'x' })));
});

test('item 17: an empty or missing filter selects everything (filter_required unless allow_all)', () => {
  const J = need('../server/modules/_bulk/jobs');
  assert.strictEqual(J.isEmptyFilter(undefined), true);
  assert.strictEqual(J.isEmptyFilter({}), true);
  assert.strictEqual(J.isEmptyFilter({ title: { $eq: 'x' } }), false);
});

// ---------------------------------------------------------------- item 22: one regex budget per chunk

test('item 22 (N12): one replacer per job chunk; the chunk ends before a document could get less than its own limit', () => {
  const R = need('../server/modules/replace');
  const cfg = { regexTimeoutMs: 100, totalRegexMs: 5000, chunkRegexMs: 250, maxPatternLength: 100, maxReplaceLength: 100, maxOutputLength: 1000 };
  R._setConfig(cfg);
  const spec = { find: '(a+)+$', replace: '', regex: true };
  const chunk = {};
  const r1 = R.chunkReplacer(chunk, spec);
  assert.strictEqual(R.chunkReplacer(chunk, spec), r1, 'the same replacer for every document of the chunk');
  const J = need('../server/modules/_bulk/jobs');
  const full = J.actions.replace.chunkFull;
  assert.strictEqual(full(chunk), false, 'fresh budget');
  for (let i = 0; i < 2; i += 1) { try { r1(['a'.repeat(40) + '!']); } catch { /* regex_timeout */ } }
  assert.ok(r1.left() <= 50, `two slow documents used the chunk budget (left ${r1.left()} ms)`);
  assert.strictEqual(full(chunk), true, 'the chunk commits and the next one gets a fresh budget');
  assert.notStrictEqual(R.chunkReplacer({}, spec), r1, 'a new chunk, a new replacer');
});

// ---------------------------------------------------------------- item 23: ws_replace scan limit

test('item 23: ws_replace has its own scan limit (maxScanDocuments; rc.2 scanMax still read), separate from maxDocuments', () => {
  const U = need('../server/modules/_bulk/util');
  const d = U.settings(fakeStrapi({}));
  assert.strictEqual(d.replace.maxScanDocuments, 5000);
  assert.strictEqual(d.bulk.maxDocuments, 5000);
  const s = U.settings(fakeStrapi({ bulk: { maxDocuments: 200 }, replace: { maxScanDocuments: 20000 } }));
  assert.deepStrictEqual([s.bulk.maxDocuments, s.replace.maxScanDocuments], [200, 20000], 'independent');
  assert.strictEqual(U.settings(fakeStrapi({ replace: { scanMax: 7000 } })).replace.maxScanDocuments, 7000, 'rc.2 name');
  assert.strictEqual(U.settings(fakeStrapi({ replace: { scanMax: 7000, maxScanDocuments: 9000 } })).replace.maxScanDocuments, 9000, 'the new name wins');
  assert.match(codeOf(() => U.validate({ replace: { maxScanDocuments: 100001 } })), /at most 100000/);
  assert.match(codeOf(() => U.validate({ replace: { chunkRegexMs: 100, regexTimeoutMs: 250 } })), /chunkRegexMs/);
});

test('reply contract: the new plan errors require a dry run again', () => {
  const R = need('../server/reply');
  for (const c of ['plan_mismatch', 'plan_expired']) assert.deepStrictEqual([R.typed({ code: c }).retryable, R.typed({ code: c }).requires_reread], [false, true], c);
});
