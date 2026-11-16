'use strict';

/**
 * The Document Service lock (docs/locking.md): for ACTIONS on api:: types, open or join a transaction and take
 * writesafe's lock (compat/db.js lockDocuments) before Strapi writes, so every Document Service writer queues in one
 * order with writesafe. Installed first in register(): bootstrap() middlewares run inside it. SQLite: no-op.
 */
const C = require('./index');
const DB = require('./db');
const CO = require('./custom-order');
const SF = require('./stale-form');

/** Is the running Document Service call a writesafe write (inside engine.runWrite's attempt)? */
const isAgentWrite = () => { const E = require('../engine'); return Boolean(typeof E.attemptState === 'function' && E.attemptState()); };

// Actions that write an existing document's rows (@strapi/core 5.47-5.62); create and clone have no row to lock.
const ACTIONS = new Set(['update', 'delete', 'publish', 'unpublish', 'discardDraft']);

const state = { installed: false, reason: null };
// Counters for the test probe and stress jobs.
const stats = { calls: 0, locked: 0, alreadyHeld: 0, sqlite: 0, skipped: 0, errors: 0, orderFirst: 0, waitMsMax: 0, recent: [] };
const lockedTrx = new WeakSet(); // transactors in which this middleware took a lock (the coverage probe reads it)
const RECENT = 200;

function record(entry) {
  stats.recent.push(entry);
  if (stats.recent.length > RECENT) stats.recent.splice(0, stats.recent.length - RECENT);
}

/**
 * The middleware (exported for the unit tests): api:: types only; the order lock first when an update creates a row of
 * a custom-ordered type; on Postgres, `SELECT 1` after the write when it opened the transaction (an aborted transaction
 * then fails instead of committing as a silent rollback).
 */
function middleware(strapi) {
  let sqlite = null;
  let pg = null;
  let writable = null;
  return async (ctx, next) => {
    if (!ctx || !ACTIONS.has(ctx.action)) return next();
    stats.calls += 1;
    if (sqlite === null) { sqlite = DB.isSqlite(strapi); pg = /postgres|^pg$/i.test(String(DB.clientOf(strapi))); }
    const uid = ctx.uid || ctx.contentType?.uid;
    const documentId = ctx.params && ctx.params.documentId;
    if (sqlite) {
      stats.sqlite += 1;
      // SQLite takes no row lock: it runs one writer at a time, so the stale form guard and the revision counter
      // (stale-form.js) only need the write's own transaction
      if (!SF.tracking() || !['update', 'discardDraft', 'delete'].includes(ctx.action) || !uid || typeof documentId !== 'string' || !documentId) return next();
      if (!writable) writable = new Set(require('../engine').writableUids(strapi));
      if (!writable.has(uid)) return next();
      const agent = isAgentWrite();
      return strapi.db.transaction(async ({ trx }) => SF.around(strapi, trx, ctx, uid, documentId, agent, next));
    }
    if (!writable) writable = new Set(require('../engine').writableUids(strapi));
    if (!uid || typeof documentId !== 'string' || !documentId || !writable.has(uid)) { stats.skipped += 1; return next(); }
    const owner = !(typeof strapi.db.inTransaction === 'function' && strapi.db.inTransaction());
    const agent = isAgentWrite();
    CO.enabled(strapi, uid); // starts custom order's stale-settings refresh outside the transaction (docs/locking.md)
    const orderFirst = ctx.action === 'update' && await CO.updateMayCreateRow(strapi, uid, documentId, ctx.params.locale);
    return strapi.db.transaction(async ({ trx }) => {
      if (DB.holds(trx, uid, documentId)) {
        stats.alreadyHeld += 1;
        record({ action: ctx.action, uid, documentId, held: true, waitMs: 0 });
        // the stale form guard: the agent's journal, in the agent's transaction before its commit (stale-form.js)
        return SF.around(strapi, trx, ctx, uid, documentId, agent, next);
      }
      const t0 = Date.now();
      let rows;
      try {
        if (orderFirst && await CO.lockOrder(strapi, uid)) stats.orderFirst += 1;
        rows = await DB.lockDocuments(strapi, [{ uid, documentId }], { rows: true });
      } catch (e) {
        stats.errors += 1;
        throw e;
      }
      const waitMs = Date.now() - t0;
      stats.locked += 1;
      if (waitMs > stats.waitMsMax) stats.waitMsMax = waitMs;
      if (trx && rows.length) lockedTrx.add(trx);
      record({ action: ctx.action, uid, documentId, held: false, waitMs, rows: rows.length, ...(rows.changed ? { changed: true } : {}), ...(orderFirst ? { orderFirst: true } : {}) });
      // The stale form guard (bench X4), under the lock: an agent write that committed while this Save waited is in the
      // journal; the guard's reads are locking reads (stale-form.js)
      const result = await SF.around(strapi, trx, ctx, uid, documentId, agent, next);
      if (pg && owner && trx) await trx.raw('select 1');
      return result;
    });
  };
}

/** Register the middleware; true when registered. */
function install(strapi, enabled, staleFormGuard = false) {
  if (!enabled) {
    state.reason = 'off (config documentServiceLock: false)';
    C.note('db.document_service_lock', true, state.reason);
    return false;
  }
  if (!strapi.documents || typeof strapi.documents.use !== 'function') {
    state.reason = 'strapi.documents.use missing';
    C.note('db.document_service_lock', false, `${state.reason}: admin Saves and other Document Service writers can deadlock with writesafe writes`);
    strapi.log.warn('[writesafe] strapi.documents.use() not found: the Document Service lock is not installed (see compat report)');
    return false;
  }
  strapi.documents.use(middleware(strapi));
  // the revision counter (the version token binds it) and the stale admin form guard need this lock (they run under
  // it); both are off with documentServiceLock: false
  SF.install(strapi, staleFormGuard);
  state.installed = true;
  state.reason = `registered for ${[...ACTIONS].join(', ')}`;
  C.note('db.document_service_lock', true, state.reason);
  return true;
}

module.exports = { install, middleware, ACTIONS, stats, state, lockedTrx };
