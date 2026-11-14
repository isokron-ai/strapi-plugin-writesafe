'use strict';

/**
 * What the bulk engine (jobs.js) takes from the core and from Strapi, in one place (1.0 hardening, stream E).
 * Design notes: docs/internals.md, section "server/modules/_bulk/deps.js".
 */
const E = require('../../engine');
const U = require('./util');

let DB = null;
try { DB = require('../../compat/db'); } catch { DB = null; }

const versionOf = (strapi, uid, raw) => E.versionOfRaw(strapi, uid, raw);

async function lockDocuments(strapi, uid, documentIds, locale) {
  if (!documentIds.length) return;
  if (DB && typeof DB.lockDocuments === 'function') {
    await DB.lockDocuments(strapi, documentIds.map((documentId) => ({ uid, documentId })));
    return;
  }
  await U.lockMany(strapi, uid, documentIds, locale);
}

const isSqlite = (strapi) => (DB && typeof DB.isSqlite === 'function'
  ? DB.isSqlite(strapi)
  : /sqlite/i.test(String(strapi.db?.config?.connection?.client || strapi.db?.dialect?.client || '')));

/**
 * Whether an item's error must abort the whole chunk attempt (runWrite then re-runs it in a new transaction) instead of
 * being recorded for that document: a deadlock, a lock timeout or writesafe's own stale-snapshot signal. With stream
 * B's engine this is engine.retryDecision on the error's cause chain (the same test runWrite applies); before it, the
 * per-attempt watch flag.
 */
function attemptRetryable(e) {
  const watch = typeof E.attemptState === 'function' ? E.attemptState() : null;
  if (typeof E.retryDecision === 'function') return Boolean(E.retryDecision({ e, watch, attempt: 1, lockWaits: 0, elapsedMs: 0 }).kind);
  return Boolean(watch && watch.retryable);
}

const CONFLICT_CODES = new Set(['version_conflict', 'stale_row_key', 'version_format']);
const itemErrorKind = (code) => (CONFLICT_CODES.has(code) ? 'conflict' : 'failed');

/** Strapi's savepoint, or null when this Strapi has none. */
const savepointOf = (strapi) => (strapi && strapi.db && typeof strapi.db.savepoint === 'function' ? (fn) => strapi.db.savepoint(fn) : null);

module.exports = { versionOf, lockDocuments, isSqlite, attemptRetryable, itemErrorKind, savepointOf };
