'use strict';

/**
 * What the bulk engine (jobs.js) takes from the core and from Strapi, in one place (1.0 hardening, stream E).
 *
 * Phase 3 was built while two Phase 2 streams were still open: stream A (the semantic version "v2.<mac>",
 * content-bound row keys, stale_row_key, the scalar precondition rule) and stream B (one ordered lock helper, the
 * Document Service lock, MySQL lock-before-read, a per-chunk time cap). jobs.js uses their interfaces only through
 * this file, so rebasing onto them changes this file and nothing else in the engine.
 *
 * Assumed interfaces (as designed in the 1.0 hardening; what each falls back to without them):
 *  - versionOf(strapi, uid, raw): the version token of a raw draft. A: engine.versionOfRaw (same signature; the
 *    token becomes "v2.<mac>"). Bulk publish binds this per document in the snapshot (item 19) and compares tokens
 *    as opaque strings, so the format does not matter here.
 *  - lockDocuments(strapi, uid, documentIds): lock a chunk's documents before its first read. B: compat/db.js
 *    lockDocuments (every locale's draft row, one ordered statement per type, remembered per transaction); main:
 *    util.lockMany (the target locale's draft rows in id order). Either way it joins the running transaction.
 *  - isSqlite(strapi): B exports compat/db.isSqlite; main has only clientOf.
 *  - chunkTimeMs: B's bulk.chunkTimeMs (default 1000): a chunk takes no further document after this long. The same
 *    key and default live in util.DEFAULTS here, so B's setting keeps its meaning.
 *  - attemptRetryable(e): whether an item's error is a deadlock, lock timeout or stale snapshot (B: engine.retryDecision
 *    over the cause chain, the test runWrite itself applies). A per-item savepoint must not swallow such an error: the
 *    whole chunk is re-run by engine.runWrite instead.
 *  - itemErrorKind(code): which item errors are a "conflict" (the document changed under the plan) rather than a
 *    failure. A adds stale_row_key and version_format; both count as conflicts when they appear.
 *  - savepoint(strapi, fn): Strapi's db.savepoint (5.5x onward; it also drops the events a rolled-back item queued).
 *    null on Strapi versions without it: jobs.js then re-runs the chunk without the failing document (rc.2's way).
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
