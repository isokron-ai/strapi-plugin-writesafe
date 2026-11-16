'use strict';

/**
 * Stale admin form guard: the rebase of a Content Manager Save against the write journal (bench task X4; config
 * `staleFormGuard`, default on; needs `documentServiceLock`).
 *
 * The problem: the Content Manager's Save sends the whole form, and nothing says when it was loaded. A writesafe write
 * that committed between the load and the Save was written over with the form's old values, behind a 200.
 *
 * State, all in the database (two tables of the plugin, created at bootstrap: the migration, ensureTables):
 *   REV      one row per document (not per locale: i18n copies non-localized fields to the other locales with
 *            strapi.db.query, past the Document Service): the revision counter `rev`, and `pruned_rev`, the newest
 *            revision whose journal entries retention removed. It is the document's lock row: in a write, every read of
 *            it and of the journal is a locking read (MySQL's REPEATABLE READ snapshot can predate the lock).
 *   JOURNAL  per agent write, per leaf path (rebase.js): revision, locale ('' without i18n, '*' for a non-localized
 *            field), path, before, after; written in the agent's own transaction, before its commit, so a rollback (a
 *            dry run, a failed write) takes it back. Discard and writers outside the plugin (REST, GraphQL, other
 *            plugins, the Content Manager's other routes) leave one `opaque` entry: what they changed is not known.
 *
 * The version out: a route middleware on the Content Manager's draft findOne (collection and single types) reads `rev`
 * BEFORE the document is read and answers it in `X-Writesafe-Version` (a write landing in between makes the form look
 * older: a merge or a 409, never a loss). Saves answer the revision they were merged at the same way.
 * The version back: the plugin's admin code (admin/form-base.mjs) wraps window.fetch, keeps the version per tab and
 * document/locale, and sends it as `X-Writesafe-Base` on Save, publish and discard.
 *
 * The merge point: the Document Service middleware (document-lock.js, registered first in register(), so it wraps the
 * i18n and History middlewares, and also sees the publish route's own updateDocument()). Under the document's lock it
 * recognises a Content Manager request through strapi.requestContext and:
 *   - no journal entry since the base: the Save goes through unchanged (editors alone behave exactly as before);
 *   - entries: rebase.js merges the form onto the current draft (the agent's changes the editor did not touch stay) or
 *     refuses with 409 naming the field and both values;
 *   - fails closed with 409: no base header while the document has journal entries; a base older than retention kept;
 *     an opaque entry since the base; a publish or discard with any entry since the base (never publish or throw away
 *     agent content the editor has not seen).
 */
const crypto = require('crypto');
const R = require('../rebase');

const REV = 'writesafe_doc_rev';
const JOURNAL = 'writesafe_journal';
// D1: the content revision of each (document, locale) draft, which the version token binds (model.js REVISION)
const CREV = 'writesafe_content_rev';
const SCHEMA_VERSION = 1;
// Journal entries older than this are pruned (retention.js; retention.journalHours). 72 h, as idempotency keys: an edit
// form left open longer than that gets 409 base_too_old instead of a merge (pruned_rev remembers the pruned revisions).
const RETENTION_HOURS = 72;
const H_VERSION = 'X-Writesafe-Version';
const H_MERGED = 'X-Writesafe-Merged';
const H_BASE = 'x-writesafe-base';
// enabled: the guard (merge or 409); tracking: the content revisions (CREV), kept on every Document Service write
// whenever the Document Service lock is installed (the version token binds them: model.js REVISION), guard or not
const state = { enabled: false, otherWriters: false, tracking: false, ok: false, created: false, reason: null };
const stats = { versionsServed: 0, agentWrites: 0, journalEntries: 0, opaque: 0, checked: 0, passedNoEntries: 0, merged: 0, refused: 0, refusedBy: {}, pruned: 0 };
/** Test hook (the probe plugin's x4-gate): awaited inside an agent's transaction after its write, before the commit. */
const hooks = { beforeAgentCommit: null };

/** Keyed hash of a secret field's value (private, password): keyed with the app's version key (APP_KEYS). */
const secretHash = (s) => require('../model').mac(`stale-form-secret\n${s}`);
const docKey = (uid, documentId) => crypto.createHash('sha256').update(`${uid}|${documentId}`).digest('hex');
const num = (v) => (v == null ? 0 : Number(v));
const schema = (strapi) => (typeof strapi.db.getSchemaConnection === 'function' ? strapi.db.getSchemaConnection() : strapi.db.connection.schema);
const client = (strapi) => String(strapi.db?.config?.connection?.client || strapi.db?.dialect?.client || '');
const isSqlite = (strapi) => /sqlite/i.test(client(strapi));
/** The database schema (Postgres connection.schema): the tables are created there (getSchemaConnection), so every query
 * on them names it too, as strapi.db.getConnection(table) does; without it they resolve through search_path. */
const schemaName = (strapi) => { try { return typeof strapi.db.getSchemaName === 'function' ? strapi.db.getSchemaName() || null : null; } catch { return null; } };
/** A query on one of the guard's tables, on q (knex or the running transaction), in the database's schema. */
const tb = (strapi, q, name) => { const s = schemaName(strapi); const b = q(name); return s ? b.withSchema(s) : b; };

/** The migration: both tables, created when missing (safe across replicas). Never throws: the guard is off then. */
async function ensureTables(strapi) {
  const make = async (name, fn) => {
    if (await schema(strapi).hasTable(name)) return;
    try { await schema(strapi).createTable(name, fn); state.created = true; } catch (e) { if (!(await schema(strapi).hasTable(name))) throw e; }
  };
  try {
    await make(REV, (t) => {
      t.string('k', 64).primary();
      t.string('uid', 255).notNullable();
      t.string('document_id', 64).notNullable();
      t.bigInteger('rev').notNullable().defaultTo(0);
      t.bigInteger('pruned_rev').notNullable().defaultTo(0);
      t.bigInteger('jrev').notNullable().defaultTo(0); // the newest revision that has journal entries
      t.integer('schema_version').notNullable().defaultTo(SCHEMA_VERSION);
      t.bigInteger('at_ms').notNullable().defaultTo(0);
    });
    await make(JOURNAL, (t) => {
      t.increments('id').primary();
      t.string('k', 64).notNullable();
      t.bigInteger('rev').notNullable();
      t.string('locale', 32).notNullable().defaultTo('');
      t.string('path', 512).notNullable();
      t.string('kind', 8).notNullable();
      t.string('label', 255);
      t.text('before', 'longtext');
      t.text('after', 'longtext');
      t.string('writer', 16);
      t.bigInteger('at_ms').notNullable();
      t.index(['k', 'rev'], `${JOURNAL}_k_rev_ix`);
      t.index(['at_ms'], `${JOURNAL}_at_ix`);
    });
    await make(CREV, (t) => {
      t.string('k', 64).primary();
      t.string('uid', 255).notNullable();
      t.string('document_id', 64).notNullable();
      t.string('locale', 32).notNullable().defaultTo('');
      t.bigInteger('rev').notNullable().defaultTo(0);
      t.string('fp', 64); // the draft's content fingerprint after the last counted write (keyed, no content)
      t.bigInteger('at_ms').notNullable().defaultTo(0);
      t.index(['uid', 'document_id'], `${CREV}_doc_ix`);
    });
    Object.assign(state, { ok: true, reason: null });
  } catch (e) {
    Object.assign(state, { ok: false, reason: e.message });
    strapi.log.error(`[writesafe] stale form guard and content revisions off: their tables are unavailable (${e.message}). Admin Saves are not merged or `
      + 'refused (Strapi\'s last-write-wins), and version tokens carry no content revision (an A -> B -> A change gives an old token back).');
  }
  // shown with the compat table (ws_status, scripts/compat_check.mjs fails on it): the guard off by an error, not by config
  try { require('./index').note('admin.stale_form_guard', state.ok, state.ok ? `tables ${REV}, ${JOURNAL}, ${CREV} present${schemaName(strapi) ? ` (schema ${schemaName(strapi)})` : ''}` : `tables unavailable: ${state.reason}`); } catch { /* the log line above */ }
  return state.ok;
}

const active = () => state.enabled && state.ok;
const tracking = () => state.tracking && state.ok;
const REVISION = Symbol.for('writesafe.revision'); // model.js REVISION
/** Attach the revision to Document Service results (objects with a documentId), in place. */
function attach(res, rev) {
  for (const d of Array.isArray(res) ? res : [res]) if (d && typeof d === 'object' && typeof d.documentId === 'string') d[REVISION] = rev;
  if (res && Array.isArray(res.entries)) for (const d of res.entries) if (d && typeof d === 'object') d[REVISION] = rev;
  return res;
}

// ---------------------------------------------------------------- model helpers
const isLocalized = (strapi, uid) => Boolean(strapi.contentTypes[uid]?.pluginOptions?.i18n?.localized);
const attrsOf = (strapi) => (u) => (strapi.contentTypes[u] || strapi.components[u] || {}).attributes;
let defLocale = { v: null, at: 0 };
async function defaultLocale(strapi) {
  if (defLocale.v && Date.now() - defLocale.at < 10000) return defLocale.v;
  try { defLocale = { v: (await strapi.plugin('i18n').service('locales').getDefaultLocale()) || 'en', at: Date.now() }; } catch { defLocale = { v: defLocale.v || 'en', at: Date.now() }; }
  return defLocale.v;
}
async function localeOf(strapi, uid, locale) {
  if (!isLocalized(strapi, uid)) return '';
  return locale && locale !== '*' ? String(locale) : defaultLocale(strapi);
}
/** The draft with every component, media and relation populated (the shape the journal and the rebase compare). */
async function readDraft(strapi, uid, documentId, locale) {
  const M = require('../model');
  const dp = Boolean(strapi.contentTypes[uid]?.options?.draftAndPublish);
  return strapi.documents(uid).findOne({ documentId, ...(locale ? { locale } : {}), ...(dp ? { status: 'draft' } : {}), populate: M.populateFor(strapi, uid) });
}

// ---------------------------------------------------------------- the lock row and the journal
/**
 * The document's REV row with a locking read (Postgres, MySQL), created when `create` and missing. The row is
 * inserted FIRST (insert-ignore) and only then read FOR UPDATE: a locking read of a missing row takes a gap lock on
 * MySQL, and two writers of two fresh documents whose keys share a gap then deadlocked each other on their inserts
 * (review S1). A plain existence check first keeps the insert (and its duplicate-key lock) off the common path.
 */
async function lockRev(strapi, trx, uid, documentId, create) {
  const k = docKey(uid, documentId);
  const sql = !isSqlite(strapi);
  const sel = () => { let q = tb(strapi, trx, REV).select(['k', 'rev', 'pruned_rev', 'jrev']).where({ k }); if (sql) q = q.forUpdate(); return q.first(); };
  if (create) {
    const seen = await tb(strapi, trx, REV).select(['k']).where({ k }).first();
    if (!seen) await tb(strapi, trx, REV).insert({ k, uid, document_id: documentId, rev: 0, pruned_rev: 0, jrev: 0, at_ms: Date.now() }).onConflict('k').ignore();
  }
  // The decision is taken from this locking read, never from the plain read above (MySQL: the publish controller's
  // transaction may hold a snapshot older than the agent's commit; a locking read sees the latest row, review B2).
  // Every caller passes `create`, so the row exists here: a record lock, never a gap lock. Without `create` (other
  // code), a missing row answers `missing`.
  const row = await sel();
  return row ? { k, rev: num(row.rev), pruned: num(row.pruned_rev), jrev: num(row.jrev) } : { k, rev: 0, pruned: 0, jrev: 0, missing: true };
}

/**
 * The document's revision counter, for other code (the version token: see INDEX of the X4 series, D1). 0 when no
 * tracked writer ever wrote the document. q: a knex instance or the running transaction; lock: a locking read (use it
 * inside a write, under the document's lock). It grows on every agent write that changed something, on every opaque
 * write (discard, writers outside the plugin), and never on a Content Manager Save (editor saves are not journaled).
 */
async function revision(strapi, uid, documentId, q = null, { lock = false } = {}) {
  const conn = q || strapi.db.connection;
  let sel = tb(strapi, conn, REV).select(['rev']).where({ k: docKey(uid, documentId) });
  if (lock && !isSqlite(strapi)) sel = sel.forUpdate();
  const row = await sel.first();
  return num(row && row.rev);
}

/** Journal entries after `base`, oldest first, for these locales (locking read). */
async function entriesAfter(strapi, trx, k, base, locales) {
  let q = tb(strapi, trx, JOURNAL).select(['id', 'rev', 'locale', 'path', 'kind', 'label', 'before', 'after']).where({ k }).andWhere('rev', '>', base).orderBy([{ column: 'rev' }, { column: 'id' }]);
  if (!isSqlite(strapi)) q = q.forShare();
  const rows = await q;
  const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
  return rows.filter((r) => !locales || locales.includes(r.locale)).map((r) => ({ rev: num(r.rev), locale: r.locale, path: r.path, kind: r.kind, label: r.label, before: parse(r.before), after: parse(r.after) }));
}
async function append(strapi, trx, lock, entries, writer) {
  const rev = lock.rev + 1;
  const now = Date.now();
  const rows = entries.map((e) => ({ k: lock.k, rev, locale: e.locale, path: String(e.path).slice(0, 512), kind: e.kind, label: e.label ? String(e.label).slice(0, 255) : null,
    before: e.before === undefined ? null : JSON.stringify(e.before), after: e.after === undefined ? null : JSON.stringify(e.after), writer, at_ms: now }));
  for (let i = 0; i < rows.length; i += 100) await tb(strapi, trx, JOURNAL).insert(rows.slice(i, i + 100));
  await tb(strapi, trx, REV).where({ k: lock.k }).update({ rev, ...(rows.length ? { jrev: rev } : {}), at_ms: now });
  stats.journalEntries += rows.length;
  return rev;
}

// ---------------------------------------------------------------- the content revision (D1)
const crevKey = (uid, documentId, locale) => crypto.createHash('sha256').update(`c|${uid}|${documentId}|${locale || ''}`).digest('hex');
/** The draft's content fingerprint: its version token with revision 0 (keyed with the app's keys; no content). */
const fingerprint = (strapi, uid, doc) => (doc ? require('../model').versionOf(strapi, uid, { ...doc, [REVISION]: 0 }) : 'none');

/**
 * Around one Document Service update or discard of a draft (inside its transaction, under the document's lock): the
 * locale's content revision moves by one when the draft's content changed. Content, not the write: a write that
 * leaves the same content (rows re-created with new ids, an updatedAt-only sync) keeps the token (1.0 hardening
 * item 15), and A -> B -> A moves it twice, so an old token never comes back (self-test D1). The row is inserted
 * before it is locked (no MySQL gap locks). before: the draft before the write when the caller read it already.
 */
async function contentRevision(strapi, trx, uid, documentId, locale, beforeDoc, afterDoc) {
  const k = crevKey(uid, documentId, locale);
  const seen = await tb(strapi, trx, CREV).select(['k']).where({ k }).first();
  if (!seen) await tb(strapi, trx, CREV).insert({ k, uid, document_id: documentId, locale: locale || '', rev: 0, fp: null, at_ms: Date.now() }).onConflict('k').ignore();
  let q = tb(strapi, trx, CREV).select(['rev', 'fp']).where({ k });
  if (!isSqlite(strapi)) q = q.forUpdate();
  const row = await q.first();
  const prevFp = row && row.fp ? row.fp : fingerprint(strapi, uid, beforeDoc);
  const fp = fingerprint(strapi, uid, afterDoc);
  let rev = num(row && row.rev);
  if (fp !== prevFp) rev += 1;
  await tb(strapi, trx, CREV).where({ k }).update({ rev, fp, at_ms: Date.now() });
  return rev;
}
/**
 * The locales a delete removes (read before it): the one asked for, or with locale '*' every locale the document has,
 * plus every locale that already has a content revision row. The document's rows are read with a locking read (the
 * delete locks them next anyway): a plain read could use a MySQL snapshot older than a locale created just before.
 * An error fails the delete (it runs in the write's transaction), never a delete whose revisions did not move.
 */
async function deletedLocales(strapi, trx, uid, documentId, locale) {
  if (locale !== '*') return [locale || ''];
  if (!isLocalized(strapi, uid)) return [''];
  const out = new Set();
  const meta = strapi.db.metadata && typeof strapi.db.metadata.get === 'function' ? strapi.db.metadata.get(uid) : null;
  if (meta && meta.tableName) {
    let q = tb(strapi, trx, meta.tableName).select(['locale']).where({ document_id: documentId });
    if (!isSqlite(strapi)) q = q.forShare();
    for (const r of await q) if (r && r.locale) out.add(String(r.locale));
  } else {
    const rows = await strapi.db.query(uid).findMany({ where: { documentId }, select: ['locale'] });
    for (const r of rows || []) if (r && r.locale) out.add(String(r.locale));
  }
  for (const r of await tb(strapi, trx, CREV).select(['locale']).where({ uid, document_id: documentId })) if (r.locale) out.add(String(r.locale));
  return [...out];
}
/**
 * A delete of a locale (or of every locale): their content revisions move, so a draft re-created under the same
 * documentId (ws_undo of a delete, a create with the old documentId) never gets an old token back (review of D1: a
 * document never updated had no row, and the delete moved nothing). Each row is upserted by its primary key: inserted
 * when missing (insert-ignore after a plain existence check, as contentRevision), then moved by one: record locks
 * only, never a locking read or an update through the secondary index (MySQL gap locks).
 */
async function contentRevisionDeleted(strapi, trx, uid, documentId, locales) {
  for (const locale of locales) {
    const k = crevKey(uid, documentId, locale);
    const seen = await tb(strapi, trx, CREV).select(['k']).where({ k }).first();
    if (!seen) await tb(strapi, trx, CREV).insert({ k, uid, document_id: documentId, locale: locale || '', rev: 0, fp: null, at_ms: Date.now() }).onConflict('k').ignore();
    await tb(strapi, trx, CREV).where({ k }).update({ rev: trx.raw('?? + 1', ['rev']), fp: 'deleted', at_ms: Date.now() });
  }
}

// ---------------------------------------------------------------- requests
const CM_COLL = /^\/content-manager\/collection-types\/([^/]+)\/([^/]+?)(?:\/actions\/([^/]+))?\/?$/;
const CM_SINGLE = /^\/content-manager\/single-types\/([^/]+?)(?:\/actions\/([^/]+))?\/?$/;
const SAVES = { PUT: new Set([null]), POST: new Set(['publish', 'discard', 'unpublish']) };
const userOf = (koa) => { const u = koa && koa.state && koa.state.user; return u && u.id != null ? String(u.id) : null; };

/** { uid, documentId|null, action|null } of a Content Manager document route, or null. */
function cmRoute(strapi, path) {
  const p = String(path || '');
  let m = CM_COLL.exec(p);
  if (m) {
    const uid = decodeURIComponent(m[1]);
    if (strapi.contentTypes[uid]?.kind !== 'collectionType' || m[2] === 'actions') return null;
    return { uid, documentId: decodeURIComponent(m[2]), action: m[3] || null };
  }
  m = CM_SINGLE.exec(p);
  if (m) { const uid = decodeURIComponent(m[1]); if (strapi.contentTypes[uid]?.kind === 'singleType') return { uid, documentId: null, action: m[2] || null }; }
  return null;
}
const koaOf = (strapi) => (strapi.requestContext && typeof strapi.requestContext.get === 'function' ? strapi.requestContext.get() : null);

/** The Content Manager form Save (or publish, discard) the running Document Service call belongs to, or null. */
function formRequest(strapi, dsCtx, uid, documentId) {
  const koa = koaOf(strapi);
  const allowed = koa && SAVES[koa.method];
  const route = allowed && cmRoute(strapi, koa.path);
  if (!route || !allowed.has(route.action) || route.uid !== uid) return null;
  if (route.documentId && route.documentId !== documentId) return null;
  if (dsCtx.action === 'update' && !(koa.method === 'PUT' || route.action === 'publish')) return null;
  if (dsCtx.action === 'discardDraft' && !(route.action === 'discard' || route.action === 'unpublish')) return null;
  if (dsCtx.action !== 'update' && dsCtx.action !== 'discardDraft') return null;
  if (!userOf(koa)) return null;
  return { koa, route, publish: route.action === 'publish' };
}

/** An error strapi::errors answers with 409: an http-errors HttpError by prototype (the plugin has no dependencies). */
function conflictError(message, details) {
  const e = new Error(message);
  try { const { errors } = require('@strapi/utils'); if (errors && errors.HttpError) Object.setPrototypeOf(e, errors.HttpError.prototype); } catch { /* exposed 409 still maps */ }
  Object.assign(e, { name: 'ConflictError', status: 409, statusCode: 409, expose: true, details: { code: 'stale_form', ...details } });
  return e;
}
const RELOAD = 'Nothing was saved. Copy anything you want to keep, reload the page to see the current version, then make your edit again.';
function refuse(strapi, reason, message, details) {
  stats.refused += 1;
  stats.refusedBy[reason] = (stats.refusedBy[reason] || 0) + 1;
  strapi.log.info(`[writesafe] stale form refused (409, ${reason}): ${details.uid} ${details.documentId}${details.locale ? ` ${details.locale}` : ''}`);
  throw conflictError(message, { reason, ...details });
}
/** The field a path names, without row ids or values ("items[3].qty" -> "items.qty"). */
const fieldName = (path) => String(path).replace(/\[[^\]]*\]/g, '');
/** Field names (never values: a row label is a value) of what agents changed, for publish and discard refusals. */
const labels = (entries) => [...new Set(entries.filter((e) => e.kind !== 'opaque').map((e) => fieldName(e.path)))].slice(0, 5).join(', ');
/** May the requesting admin read this field (path with row ids) of the entry? The Content Manager's permission checker. */
function readable(strapi, koa, uid, entity) {
  const ability = koa && koa.state && koa.state.userAbility;
  if (!ability) return () => false;
  let pc = null;
  try { pc = strapi.plugin('content-manager').service('permission-checker').create({ userAbility: ability, model: uid }); } catch { pc = null; }
  const attrs = (strapi.contentTypes[uid] && strapi.contentTypes[uid].attributes) || {};
  return (path) => {
    let f = fieldName(path);
    // a dynamic zone is one permission field (its components' fields are not listed): read it by the zone's name
    const top = f.split('.')[0];
    if (attrs[top] && attrs[top].type === 'dynamiczone') f = top;
    try { return pc ? Boolean(pc.can.read(entity || null, f)) : Boolean(ability.can('plugin::content-manager.explorer.read', uid, f)); } catch { return false; }
  };
}

/**
 * Under the document's lock, before Strapi writes, for a Content Manager form request: pass, merge (ctx.params.data is
 * replaced by the rebased form) or refuse with 409. Remembers on the request what the response headers say.
 */
async function beforeFormWrite(strapi, trx, dsCtx, uid, documentId, g) {
  stats.checked += 1;
  const koa = g.koa;
  const locale = await localeOf(strapi, uid, dsCtx.params && dsCtx.params.locale);
  const info = { uid, documentId, locale: locale || null };
  // the row is made first when missing (insert-ignore), then read FOR UPDATE: never a locking read of a missing row (a
  // MySQL gap lock: a header-less discard of a fresh entry then deadlocked with another on its insert). The insert's
  // duplicate check and the locking read both see the latest committed row, so an agent's first write is still seen
  // across the publish controller's older snapshot (review B2).
  const lock = await lockRev(strapi, trx, uid, documentId, true);
  const st = { rev: lock.rev, kept: [] };
  koa.state.writesafeForm = st;
  const raw = koa.get ? koa.get(H_BASE) : (koa.headers || {})[H_BASE];
  const base = raw !== undefined && raw !== '' && /^\d{1,18}$/.test(String(raw)) ? Number(raw) : null;
  if (base === null) {
    // fail closed, decided from the locked counter row (a count of the journal could read MySQL's older snapshot of
    // the publish controller's transaction: review B2): any journaled or pruned revision means a merge is needed
    if (lock.jrev > 0 || lock.pruned > 0) {
      refuse(strapi, raw ? 'bad_base' : 'missing_base', `This entry has changes made by an agent, and this form did not say which version it was loaded from, so they cannot be merged. ${RELOAD} If this happens again after a reload, the admin panel may be served from another origin than the API: see the writesafe README (staleFormGuard, CORS).`, { ...info, current: lock.rev });
    }
    stats.passedNoEntries += 1;
    return;
  }
  if (base > lock.rev) refuse(strapi, 'bad_base', `This form's version (${base}) is unknown. ${RELOAD}`, { ...info, base, current: lock.rev });
  if (base < lock.pruned) refuse(strapi, 'base_too_old', `This form was loaded too long ago to merge it with the changes made since. ${RELOAD}`, { ...info, base, current: lock.rev });
  const entries = base === lock.rev ? [] : await entriesAfter(strapi, trx, lock.k, base, locale ? [locale, '*'] : ['', '*']);
  if (!entries.length) { stats.passedNoEntries += 1; return; }
  if (entries.some((e) => e.kind === 'opaque')) {
    refuse(strapi, 'other_writer', `This entry was changed by another writer after you opened it, and those changes cannot be merged with yours. ${RELOAD}`, { ...info, base, current: lock.rev });
  }
  if (dsCtx.action === 'discardDraft') {
    refuse(strapi, 'discard_unseen', `An agent changed this entry after you opened it (${labels(entries)}). Nothing was discarded. Reload the page to see the changes first.`, { ...info, base, current: lock.rev });
  }
  if (g.publish) {
    refuse(strapi, 'publish_unseen', `An agent changed this entry after you opened it (${labels(entries)}). Nothing was saved or published. Reload the page to review the changes, then publish.`, { ...info, base, current: lock.rev });
  }
  const current = await readDraft(strapi, uid, documentId, locale || undefined);
  const r = R.rebase(attrsOf(strapi), uid, { mine: dsCtx.params.data || {}, current, entries, hash: secretHash });
  // values reach the editor only for fields she may read (the Content Manager's own permission checker, review S5);
  // rows are named by field and position, never by a value (second review R2-S1), so a label needs no check of its own
  const canRead = readable(strapi, koa, uid, current);
  const view = (x) => {
    const ok = !x.secret && canRead(x.path);
    return { label: ok ? x.label : fieldName(x.path), mine: ok ? R.show(x.mine) : R.HIDDEN, agent: ok ? R.show(x.agent) : R.HIDDEN, from: ok ? (x.list ? x.from : R.show(x.from)) : R.HIDDEN, to: ok ? (x.list ? x.to : R.show(x.to)) : R.HIDDEN };
  };
  if (r.conflicts.length) {
    const c = r.conflicts[0];
    const cv = view(c);
    const more = r.conflicts.length > 1 ? ` (and ${r.conflicts.length - 1} more)` : '';
    const msg = c.why === 'edit_vs_delete'
      ? `You and an agent both changed ${cv.label}${more}: one edited it, the other removed it. ${RELOAD}`
      : c.why === 'both_changed_rows'
        ? `You and an agent both added, removed or reordered rows of ${cv.label}${more}. ${RELOAD}`
        : `You and an agent both changed ${cv.label}${more}: yours is "${cv.mine}", the agent's is "${cv.agent}". ${RELOAD}`;
    refuse(strapi, 'conflict', msg, { ...info, base, current: lock.rev, conflicts: r.conflicts.map((x) => { const v = view(x); return { path: x.path, label: v.label, why: x.why, mine: v.mine, agent: v.agent }; }) });
  }
  dsCtx.params.data = r.data;
  st.kept = r.kept.map((k) => { const v = view(k); return { label: v.label, from: v.from, to: v.to }; });
  stats.merged += 1;
}

/** Inside an agent's transaction, after Strapi wrote and before the commit: journal what the write changed. */
async function journalAgent(strapi, trx, dsCtx, uid, documentId, lock, before, locale) { // returns the draft after
  const after = await readDraft(strapi, uid, documentId, locale || undefined);
  const data = (dsCtx.params && dsCtx.params.data) || {};
  const attrs = strapi.contentTypes[uid].attributes || {};
  const localized = isLocalized(strapi, uid);
  const entries = R.journalOf(attrsOf(strapi), uid, before, after, Object.keys(data), secretHash).map((e) => {
    const f = e.path.split(/[[.]/)[0];
    return { ...e, locale: localized && attrs[f] && attrs[f].pluginOptions?.i18n?.localized === false ? '*' : locale };
  });
  stats.agentWrites += 1;
  if (entries.length) await append(strapi, trx, lock, entries, 'agent');
  return after;
}

/** An opaque entry: a write whose changes are not journaled (discard; a writer outside the plugin). */
async function opaque(strapi, trx, uid, documentId, locale, writer) {
  const lock = await lockRev(strapi, trx, uid, documentId, true);
  stats.opaque += 1;
  return append(strapi, trx, lock, [{ path: '*', kind: 'opaque', locale, label: null }], writer);
}

/**
 * The Document Service middleware's part, for update and discardDraft on a writable type, inside the write's
 * transaction (the document's lock already held on Postgres and MySQL; SQLite runs one writer at a time).
 * agent: a writesafe write (inside engine.runWrite); else a form request or another writer.
 */
async function around(strapi, trx, dsCtx, uid, documentId, agent, next) {
  const action = dsCtx.action;
  if (!tracking() || !['update', 'discardDraft', 'delete'].includes(action)) return next();
  const locale = await localeOf(strapi, uid, dsCtx.params && dsCtx.params.locale);
  const delLocale = dsCtx.params && dsCtx.params.locale === '*' ? '*' : locale;
  if (action === 'delete') {
    const locales = await deletedLocales(strapi, trx, uid, documentId, delLocale);
    const res = await next();
    await contentRevisionDeleted(strapi, trx, uid, documentId, locales);
    // the guard: an agent's delete (of a locale or the document): a stale form of it would re-create it (the Content
    // Manager re-creates a missing locale on Save): review S2. Other writers' deletes with otherWriters (default on).
    if (active() && (agent || state.otherWriters)) await opaque(strapi, trx, uid, documentId, delLocale, agent ? 'agent' : 'other');
    return res;
  }
  // the content revision needs the draft before the write only the first time (its row then keeps a fingerprint)
  const known = await tb(strapi, trx, CREV).select(['fp']).where({ k: crevKey(uid, documentId, locale) }).first();
  const needBefore = !(known && known.fp && known.fp !== 'deleted');
  if (!active()) {
    const before = needBefore ? await readDraft(strapi, uid, documentId, locale || undefined) : null;
    const res = await next();
    const after = await readDraft(strapi, uid, documentId, locale || undefined);
    return attach(res, await contentRevision(strapi, trx, uid, documentId, locale, before, after));
  }
  if (agent) {
    if (action === 'discardDraft') {
      const before = needBefore ? await readDraft(strapi, uid, documentId, locale || undefined) : null;
      const res = await next();
      await opaque(strapi, trx, uid, documentId, locale, 'agent');
      return attach(res, await contentRevision(strapi, trx, uid, documentId, locale, before, await readDraft(strapi, uid, documentId, locale || undefined)));
    }
    const lock = await lockRev(strapi, trx, uid, documentId, true);
    const before = await readDraft(strapi, uid, documentId, locale || undefined);
    const res = await next();
    const after = await journalAgent(strapi, trx, dsCtx, uid, documentId, lock, before, locale);
    attach(res, await contentRevision(strapi, trx, uid, documentId, locale, before, after));
    if (hooks.beforeAgentCommit) await hooks.beforeAgentCommit({ uid, documentId });
    return res;
  }
  const g = formRequest(strapi, dsCtx, uid, documentId);
  const before = needBefore ? await readDraft(strapi, uid, documentId, locale || undefined) : null;
  if (g) await beforeFormWrite(strapi, trx, dsCtx, uid, documentId, g);
  const res = await next();
  if (g) {
    // a discard replaced the draft: other tabs' forms are now older than it (the Save's answer carries the new base)
    if (action === 'discardDraft') g.koa.state.writesafeForm.rev = await opaque(strapi, trx, uid, documentId, locale, 'editor');
  } else if (action === 'discardDraft' || state.otherWriters) {
    // Writers outside the plugin (REST, GraphQL, other plugins, review workflows): by default an opaque entry, so an
    // older form refuses after them (otherWriters, default on); otherWriters: false gives Strapi's behaviour (the last
    // Save wins, nothing journaled). A discard always counts: it throws away the draft a form was loaded from.
    await opaque(strapi, trx, uid, documentId, action === 'discardDraft' ? locale : '*', 'other');
  }
  return attach(res, await contentRevision(strapi, trx, uid, documentId, locale, before, await readDraft(strapi, uid, documentId, locale || undefined)));
}

/**
 * Document Service middleware for reads (findOne, findFirst, findMany) of writable types: each result carries its
 * locale's content revision (model.js REVISION), so the version token computed from it binds it (D1). Read after the
 * documents, in the caller's transaction when there is one (SQLite has one connection). A write landing between the
 * two reads gives a token that matches no state: the next write with it is a version_conflict (re-read), never a
 * false match.
 */
function readRevisions(strapi) {
  let writable = null;
  return async (ctx, next) => {
    const res = await next();
    if (!tracking() || !ctx || !['findOne', 'findFirst', 'findMany'].includes(ctx.action) || !res) return res;
    const uid = ctx.uid || ctx.contentType?.uid;
    if (!writable) { try { writable = new Set(require('../engine').writableUids(strapi)); } catch { return res; } }
    if (!writable.has(uid)) return res;
    const docs = (Array.isArray(res) ? res : [res]).filter((d) => d && typeof d === 'object' && typeof d.documentId === 'string');
    if (!docs.length) return res;
    const localized = isLocalized(strapi, uid);
    const def = localized ? await defaultLocale(strapi) : '';
    const byKey = new Map();
    for (const d of docs) {
      const k = crevKey(uid, d.documentId, localized ? (d.locale || def) : '');
      byKey.set(k, (byKey.get(k) || []).concat(d));
    }
    const keys = [...byKey.keys()];
    const read = async (q) => {
      const out = [];
      for (let i = 0; i < keys.length; i += 500) out.push(...await tb(strapi, q, CREV).select(['k', 'rev']).whereIn('k', keys.slice(i, i + 500)));
      return out;
    };
    const inTrx = typeof strapi.db.inTransaction === 'function' && strapi.db.inTransaction();
    const rows = inTrx ? await strapi.db.transaction(({ trx }) => read(trx)) : await read(strapi.db.connection);
    const revs = new Map(rows.map((r) => [r.k, num(r.rev)]));
    for (const [k, ds] of byKey) for (const d of ds) d[REVISION] = revs.get(k) || 0;
    return res;
  };
}

// ---------------------------------------------------------------- the version out (route middleware)
/** Koa middleware: X-Writesafe-Version on the draft findOne (read before the document) and on form Saves. */
function versionHeaders(strapi) {
  return async (koa, next) => {
    if (!active() || (koa.method !== 'GET' && !SAVES[koa.method])) return next();
    const route = cmRoute(strapi, koa.path);
    if (!route) return next();
    let rev = null;
    let target = null;
    // the user is known only after the admin route's auth (inside next()): read the revision now, before the document
    // is read, and answer it only to a signed-in admin's 200
    if (koa.method === 'GET' && route.action === null && koa.query?.status !== 'published' && koa.get && koa.get('authorization')) {
      try {
        if (require('../engine').writableUids(strapi).includes(route.uid)) {
          let documentId = route.documentId;
          if (!documentId) { // a single type: its one document
            const d = await strapi.db.query(route.uid).findOne({ select: ['documentId'] });
            documentId = d && d.documentId;
          }
          if (documentId) {
            target = { k: docKey(route.uid, documentId), uid: route.uid, documentId };
            const row = await tb(strapi, strapi.db.connection, REV).select(['rev']).where({ k: target.k }).first();
            rev = num(row && row.rev);
          }
        }
      } catch { rev = null; }
    }
    await next();
    try {
      if (koa.status !== 200 || !userOf(koa)) return;
      if (rev !== null && target) {
        // the lock row exists from the first load on, so a later Save locks a row, never a gap (MySQL); a write landing
        // since the read above already made it, with a newer revision than the one answered: the safe side
        await tb(strapi, strapi.db.connection, REV).insert({ k: target.k, uid: target.uid, document_id: target.documentId, rev: 0, pruned_rev: 0, at_ms: Date.now() }).onConflict('k').ignore();
        koa.set(H_VERSION, String(rev));
        stats.versionsServed += 1;
      }
      const f = koa.state.writesafeForm;
      if (f && koa.method !== 'GET') {
        koa.set(H_VERSION, String(f.rev));
        if (f.kept && f.kept.length) koa.set(H_MERGED, encodeURIComponent(JSON.stringify(f.kept.slice(0, 20))));
      }
    } catch { /* headers are best effort */ }
  };
}

const retentionHours = () => { try { const h = require('../retention').opts().journalHours; return typeof h === 'number' ? h : RETENTION_HOURS; } catch { return RETENTION_HOURS; } };
/** Retention: journal entries older than retention.journalHours; pruned_rev records them, so an older base gets a 409. */
async function prune(strapi, hours = retentionHours()) {
  if (!state.ok || !hours) return 0;
  const cutoff = Date.now() - hours * 3600000;
  const knex = strapi.db.connection;
  const tops = await tb(strapi, knex, JOURNAL).select('k').max({ r: 'rev' }).where('at_ms', '<', cutoff).groupBy('k').limit(5000);
  let n = 0;
  for (const t of tops) {
    await knex.transaction(async (tx) => {
      await tb(strapi, tx, REV).where({ k: t.k }).andWhere('pruned_rev', '<', num(t.r)).update({ pruned_rev: num(t.r) });
      n += num(await tb(strapi, tx, JOURNAL).where({ k: t.k }).andWhere('rev', '<=', num(t.r)).del());
    });
  }
  stats.pruned += n;
  return n;
}

/** Register the route middleware (register phase) and remember whether the guard is on. */
function install(strapi, enabled) {
  // the content revisions: every Document Service write of a writable type counts (this install runs with the lock only)
  state.tracking = true;
  if (strapi.documents && typeof strapi.documents.use === 'function') strapi.documents.use(readRevisions(strapi));
  state.enabled = enabled === true || Boolean(enabled && typeof enabled === 'object' && enabled.enabled !== false);
  // other writers (REST, GraphQL, other plugins, review workflows) leave an opaque entry by default, so an older form
  // refuses (409) after them (owner decision, 15 Nov 2026); { otherWriters: false } gives Strapi's last-write-wins
  state.otherWriters = !(enabled && typeof enabled === 'object' && enabled.otherWriters === false);
  if (!state.enabled) return false;
  if (strapi.server && typeof strapi.server.use === 'function') strapi.server.use(versionHeaders(strapi));
  // review S3: an admin panel on another origin reads no X-Writesafe-* header unless CORS exposes it (and allows
  // X-Writesafe-Base on requests): every Save of an entry with agent changes then gets 409 missing_base
  try {
    const adminUrl = String(strapi.config.get('admin.url', '/admin') || '');
    if (/^https?:\/\//i.test(adminUrl)) {
      const serverUrl = String(strapi.config.get('server.url', '') || '');
      const same = serverUrl && /^https?:\/\//i.test(serverUrl) && new URL(adminUrl).origin === new URL(serverUrl).origin;
      if (!same) {
        strapi.log.warn('[writesafe] staleFormGuard: the admin panel is served from another origin (admin.url). Add X-Writesafe-Base to the allowed request '
          + 'headers and X-Writesafe-Version, X-Writesafe-Merged to the exposed headers of strapi::cors (see the writesafe README, Config), or admin '
          + 'Saves of entries an agent changed are refused (409 missing_base).');
      }
    }
  } catch { /* a warning only */ }
  return true;
}

module.exports = {
  REV, JOURNAL, SCHEMA_VERSION, RETENTION_HOURS, H_VERSION, H_MERGED, H_BASE, state, stats, hooks,
  install, ensureTables, active, tracking, around, revision, readRevisions, attach, contentRevision, crevKey, CREV, readable, fieldName, secretHash, tb, contentRevisionDeleted, deletedLocales, formRequest, cmRoute, versionHeaders, prune, conflictError, docKey, lockRev, entriesAfter,
};
