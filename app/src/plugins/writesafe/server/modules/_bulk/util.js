'use strict';

/** Helpers shared by the bulk, create, delete, replace and copy modules (server/modules/<name>). */
const E = require('../../engine');
const M = require('../../model');
const CFG = require('../../config');

/**
 * Settings of these modules (config/plugins.js → writesafe.config.bulk / .replace; every key optional):
 *   bulk:    { maxDocuments: 5000, chunkSize: 25, maxChunkSize: 100, timeBudgetMs: 20000, previewMax: 20,
 *              chunkTimeMs: 1000, paceMs: 50, planTtlSeconds: 900, paused: false }
 *   replace: { regexTimeoutMs: 250, totalRegexMs: 5000, chunkRegexMs: 1000, maxPatternLength: 1000,
 *              maxReplaceLength: 10000, maxOutputLength: 1000000, maxScanDocuments: 5000, samples: 10 }
 *
 * bulk.maxDocuments (1.0 hardening item 18): the most documents one job may hold. 5,000 by default; an admin may raise
 *   it up to HARD_MAX_DOCUMENTS (100,000, a code constant): a larger value refuses to start the plugin.
 * bulk.chunkTimeMs: a chunk takes no further document after this long (an admin Save waits for the chunk; item 11).
 * bulk.paceMs: a pause between two chunks of one call, so other writers get the rows (item 18).
 * bulk.planTtlSeconds: how long a dry run's plan_token can start its job (item 17; 15 minutes).
 * bulk.paused: the owner's kill switch: no job starts or resumes, running jobs pause at their next chunk.
 * replace.maxScanDocuments (item 23; rc.2 `scanMax`, still read): how many documents ws_replace may scan for a match,
 *   separate from bulk.maxDocuments (how many it may change). Also capped by HARD_MAX_DOCUMENTS.
 * replace.chunkRegexMs (item 22, N12): the regex time of one job chunk across its documents (one replacer per chunk).
 */
const HARD_MAX_DOCUMENTS = 100000;
// The regex time a scan needs per document at least (a trivial pattern measured about 0.005 ms in the reused context on a loaded machine):
// replace.totalRegexMs must cover maxScanDocuments x this.
const MIN_SCAN_MS_PER_DOC = 0.02;
const DEFAULTS = {
  bulk: { maxDocuments: 5000, chunkSize: 25, maxChunkSize: 100, timeBudgetMs: 20000, previewMax: 20, chunkTimeMs: 1000, paceMs: 50, planTtlSeconds: 900, paused: false },
  replace: { regexTimeoutMs: 250, totalRegexMs: 5000, chunkRegexMs: 1000, maxPatternLength: 1000, maxReplaceLength: 10000, maxOutputLength: 1000000, maxScanDocuments: 5000, samples: 10 },
};
const POSITIVE = {
  bulk: ['maxDocuments', 'chunkSize', 'maxChunkSize', 'timeBudgetMs', 'previewMax', 'planTtlSeconds'],
  replace: ['regexTimeoutMs', 'totalRegexMs', 'chunkRegexMs', 'maxPatternLength', 'maxReplaceLength', 'maxOutputLength', 'maxScanDocuments', 'scanMax', 'samples'],
};
const NON_NEGATIVE = { bulk: ['chunkTimeMs', 'paceMs'], replace: [] };

/** Throws on a bad bulk/replace setting (called by the config validator, so a bad value stops the start). */
function validate(cfg) {
  for (const sect of ['bulk', 'replace']) {
    const c = cfg && cfg[sect];
    if (c === undefined) continue;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`writesafe.${sect} must be an object`);
    for (const [k, v] of Object.entries(c)) {
      if (sect === 'bulk' && k === 'paused') {
        if (typeof v !== 'boolean') throw new Error('writesafe.bulk.paused must be a boolean');
        continue;
      }
      const pos = POSITIVE[sect].includes(k);
      if (!pos && !NON_NEGATIVE[sect].includes(k)) continue; // unknown keys are ignored, as before
      if (!Number.isSafeInteger(v) || v < (pos ? 1 : 0)) throw new Error(`writesafe.${sect}.${k} must be an integer >= ${pos ? 1 : 0} (got ${JSON.stringify(v)})`);
    }
  }
  const rc = (cfg && cfg.replace) || {};
  const s = {
    bulk: { ...DEFAULTS.bulk, ...((cfg && cfg.bulk) || {}) },
    replace: { ...DEFAULTS.replace, ...rc, maxScanDocuments: rc.maxScanDocuments ?? rc.scanMax ?? DEFAULTS.replace.maxScanDocuments },
  };
  if (s.bulk.maxDocuments > HARD_MAX_DOCUMENTS) throw new Error(`writesafe.bulk.maxDocuments may be at most ${HARD_MAX_DOCUMENTS} (got ${s.bulk.maxDocuments})`);
  if (s.replace.maxScanDocuments > HARD_MAX_DOCUMENTS) throw new Error(`writesafe.replace.maxScanDocuments may be at most ${HARD_MAX_DOCUMENTS} (got ${s.replace.maxScanDocuments})`);
  if (s.bulk.chunkSize > s.bulk.maxChunkSize) throw new Error(`writesafe.bulk.chunkSize (${s.bulk.chunkSize}) may not exceed bulk.maxChunkSize (${s.bulk.maxChunkSize})`);
  // Review of PR #16 (M1): a budget that cannot give one document its own limit, or that cannot cover a scan of
  // maxScanDocuments documents at MIN_SCAN_MS_PER_DOC each, cannot work.
  if (s.replace.totalRegexMs < s.replace.regexTimeoutMs) throw new Error(`writesafe.replace.totalRegexMs (${s.replace.totalRegexMs}) must be at least replace.regexTimeoutMs (${s.replace.regexTimeoutMs})`);
  if (s.replace.totalRegexMs < s.replace.maxScanDocuments * MIN_SCAN_MS_PER_DOC) {
    throw new Error(`writesafe.replace.totalRegexMs (${s.replace.totalRegexMs}) is too small to scan replace.maxScanDocuments (${s.replace.maxScanDocuments}) documents: give it at least ${Math.ceil(s.replace.maxScanDocuments * MIN_SCAN_MS_PER_DOC)} ms`);
  }
  if (s.replace.chunkRegexMs < s.replace.regexTimeoutMs) throw new Error(`writesafe.replace.chunkRegexMs (${s.replace.chunkRegexMs}) must be at least replace.regexTimeoutMs (${s.replace.regexTimeoutMs})`);
}

function settings(strapi) {
  const c = CFG.get(strapi);
  const bulk = { ...DEFAULTS.bulk, ...(c.bulk || {}) };
  const rc = c.replace || {};
  // rc.2's replace.scanMax is the same setting as maxScanDocuments (item 23); the new name wins when both are given
  const replace = { ...DEFAULTS.replace, ...rc, maxScanDocuments: rc.maxScanDocuments ?? rc.scanMax ?? DEFAULTS.replace.maxScanDocuments };
  delete replace.scanMax;
  bulk.maxDocuments = Math.min(bulk.maxDocuments, HARD_MAX_DOCUMENTS);
  replace.maxScanDocuments = Math.min(replace.maxScanDocuments, HARD_MAX_DOCUMENTS);
  return { bulk, replace };
}

/** The module api (tools.js apiFor) with the helper signatures these modules use. */
const helpers = (api) => ({ ...api, policies: (strapi, action) => api.policies(action), uidSchema: () => api.uidSchema() });

const { WsError } = E;

/**
 * A component row (or a list of rows, or a dynamic-zone row) made fit to be written as NEW rows: `id` and `_key`
 * removed at every component depth, relations kept as documentIds, media kept as ids.
 */
function freshRows(strapi, cuid, v, depth = 0) {
  if (v == null || depth > 8) return v;
  if (Array.isArray(v)) return v.map((r) => freshRows(strapi, cuid, r, depth));
  const m = strapi.components[cuid || v.__component];
  if (!m) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'id' || k === '_key') continue;
    const a = m.attributes[k];
    if (a && a.type === 'component') out[k] = freshRows(strapi, a.component, x, depth + 1);
    else if (a && a.type === 'dynamiczone') out[k] = (x || []).map((r) => freshRows(strapi, r.__component, r, depth + 1));
    else out[k] = x;
  }
  return out;
}

/** Document data (normalized) as input for a create: no ids, keys or system fields. */
function freshDocData(strapi, uid, doc) {
  const attrs = M.attrsOf(strapi, uid);
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) {
    if (M.SKIP_KEYS.has(k) || !attrs[k]) continue;
    const a = attrs[k];
    if (a.type === 'component') out[k] = freshRows(strapi, a.component, v);
    else if (a.type === 'dynamiczone') out[k] = (v || []).map((r) => freshRows(strapi, r.__component, r));
    else out[k] = v;
  }
  return out;
}

/**
 * Paths present in `input` but missing from `sanitized` (fields Strapi's permission sanitizer dropped without saying so).
 * Arrays are compared index by index; dynamic-zone rows by position.
 */
function droppedPaths(input, sanitized, prefix = '') {
  const out = [];
  if (Array.isArray(input)) {
    input.forEach((x, i) => out.push(...droppedPaths(x, Array.isArray(sanitized) ? sanitized[i] : undefined, `${prefix}[${i}]`)));
    return out;
  }
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    if (k === '__component' || k === '_key' || k === 'id') continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (!sanitized || typeof sanitized !== 'object' || !(k in sanitized)) { out.push(p); continue; }
    if (v && typeof v === 'object' && !(Array.isArray(v) && v.every((x) => typeof x !== 'object'))) out.push(...droppedPaths(v, sanitized[k], p));
  }
  return out;
}

/** Keys of a row (or object) that the sanitizer removed: fields the token cannot read. */
const hiddenKeys = (raw, visible) => Object.keys(raw || {}).filter((k) => k !== 'id' && !(k in (visible || {})));

/** Draft-row where clause for one document (or a list of documents) in one locale. */
function draftWhere(strapi, uid, locale, extra = {}) {
  return { ...extra, ...(locale ? { locale } : {}), ...(E.hasDP(strapi, uid) ? { publishedAt: null } : {}) };
}

/** Lock a chunk's documents before its first read, every locale (the one lock; N6). `locale` is unused. */
async function lockMany(strapi, uid, documentIds, locale) {
  if (!documentIds.length) return [];
  return require('../../compat/db').lockDocuments(strapi, documentIds.map((documentId) => ({ uid, documentId })));
}

/** One receipt-table row read with a locking read (latest committed data on every database). */
async function lockedRow(strapi, key) {
  return strapi.db.queryBuilder(E.RECEIPT_UID).select(['id', 'key', 'requestHash', 'tool', 'receipt'])
    .where({ key }).forUpdate().first().execute();
}

/**
 * Transient claim on a value (for example "story slug hello-world in locale en"). The claim row is inserted into the
 * receipt table, whose `key` has a unique index, and deleted again before the transaction commits. A concurrent
 * transaction claiming the same value blocks on the index until the first commits; it then finds the first one's
 * document in its own (locking) lookup. On SQLite the transaction already serialises writers.
 */
async function claim(strapi, parts) {
  // A claim only serialises creators through the receipts table's unique index (phase 1 review, item 7 widened):
  // without the index two creators could both "claim" and both create.
  E.requireUniqueIndex();
  const key = `claim:${M.sha(parts.join('|'))}`;
  await strapi.db.query(E.RECEIPT_UID).create({ data: { key, tool: 'claim', requestHash: '', receipt: null } });
  return key;
}
async function release(strapi, keys) {
  if (keys.length) await strapi.db.query(E.RECEIPT_UID).deleteMany({ where: { key: { $in: keys } } });
}

/**
 * MySQL runs transactions in REPEATABLE READ: a consistent (non-locking) read sees the snapshot taken at the
 * transaction's FIRST consistent read, even after a row lock was granted later. A write whose transaction read anything
 * (the locale list, the idempotency receipt) before it locked the row can therefore read a draft older than the row it
 * holds, if another writer committed in between. Seen in ws_create (MySQL 8.4, 6 simultaneous upserts): the locking
 * lookup found the other writer's document, the Document Service read of it returned null.
 * engine.lockAndRead compares the locked row's updatedAt with the draft it read and re-runs the write when they differ.
 * Stale + retryStale cover module reads outside lockAndRead (ws_create's upsert lookup). Postgres (READ COMMITTED) and
 * SQLite never take this path.
 */
class Stale extends WsError {
  constructor() {
    super({ code: 'busy', message: 'The transaction read an older snapshot than the row it locked (another write committed at the same moment). Nothing was written. Retry the same request.' });
    this.stale = true;
  }
}
/** Kept for the modules' call sites: the engine's lockAndRead now does the stale-snapshot check itself (and re-runs). */
const lockAndReadFresh = (strapi, uid, documentId, locale) => E.lockAndRead(strapi, uid, documentId, locale);
async function retryStale(fn, attempts = 4) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!(e && e.stale) || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * i));
    }
  }
}

/**
 * The identity of the caller, for job ownership: user id plus a hash of the bearer token (engine.tokenScope). Jobs need
 * the receipts table's unique index too (a start is claimed by its row key). Both are refused, not degraded, since 1.0
 * hardening item 7: without the header two tokens of one user could resume and read each other's jobs.
 */
function callerId(ctx, extra) {
  E.requireUniqueIndex();
  return E.tokenScope(ctx, extra);
}

const truncate = (v, n = 200) => {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…` : v;
  if (Array.isArray(v) || (v && typeof v === 'object')) {
    const s = JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : v;
  }
  return v;
};

module.exports = {
  settings, validate, HARD_MAX_DOCUMENTS, helpers, DEFAULTS, WsError, Stale, lockAndReadFresh, retryStale, freshRows, freshDocData, droppedPaths, hiddenKeys, draftWhere, lockMany, lockedRow, claim, release, callerId, truncate,
};
