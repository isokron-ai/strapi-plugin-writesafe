'use strict';
// A version_conflict carries the document's whole current state (MWS-CONC-6), not only the fields the refused write
// touched: another writer's change to a field the caller did not touch is part of the state current_version stands for.
// A token that cannot read the document gets neither content nor a version. A ws_undo conflict shows the fields that
// changed since the receipt and lists the rest in `omitted`.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/model');
const E = require('../server/engine');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };

const PAGE = 'api::page.page';
const ctx = { userAbility: {}, user: { id: 1 } };
const quiet = () => require('../server/modules').load(null, { modules: { history: false } });
const resetModules = () => require('../server/modules').load(null, { modules: {} });
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.payload || { message: e.message }; } };

/** The page as the caller read it, and as it is after another writer appended to the summary. */
const READ = { id: 1, documentId: 'd1', title: 'Picnic', summary: 'Bring snacks.', note: 'draft', secretCode: 'ACME-7731', publishedAt: null, updatedAt: '2026-11-16T10:00:00.000Z', createdAt: '2026-11-16T10:00:00.000Z' };
const NOW = { ...READ, summary: 'Bring snacks. Rain date: Sunday.', updatedAt: '2026-11-16T10:00:05.000Z' };

/** A Strapi with one page and a permission checker: `hidden` fields fail the field-level read check (and are filtered). */
function pageStrapi(draft, { hidden = [] } = {}) {
  const calls = { update: [] };
  const state = { draft: { ...draft } };
  const pc = {
    cannot: { update: () => false, publish: () => false, read: (e, f) => f !== undefined && hidden.includes(f), create: () => false, delete: () => false },
    can: { read: (e, f) => !(f !== undefined && hidden.includes(f)), update: () => true, publish: () => true },
    sanitizeOutput: async (d) => Object.fromEntries(Object.entries(d || {}).filter(([k]) => !hidden.includes(k))),
    sanitizeUpdateInput: () => async (d) => d,
  };
  const strapi = {
    contentTypes: {
      [PAGE]: {
        uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'page' },
        attributes: { title: { type: 'string' }, summary: { type: 'text' }, note: { type: 'text' }, secretCode: { type: 'string' } },
      },
    },
    components: {},
    config: { get: () => undefined },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    plugin: (n) => (n === 'content-manager' ? { service: () => ({ create: () => pc }) } : undefined),
    db: {
      config: { connection: { client: 'sqlite' } },
      transaction: async (cb) => cb({}),
      queryBuilder: () => {
        const ch = { select: () => ch, where: () => ch, orderBy: () => ch, forUpdate: () => ch, execute: async () => [{ id: 1, documentId: state.draft.documentId, updatedAt: state.draft.updatedAt }] };
        return ch;
      },
      query: () => ({ findOne: async () => null, findMany: async () => [], count: async () => 0 }),
    },
    documents: () => ({
      findOne: async (p) => (p.status === 'published' ? null : { ...state.draft }),
      update: async (p) => { calls.update.push(p); state.draft = { ...state.draft, ...(p.data || {}) }; return { ...state.draft }; },
    }),
  };
  return { strapi, calls, pc };
}

test('CONC-6: a stale ws_patch of `note` carries the other writer\'s summary edit and every other field, with its version', async () => {
  quiet();
  try {
    const stale = M.versionOf(pageStrapi(READ).strapi, PAGE, READ);
    const { strapi, calls } = pageStrapi(NOW);
    const e = await errOf(() => E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { note: 'checked by agent' }, expected_version: stale }));
    assert.strictEqual(e.code, 'version_conflict');
    assert.strictEqual(e.current.summary, 'Bring snacks. Rain date: Sunday.', 'a field the write did not touch');
    assert.strictEqual(e.current.title, 'Picnic');
    assert.strictEqual(e.current.note, 'draft');
    assert.ok(!('omitted' in e), 'the whole document: nothing omitted');
    assert.strictEqual(e.current_version, M.versionOf(strapi, PAGE, NOW), 'the version of the state shown');
    assert.strictEqual(e.retry.expected_version, e.current_version);
    assert.strictEqual(calls.update.length, 0);
  } finally { resetModules(); }
});

test('CONC-6: the whole state is filtered per field for the token (a field it may not read is left out, its value nowhere)', async () => {
  quiet();
  try {
    const stale = M.versionOf(pageStrapi(READ).strapi, PAGE, READ);
    const { strapi } = pageStrapi(NOW, { hidden: ['secretCode'] });
    const e = await errOf(() => E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { note: 'checked by agent' }, expected_version: stale }));
    assert.strictEqual(e.current.summary, 'Bring snacks. Rain date: Sunday.');
    assert.ok(!('secretCode' in e.current), 'unreadable field left out');
    assert.ok(!JSON.stringify(e).includes('ACME-7731'), 'its value appears nowhere in the reply');
  } finally { resetModules(); }
});

test('CONC-6: an if_match refusal names the differing fields and carries the whole state beside them', async () => {
  const { strapi, pc } = pageStrapi(NOW);
  const e = (await E.conflict(strapi, pc, PAGE, NOW, undefined, { fields_changed: ['summary'], message: 'A field named in if_match changed after you read it. Nothing was written.' })).payload;
  assert.deepStrictEqual(e.fields_changed, ['summary']);
  assert.strictEqual(e.current.note, 'draft', 'fields outside fields_changed are in current too');
  assert.match(e.message, /if_match/);
});

test('CONC-6: a delete conflict keeps its own advice (no version to retry with) and the whole state', async () => {
  const { strapi, pc } = pageStrapi(NOW);
  const e = (await E.conflict(strapi, pc, PAGE, NOW, 'v3.stale', { message: 'The document changed after you read it. Nothing was deleted.' }, 'delete')).payload;
  assert.ok(!('expected_version' in e.retry), 'no version handed out for a delete');
  assert.strictEqual(e.current.summary, 'Bring snacks. Rain date: Sunday.');
});

test('read permission: a localize target conflict for a token that cannot read the target locale shows no content or version', async () => {
  const { strapi, pc } = pageStrapi(NOW);
  pc.cannot.read = (e) => e !== undefined; // a conditional read rule this document fails: sanitizeOutput returns everything
  pc.sanitizeOutput = async (d) => ({ ...d });
  const e = (await E.conflict(strapi, pc, PAGE, NOW, 'v3.stale', { message: 'The target locale fr changed after you read it. Nothing was written.' }, 'localize')).payload;
  assert.strictEqual(e.readable, false);
  for (const k of ['current', 'current_rows', 'current_version']) assert.ok(!(k in e), `no ${k}`);
  assert.ok(!JSON.stringify(e).includes('Rain date') && !JSON.stringify(e).includes('ACME-7731'));
  assert.match(e.message, /target locale fr changed.*cannot read this document/);
});

test('ws_undo conflict: only the fields changed since the receipt, the other readable fields listed in `omitted`', async () => {
  const U = require('../server/modules/history/undo');
  const { strapi } = pageStrapi(NOW, { hidden: ['secretCode'] });
  const entry = { uid: PAGE, documentId: 'd1', locale: null, op: 'update', va: 'v3.receipt', f: { summary: { b: 'Bring snacks.' } } };
  const Eu = { ...E, permissionChecker: (s, c, uid) => E.permissionChecker(strapi, c, uid) };
  const p = await U.conflictPayload(strapi, ctx, Eu, entry, NOW, ['summary'], { item: 0 });
  assert.strictEqual(p.code, 'version_conflict');
  assert.deepStrictEqual(Object.keys(p.current).filter((k) => !['documentId', 'locale'].includes(k)), ['summary']);
  assert.strictEqual(p.current.summary, 'Bring snacks. Rain date: Sunday.', 'the other writer\'s value');
  assert.deepStrictEqual([...p.omitted].sort(), ['/note', '/title'], 'readable fields left out are listed; an unreadable one is not named');
  assert.ok(!JSON.stringify(p).includes('ACME-7731'));
  assert.deepStrictEqual(p.changed_since, ['summary']);
});
