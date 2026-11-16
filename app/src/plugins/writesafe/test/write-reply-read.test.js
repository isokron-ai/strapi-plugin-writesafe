'use strict';
// Write replies and read permission: a token that may write a document but not read it (no read rule for the type, or
// a conditional read rule the document fails) gets the write's facts (ids, versions, the paths it changed) and no
// document content. In Strapi 5.62 the read sanitizer removes nothing in those two cases, so the mock's sanitizer
// returns everything while cannot.read is true, as the real permission checker does.
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

const MARK = 'HID-77'; // a value only a reader may see
const DRAFT = { id: 1, documentId: 'd1', title: 'Picnic', summary: `Rain date ${MARK}`, note: 'draft', publishedAt: null, updatedAt: '2026-11-16T10:00:00.000Z', createdAt: '2026-11-16T10:00:00.000Z' };

/** One page; `read`: 'all' (a reader), 'none' (no read rule) or 'condition' (a conditional rule this document fails). */
function pageStrapi(draft, read = 'none') {
  const calls = { update: [], create: [], delete: [], publish: [] };
  const state = { draft: { ...draft }, live: null };
  const cannotRead = (e, f) => (read === 'all' ? false : read === 'none' ? true : e !== undefined && e !== null);
  const pc = {
    cannot: { update: () => false, publish: () => false, read: cannotRead, create: () => false, delete: () => false },
    can: { read: (e, f) => !cannotRead(e, f), update: () => true, publish: () => true, create: () => true, delete: () => true },
    sanitizeOutput: async (d) => (d ? { ...d } : d), // Strapi 5.62 with no read rule, or a failed condition: nothing removed
    sanitizeUpdateInput: () => async (d) => d,
    sanitizeCreateInput: async (d) => d,
  };
  const strapi = {
    contentTypes: {
      [PAGE]: {
        uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'page' },
        attributes: { title: { type: 'string' }, summary: { type: 'text' }, note: { type: 'text' } },
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
        const ch = { select: () => ch, where: () => ch, orderBy: () => ch, forUpdate: () => ch, execute: async () => [{ id: 1, documentId: state.draft.documentId, locale: null, updatedAt: state.draft.updatedAt }] };
        return ch;
      },
      query: () => ({ findOne: async () => null, findMany: async () => [], count: async () => 0, create: async () => ({}), delete: async () => ({}), deleteMany: async () => ({}) }),
    },
    documents: () => ({
      findOne: async (p) => (p.status === 'published' ? (state.live ? { ...state.live } : null) : { ...state.draft }),
      findMany: async () => [{ ...state.draft }],
      count: async () => 1,
      update: async (p) => {
        calls.update.push(p);
        const { updatedBy, ...data } = p.data || {};
        state.draft = { ...state.draft, ...data, updatedAt: '2026-11-16T10:00:09.000Z' };
        return { ...state.draft };
      },
      create: async (p) => { calls.create.push(p); const { createdBy, updatedBy, ...data } = p.data || {}; state.draft = { ...DRAFT, ...data, documentId: 'd2', id: 2 }; return { ...state.draft }; },
      delete: async (p) => { calls.delete.push(p); return { documentId: p.documentId }; },
      publish: async (p) => { calls.publish.push(p); return { documentId: p.documentId }; },
    }),
  };
  return { strapi, calls, state, pc };
}
const versionOf = (s) => M.versionOf(s.strapi, PAGE, s.state.draft);
const noContent = (r) => {
  assert.strictEqual(r.readable, false, 'the reply says the token cannot read the document');
  assert.ok(!JSON.stringify(r).includes(MARK), `no document content in the reply: ${JSON.stringify(r)}`);
};

for (const read of ['none', 'condition']) {
  test(`ws_patch return "full" by a token that may update but not read (${read}): the receipt's facts, no document`, async () => {
    quiet();
    try {
      const s = pageStrapi(DRAFT, read);
      const r = await E.applyPatch(s.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { note: 'agent' }, expected_version: versionOf(s), return: 'full' });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.changed, ['note']);
      assert.ok(r.version && r.previous_version, 'versions stay: the write\'s facts');
      assert.ok(!('document' in r));
      noContent(r);
      assert.strictEqual(s.calls.update.length, 1, 'the write itself is allowed');
    } finally { resetModules(); }
  });
}

test('ws_patch dry_run by a token that may update but not read: no diff of the document\'s values', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'none');
    const r = await E.applyPatch(s.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { summary: 'x' }, expected_version: versionOf(s), dry_run: true });
    assert.ok(!('diff' in r));
    noContent(r);
  } finally { resetModules(); }
});

test('control: a reader still gets return "full" and the dry-run diff', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'all');
    const r = await E.applyPatch(s.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { note: 'agent' }, expected_version: versionOf(s), return: 'full' });
    assert.strictEqual(r.document.summary, `Rain date ${MARK}`);
    assert.ok(!('readable' in r));
  } finally { resetModules(); }
});

test('ws_publish dry_run by a token that may publish but not read: no draft-vs-live diff of its values', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'condition');
    const r = await E.applyPublish(s.strapi, ctx, { uid: PAGE, documentId: 'd1', expected_version: versionOf(s), dry_run: true });
    assert.strictEqual(r.diff, null);
    assert.match(r.diff_note, /not readable/);
    assert.ok(!JSON.stringify(r).includes(MARK));
    assert.strictEqual(s.calls.publish.length, 0);
  } finally { resetModules(); }
});

test('ws_create return "full" by a token that may create but not read: the create\'s facts, no document', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'none');
    const C = require('../server/modules/create');
    const r = await C.applyCreate(s.strapi, ctx, { uid: PAGE, data: { title: 'New', summary: `Rain date ${MARK}` }, return: 'full' });
    assert.strictEqual(r.created, true);
    assert.ok(r.documentId && r.version);
    assert.ok(!('document' in r));
    noContent(r);
  } finally { resetModules(); }
});

test('ws_delete by a token that may delete but not read: no recreate data (the deleted content)', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'condition');
    const D = require('../server/modules/delete');
    const r = await D.applyDelete(s.strapi, ctx, { uid: PAGE, documentId: 'd1', expected_version: versionOf(s) });
    assert.strictEqual(r.deleted, true);
    assert.ok(r.previous_version);
    assert.ok(!('recreate' in r));
    noContent(r);
  } finally { resetModules(); }
});

test('control: a reader still gets the recreate data after a delete', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'all');
    const D = require('../server/modules/delete');
    const r = await D.applyDelete(s.strapi, ctx, { uid: PAGE, documentId: 'd1', expected_version: versionOf(s) });
    assert.strictEqual(r.recreate[0].args.data.summary, `Rain date ${MARK}`);
  } finally { resetModules(); }
});

test('ws_bulk preview item for a document the token cannot read: what changes, no before/after values', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'condition');
    const J = require('../server/modules/_bulk/jobs');
    const job = { uid: PAGE, tool: 'ws_bulk', locale: null, spec: { set: { summary: 'x' } } };
    const item = await J.actions.patch.apply(s.strapi, ctx, job, 'd1', { ...s.state.draft }, versionOf(s), true);
    assert.deepStrictEqual(item.changed, ['summary']);
    assert.ok(!('before' in item) && !('after' in item));
    noContent(item);
  } finally { resetModules(); }
});

test('ws_replace: a document the token cannot read is not searched (no samples, no change)', async () => {
  quiet();
  try {
    const s = pageStrapi(DRAFT, 'none');
    const R = require('../server/modules/replace');
    R._setConfig({ regexTimeoutMs: 100, totalRegexMs: 5000, chunkRegexMs: 250, maxPatternLength: 100, maxReplaceLength: 100, maxOutputLength: 1000, samples: 5 });
    const J = require('../server/modules/_bulk/jobs');
    const job = { uid: PAGE, tool: 'ws_replace', locale: null, spec: { find: 'Rain', replace: 'Snow', fields: ['summary'] } };
    const item = await J.actions.replace.apply(s.strapi, ctx, job, 'd1', { ...s.state.draft }, versionOf(s), true, {});
    assert.strictEqual(item.status, 'skipped');
    assert.strictEqual(item.reason, 'not_readable');
    assert.ok(!JSON.stringify(item).includes(MARK));
    assert.strictEqual(s.calls.update.length, 0);
  } finally { resetModules(); }
});

// ---------------------------------------------------------------- review of #46: history keeps the recreate image
test('ws_delete by a no-read token keeps the recreate image server-side: a reader\'s ws_undo brings the content back', async () => {
  quiet();
  const MODS = require('../server/modules');
  const C = require('../server/modules/history/capture');
  const U = require('../server/modules/history/undo');
  const saved = { has: MODS.hasAfterWrite, after: MODS.afterWrite, before: MODS.beforeWrite };
  const entries = [];
  try {
    // the history hook as capture.afterWrite records it (full drafts from info.raw, the token's view for the image)
    MODS.hasAfterWrite = () => true;
    MODS.beforeWrite = async () => {};
    MODS.afterWrite = async (c, info, before, after) => {
      const raw = info.raw || {};
      const full = (k, v) => (k in raw ? raw[k] : v);
      entries.push(C.entryOf(info, full('before', before), full('after', after), { before, after }));
      return undefined;
    };
    const writer = pageStrapi(DRAFT, 'none');
    C.configure(writer.strapi, {});
    const D = require('../server/modules/delete');
    const r = await D.applyDelete(writer.strapi, ctx, { uid: PAGE, documentId: 'd1', expected_version: versionOf(writer) });
    noContent(r); // the reply still shows nothing
    const e = entries.find((x) => x.op === 'delete');
    assert.ok(e && e.doc && e.doc.summary === `Rain date ${MARK}`, `the stored recreate image has the content: ${JSON.stringify(e && e.doc)}`);
    // a reader (e.g. an admin) undoes the delete
    const reader = pageStrapi(DRAFT, 'all');
    const out = await U.revertOne(reader.strapi, ctx, E, { ...e, rid: 1, i: 0 }, { raw: null, args: {} });
    assert.strictEqual(out.kind, 'item');
    assert.strictEqual(out.value.op, 'recreated');
    const created = reader.calls.create[0] && reader.calls.create[0].data;
    assert.strictEqual(created.summary, `Rain date ${MARK}`, 'the content comes back, not an empty draft');
    assert.strictEqual(created.title, 'Picnic');
  } finally {
    MODS.hasAfterWrite = saved.has; MODS.afterWrite = saved.after; MODS.beforeWrite = saved.before;
    resetModules();
  }
});

// ---------------------------------------------------------------- review of #46: filters select readable documents only
/** Documents of two users; a tiny evaluator for the filters match() sends ($and, field $eq, createdBy.id $eq). */
const DOCS = [
  { id: 1, documentId: 'a1', title: 'mine', secretCode: 'K-1', createdBy: { id: 1 } },
  { id: 2, documentId: 'b1', title: 'theirs', secretCode: 'K-2', createdBy: { id: 2 } },
];
const evalFilter = (d, f) => {
  if (!f || !Object.keys(f).length) return true;
  return Object.entries(f).every(([k, v]) => {
    if (k === '$and') return v.every((x) => evalFilter(d, x));
    if (k === 'createdBy') return d.createdBy && d.createdBy.id === v.id.$eq;
    return v && '$eq' in v ? d[k] === v.$eq : true;
  });
};
function filterStrapi({ readRule, readConds = {} }) {
  const seen = [];
  const pc = {
    cannot: { update: () => false, publish: () => false, read: () => !readRule, create: () => false, delete: () => false },
    can: { read: () => readRule },
    // Strapi 5.62 with no read rule, or a conditional one: both pass a filter on any field unchanged (shouldIncludeAll)
    validateQuery: async () => {},
    sanitizeQuery: async (q) => q,
    sanitizedQuery: Object.assign(async () => ({}), { read: async () => ({ filters: readConds }), update: async () => ({}), publish: async () => ({}) }),
    sanitizeOutput: async (d) => d,
  };
  const strapi = {
    contentTypes: { [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'page' }, attributes: { title: { type: 'string' }, secretCode: { type: 'string' } } } },
    components: {},
    config: { get: () => undefined },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    plugin: (n) => (n === 'content-manager' ? { service: () => ({ create: () => pc }) } : undefined),
    db: { config: { connection: { client: 'sqlite' } }, transaction: async (cb) => cb({}), query: () => ({ findOne: async () => null, findMany: async () => [], count: async () => 0 }) },
    documents: () => ({
      count: async (p) => { seen.push(p.filters); return DOCS.filter((d) => evalFilter(d, p.filters)).length; },
      findMany: async (p) => { seen.push(p.filters); return DOCS.filter((d) => evalFilter(d, p.filters)).map((d) => ({ id: d.id, documentId: d.documentId })); },
    }),
  };
  return { strapi, seen };
}

test('ws_bulk / ws_replace selection: a token with no read rule cannot select by a filter (no count of guesses)', async () => {
  quiet();
  try {
    const J = require('../server/modules/_bulk/jobs');
    const s = filterStrapi({ readRule: false });
    let err = null;
    try { await J.match(s.strapi, ctx, PAGE, null, { secretCode: { $eq: 'K-2' } }, 'patch', 1000); } catch (e) { err = e.payload; }
    assert.ok(err, 'refused');
    assert.strictEqual(err.code, 'forbidden');
    assert.ok(!('match_count' in err) && !('count' in err));
    assert.strictEqual(s.seen.length, 0, 'nothing was counted');
  } finally { resetModules(); }
});

test('ws_bulk / ws_replace selection: an own-entries token filtering on another user\'s value counts only its own documents', async () => {
  quiet();
  try {
    const J = require('../server/modules/_bulk/jobs');
    const s = filterStrapi({ readRule: true, readConds: { createdBy: { id: { $eq: 1 } } } });
    // one read rule, own entries, every field: a filter on secretCode is allowed (every read rule allows it)
    const ownCtx = { ...ctx, userAbility: { rulesFor: () => [{ conditions: { 'createdBy.id': 1 } }] } };
    const hit = await J.match(s.strapi, ownCtx, PAGE, null, { secretCode: { $eq: 'K-2' } }, 'patch', 1000);
    assert.strictEqual(hit.count, 0, 'a right guess about another user\'s document gives no signal');
    const miss = await J.match(s.strapi, ownCtx, PAGE, null, { secretCode: { $eq: 'K-9' } }, 'patch', 1000);
    assert.strictEqual(miss.count, hit.count);
    const own = await J.match(s.strapi, ownCtx, PAGE, null, { secretCode: { $eq: 'K-1' } }, 'patch', 1000);
    assert.strictEqual(own.count, 1);
    assert.deepStrictEqual(own.ids, ['a1']);
    assert.ok(JSON.stringify(hit.qfilters).includes('createdBy'), 'the read conditions are part of the selection');
  } finally { resetModules(); }
});
