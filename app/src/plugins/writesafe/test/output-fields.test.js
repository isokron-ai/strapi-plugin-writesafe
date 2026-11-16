'use strict';
// Per-document read fields, with Strapi's own content-manager permission checker and CASL abilities. Strapi's
// sanitizeOutput allows every field whenever any read rule has no field list, whatever that rule's conditions: with
// "title on every page" plus "every field on own pages" it returned other users' secretCode. compat/content-manager.js
// keeps only the fields the token may read on THAT document.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const APP_NM = path.resolve(__dirname, '../../../../node_modules');
const { createMongoAbility } = require(path.join(APP_NM, '@casl/ability'));
const PM = require(path.join(APP_NM, '@strapi/admin/dist/server/server/src/services/permission/permissions-manager/index.js'));
const CMPC = require(path.join(APP_NM, '@strapi/content-manager/dist/server/services/permission-checker.js'));
const M = require('../server/model');
const E = require('../server/engine');

const PAGE = 'api::page.page';
const R = 'plugin::content-manager.explorer.read';
const U = 'plugin::content-manager.explorer.update';
const ME = 7;
const own = { 'createdBy.id': ME };
const HIDDEN = 'HID-91';
const doc = (id, documentId, by, over = {}) => ({
  id, documentId, locale: null, title: `T ${documentId}`, note: `note ${documentId}`, secretCode: documentId === 'theirs' ? HIDDEN : 'K-mine',
  seo: { id: 10 + id, metaTitle: `m ${documentId}`, metaSecret: documentId === 'theirs' ? HIDDEN : 's-mine' },
  createdBy: { id: by }, updatedBy: { id: by }, publishedAt: null, updatedAt: '2026-11-16T10:00:00.000Z', createdAt: '2026-11-16T10:00:00.000Z', ...over,
});

// title (and seo.metaTitle) on every page; every field, no field list, on own pages
const TWO_ROLE = [
  { action: U, subject: PAGE },
  { action: R, subject: PAGE, fields: ['title', 'seo.metaTitle'] },
  { action: R, subject: PAGE, conditions: own },
];

function realStrapi() {
  const schema = {
    uid: PAGE, kind: 'collectionType', modelType: 'contentType', options: { draftAndPublish: false }, info: { singularName: 'page' },
    attributes: {
      title: { type: 'string' }, note: { type: 'text' }, secretCode: { type: 'string' },
      seo: { type: 'component', component: 'shared.seo' },
      createdBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
      updatedBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
    },
  };
  const seo = { uid: 'shared.seo', modelType: 'component', attributes: { metaTitle: { type: 'string' }, metaSecret: { type: 'string' } } };
  const state = { docs: { mine: doc(1, 'mine', ME), theirs: doc(2, 'theirs', 8) }, created: [], users: new Set([ME, 8]) };
  const strapi = {
    contentTypes: { [PAGE]: schema }, components: { 'shared.seo': seo },
    getModel: (u) => ({ [PAGE]: schema, 'shared.seo': seo })[u] || { uid: u, attributes: { id: {} } },
    config: { get: () => undefined },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    db: {
      config: { connection: { client: 'sqlite' } },
      transaction: async (cb) => cb({}),
      queryBuilder: () => {
        let where = {};
        const ch = { select: () => ch, where: (w) => { where = w || {}; return ch; }, orderBy: () => ch, forUpdate: () => ch,
          execute: async () => Object.values(state.docs).filter((d) => !where.documentId || d.documentId === where.documentId).map((d) => ({ id: d.id, documentId: d.documentId, locale: null, updatedAt: d.updatedAt })) };
        return ch;
      },
      query: (u) => ({ findOne: async (q) => (u === 'admin::user' && state.users.has(q && q.where && q.where.id) ? { id: q.where.id } : null), findMany: async () => [], count: async () => 0 }),
    },
    documents: () => ({
      findOne: async (p) => (state.docs[p.documentId] ? { ...state.docs[p.documentId] } : null),
      findMany: async () => Object.values(state.docs).map((d) => ({ ...d })),
      count: async () => Object.keys(state.docs).length,
      update: async (p) => { const { updatedBy, ...data } = p.data || {}; state.docs[p.documentId] = { ...state.docs[p.documentId], ...data, updatedAt: '2026-11-16T10:00:09.000Z' }; return { ...state.docs[p.documentId] }; },
      delete: async (p) => { delete state.docs[p.documentId]; return { documentId: p.documentId }; },
      create: async (p) => {
        const { createdBy, updatedBy, documentId, ...data } = p.data || {};
        state.created.push(p.data);
        state.docs[documentId] = { id: 50, documentId, locale: null, ...data, createdBy: { id: createdBy }, updatedBy: { id: updatedBy }, updatedAt: '2026-11-16T11:00:00.000Z', createdAt: '2026-11-16T11:00:00.000Z' };
        return { ...state.docs[documentId] };
      },
    }),
  };
  strapi.service = (n) => (n === 'admin::permission' ? { createPermissionsManager: PM, actionProvider: { unstable_aliases: () => [] } } : undefined);
  const checker = CMPC.default({ strapi });
  strapi.plugin = (n) => (n === 'content-manager' ? { service: () => checker } : undefined);
  global.strapi = strapi;
  return { strapi, state };
}
const ctxFor = (rules) => ({ userAbility: createMongoAbility(rules), user: { id: ME } });
const quiet = () => require('../server/modules').load(null, { modules: { history: false } });
const noHidden = (x) => assert.ok(!JSON.stringify(x).includes(HIDDEN), `no field of another user's page that the token may not read there: ${JSON.stringify(x)}`);

test('ws_get on another user\'s page: title and seo.metaTitle, not secretCode, note or seo.metaSecret; own page: every field', async () => {
  quiet();
  const { strapi } = realStrapi();
  const g = await E.getDoc(strapi, ctxFor(TWO_ROLE), { uid: PAGE, documentId: 'theirs' });
  assert.strictEqual(g.data.title, 'T theirs');
  assert.strictEqual(g.data.seo.metaTitle, 'm theirs');
  assert.ok(!('secretCode' in g.data) && !('note' in g.data) && !('metaSecret' in (g.data.seo || {})));
  noHidden(g);
  const mine = await E.getDoc(strapi, ctxFor(TWO_ROLE), { uid: PAGE, documentId: 'mine' });
  assert.strictEqual(mine.data.secretCode, 'K-mine', 'own page: the field list-free rule applies');
  assert.strictEqual(mine.data.seo.metaSecret, 's-mine');
});

test('ws_find: rows and `fields` of another user\'s page carry only what the token may read on it', async () => {
  quiet();
  const { strapi } = realStrapi();
  const tools = require('../server/tools');
  const FIND = require('../server/modules/find');
  const def = FIND.tools(strapi, tools.apiFor(strapi)).find((d) => d.name === 'ws_find');
  const r = await def.createHandler(strapi, ctxFor(TWO_ROLE))({ args: { uid: PAGE, fields: ['title', 'secretCode'] } });
  assert.ok(!r.isError, JSON.stringify(r.structuredContent));
  const rows = r.structuredContent.matches;
  const theirs = rows.find((m) => m.documentId === 'theirs');
  const mine = rows.find((m) => m.documentId === 'mine');
  assert.strictEqual(theirs.data.title, 'T theirs');
  assert.ok(!('secretCode' in theirs.data));
  assert.strictEqual(mine.data.secretCode, 'K-mine');
  noHidden(r);
});

test('ws_patch return "full" on another user\'s page: the document without the fields the token may not read there', async () => {
  quiet();
  const { strapi, state } = realStrapi();
  const v = M.versionOf(strapi, PAGE, state.docs.theirs);
  const r = await E.applyPatch(strapi, ctxFor(TWO_ROLE), { uid: PAGE, documentId: 'theirs', set: { title: 'new' }, expected_version: v, return: 'full' });
  assert.strictEqual(r.document.title, 'new');
  assert.ok(!('secretCode' in r.document));
  noHidden(r);
});

test('version_conflict current on another user\'s page: no field the token may not read there', async () => {
  quiet();
  const { strapi } = realStrapi();
  const stale = M.versionOf(strapi, PAGE, doc(2, 'theirs', 8, { title: 'old' }));
  let e = null;
  try { await E.applyPatch(strapi, ctxFor(TWO_ROLE), { uid: PAGE, documentId: 'theirs', set: { title: 'x' }, expected_version: stale }); } catch (x) { e = x.payload; }
  assert.strictEqual(e.code, 'version_conflict');
  assert.strictEqual(e.current.title, 'T theirs');
  assert.ok(!('secretCode' in e.current));
  noHidden(e);
});

test('readableOnly: keeps what the rules allow per document and removes nothing for a token with a condition-free rule', async () => {
  const { strapi, state } = realStrapi();
  const CM = require('../server/compat/content-manager');
  const all = CM.permissionChecker(strapi, ctxFor([{ action: R, subject: PAGE }]), PAGE);
  const out = await all.sanitizeOutput({ ...state.docs.theirs });
  assert.strictEqual(out.secretCode, HIDDEN, 'a reader of every field keeps them');
  assert.strictEqual(out.seo.metaSecret, HIDDEN);
  const two = CM.permissionChecker(strapi, ctxFor(TWO_ROLE), PAGE);
  const server = await two.sanitizeOutputServerSide({ ...state.docs.theirs });
  assert.strictEqual(server.secretCode, HIDDEN, 'Strapi\'s own sanitizer, for server-side history images only, is unchanged');
});

// ---------------------------------------------------------------- review of #49: delete, then undo
test('delete + undo: the two-role token cannot bring back another user\'s page with its hidden fields as its own; a reader can, under the original creator', async () => {
  quiet();
  const MODS = require('../server/modules');
  const C = require('../server/modules/history/capture');
  const U = require('../server/modules/history/undo');
  const D = require('../server/modules/delete');
  const saved = { has: MODS.hasAfterWrite, after: MODS.afterWrite, before: MODS.beforeWrite };
  const entries = [];
  try {
    MODS.hasAfterWrite = () => true;
    MODS.beforeWrite = async () => {};
    MODS.afterWrite = async (c, info, before, after) => {
      const raw = info.raw || {};
      const full = (k, v) => (k in raw ? raw[k] : v);
      entries.push(C.entryOf(info, full('before', before), full('after', after), { before, after }));
      return undefined;
    };
    const { strapi, state } = realStrapi();
    C.configure(strapi, {});
    const WITH_DELETE = [...TWO_ROLE, { action: 'plugin::content-manager.explorer.delete', subject: PAGE }, { action: 'plugin::content-manager.explorer.create', subject: PAGE }];
    const v = M.versionOf(strapi, PAGE, state.docs.theirs);
    const r = await D.applyDelete(strapi, ctxFor(WITH_DELETE), { uid: PAGE, documentId: 'theirs', expected_version: v });
    noHidden(r);
    const e = { ...entries.find((x) => x.op === 'delete'), rid: 1, i: 0 };
    assert.deepStrictEqual(e.cr, { cb: 8, ub: 8 }, 'the original creator and editor are kept with the image');
    // the same token undoes: refused, naming nothing; nothing created
    let err = null;
    try { await U.revertOne(strapi, ctxFor(WITH_DELETE), E, e, { raw: null, args: {} }); } catch (x) { err = x.payload; }
    assert.ok(err && err.code === 'forbidden', JSON.stringify(err));
    noHidden(err);
    assert.strictEqual(state.created.length, 0);
    // a reader of every field undoes: the content comes back, and the page stays the original creator's
    const READER = [{ action: R, subject: PAGE }, { action: 'plugin::content-manager.explorer.create', subject: PAGE }, { action: U, subject: PAGE }];
    const out = await U.revertOne(strapi, ctxFor(READER), E, e, { raw: null, args: {} });
    assert.strictEqual(out.value.op, 'recreated');
    assert.strictEqual(state.created[0].secretCode, HIDDEN);
    assert.strictEqual(state.created[0].createdBy, 8, 'createdBy restored, not the undoer');
    assert.strictEqual(state.created[0].updatedBy, ME, 'updatedBy is the undoer, so the admin shows who restored the page');
    // and the two-role token still cannot read the hidden field of the restored page
    const g = await E.getDoc(strapi, ctxFor(TWO_ROLE), { uid: PAGE, documentId: 'theirs' });
    noHidden(g);
  } finally {
    MODS.hasAfterWrite = saved.has; MODS.afterWrite = saved.after; MODS.beforeWrite = saved.before;
    require('../server/modules').load(null, { modules: {} });
  }
});

test('readableOnly: arrays filtered per element; an unreadable component left out whatever its value; related documents cut to their identity', async () => {
  const { strapi, state } = realStrapi();
  const CM = require('../server/compat/content-manager');
  const NO_SEO = [{ action: R, subject: PAGE, fields: ['title'] }, { action: R, subject: PAGE, conditions: own }];
  const pc = CM.permissionChecker(strapi, ctxFor(NO_SEO), PAGE);
  const list = await pc.sanitizeOutput([{ ...state.docs.theirs }, { ...state.docs.mine }]);
  assert.ok(!('secretCode' in list[0]) && list[1].secretCode === 'K-mine', 'each element on its own document');
  const empty = await pc.sanitizeOutput({ ...state.docs.theirs, seo: null });
  const filled = await pc.sanitizeOutput({ ...state.docs.theirs });
  assert.ok(!('seo' in empty) && !('seo' in filled), 'empty and filled look the same');
  const ALL = CM.permissionChecker(strapi, ctxFor([{ action: R, subject: PAGE }]), PAGE);
  const withRef = await ALL.sanitizeOutput({ ...state.docs.theirs, createdBy: { id: 8, firstname: 'Bo', email: 'bo@example.test' } });
  assert.ok(!withRef.createdBy || !('email' in withRef.createdBy), 'a related document carries its identity only');
});

// ---------------------------------------------------------------- follow-up to #49
const withCapture = async (fn) => {
  const MODS = require('../server/modules');
  const C = require('../server/modules/history/capture');
  const saved = { has: MODS.hasAfterWrite, after: MODS.afterWrite, before: MODS.beforeWrite };
  const entries = [];
  MODS.hasAfterWrite = () => true;
  MODS.beforeWrite = async () => {};
  MODS.afterWrite = async (c, info, before, after) => {
    const raw = info.raw || {};
    const full = (k, v) => (k in raw ? raw[k] : v);
    entries.push(C.entryOf(info, full('before', before), full('after', after), { before, after }));
    return undefined;
  };
  try { return await fn(entries); } finally { MODS.hasAfterWrite = saved.has; MODS.afterWrite = saved.after; MODS.beforeWrite = saved.before; require('../server/modules').load(null, { modules: {} }); }
};
const WITH_DELETE = [...TWO_ROLE, { action: 'plugin::content-manager.explorer.delete', subject: PAGE }, { action: 'plugin::content-manager.explorer.create', subject: PAGE }];
const READER = [{ action: R, subject: PAGE }, { action: 'plugin::content-manager.explorer.create', subject: PAGE }, { action: U, subject: PAGE }, { action: 'plugin::content-manager.explorer.delete', subject: PAGE }];

test('undo of a delete whose original creator no longer exists: createdBy none (not the undoer), and own-entries rules fail closed', async () => {
  quiet();
  await withCapture(async (entries) => {
    const { strapi, state } = realStrapi();
    require('../server/modules/history/capture').configure(strapi, {});
    const D = require('../server/modules/delete');
    const U2 = require('../server/modules/history/undo');
    // a page of user 7 (ME) that the two-role token could undo while 7 exists
    await D.applyDelete(strapi, ctxFor(WITH_DELETE), { uid: PAGE, documentId: 'mine', expected_version: M.versionOf(strapi, PAGE, state.docs.mine) });
    const e = { ...entries.find((x) => x.op === 'delete'), rid: 1, i: 0 };
    state.users.delete(ME); // the creator's admin account is removed
    let err = null;
    try { await U2.revertOne(strapi, ctxFor(WITH_DELETE), E, e, { raw: null, args: {} }); } catch (x) { err = x.payload; }
    assert.ok(err && err.code === 'forbidden', 'own-entries rule: no creator to match, refused');
    const out = await U2.revertOne(strapi, ctxFor(READER), E, e, { raw: null, args: {} });
    assert.strictEqual(out.value.op, 'recreated');
    assert.strictEqual(state.created[0].createdBy, null, 'no creator, rather than the undoer');
  });
});

test('ws_undo job dry run shows a refused delete as forbidden, not as a recreate', async () => {
  quiet();
  await withCapture(async (entries) => {
    const { strapi, state } = realStrapi();
    require('../server/modules/history/capture').configure(strapi, {});
    const D = require('../server/modules/delete');
    const UJ = require('../server/modules/history/undo-job');
    await D.applyDelete(strapi, ctxFor(WITH_DELETE), { uid: PAGE, documentId: 'theirs', expected_version: M.versionOf(strapi, PAGE, state.docs.theirs) });
    const e = { ...entries.find((x) => x.op === 'delete'), rid: 1, i: 0 };
    assert.strictEqual((await UJ.classify(strapi, ctxFor(WITH_DELETE), E, e)).would, 'forbidden');
    assert.strictEqual((await UJ.classify(strapi, ctxFor(READER), E, e)).would, 'recreate');
  });
});

test('undo of a create (a delete) keeps the creator with its history entry, so undoing that undo works for an own-entries token', async () => {
  quiet();
  await withCapture(async (entries) => {
    const { strapi, state } = realStrapi();
    require('../server/modules/history/capture').configure(strapi, {});
    const W = require('../server/modules/_lib/write');
    const U2 = require('../server/modules/history/undo');
    await W.deleteLocale(strapi, ctxFor(WITH_DELETE), E, { tool: 'ws_undo', uid: PAGE, documentId: 'mine', raw: { ...state.docs.mine }, args: {}, dryRun: false, creators: { createdBy: ME, updatedBy: ME } });
    const e = { ...entries.find((x) => x.op === 'delete'), rid: 2, i: 0 };
    assert.deepStrictEqual(e.cr, { cb: ME, ub: ME });
    const out = await U2.revertOne(strapi, ctxFor(WITH_DELETE), E, e, { raw: null, args: {} });
    assert.strictEqual(out.value.op, 'recreated', 'the own-entries token may bring its own page back');
    assert.strictEqual(state.created[0].createdBy, ME);
  });
});

test('readableOnly keeps document metadata (locale, timestamps) even where a field list does not name them', async () => {
  const { strapi, state } = realStrapi();
  strapi.contentTypes[PAGE].attributes.locale = { type: 'string', configurable: false, visible: false }; // as i18n declares it
  const CM = require('../server/compat/content-manager');
  const pc = CM.permissionChecker(strapi, ctxFor([{ action: R, subject: PAGE, fields: ['title'] }]), PAGE);
  const out = await pc.sanitizeOutput({ ...state.docs.theirs, locale: 'fr' });
  assert.strictEqual(out.locale, 'fr', 'locale stays: row keys are scoped by it');
  assert.strictEqual(out.documentId, 'theirs');
  assert.strictEqual(out.updatedAt, state.docs.theirs.updatedAt);
  assert.ok(!('secretCode' in out));
});
