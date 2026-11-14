'use strict';

/**
 * The database epoch of component row keys (1.0 hardening item 16b).
 * Design notes: docs/internals.md, section "server/epoch.js".
 */
const crypto = require('crypto');
const M = require('./model');

const TABLE = 'writesafe_row_epoch';
const NAME = 'rowkeys';
const REFRESH_MS = 10000;

let last = 0;
let lastGood = 0; // when the epoch was last read from the database
let pending = null;
const TRANSIENT_GRACE_MS = 60000;
const state = { ok: false, created: false, reason: null };

const conn = (strapi, table) => (typeof strapi.db.getConnection === 'function' ? strapi.db.getConnection(table) : strapi.db.connection(table));
const schema = (strapi) => (typeof strapi.db.getSchemaConnection === 'function' ? strapi.db.getSchemaConnection() : strapi.db.connection.schema);

/** An error of the database connection or query itself (pool timeout, dropped connection): the epoch is unknown. */
const transient = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { transient: true });
/** The read worked and showed the table or row missing, and making it failed: the epoch is gone. */
const recreateFailed = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { recreateFailed: true });

/**
 * Reads the epoch row, creating the table and the row when the read shows them missing (insert-if-missing, safe across
 * replicas). Throws a `transient` error when a read itself fails, a `recreateFailed` one when the read worked but the
 * table or row could not be made (re-review N4).
 */
async function load(strapi) {
  let has;
  let row;
  try {
    has = await schema(strapi).hasTable(TABLE);
    row = has ? await conn(strapi, TABLE).where({ name: NAME }).first() : null;
  } catch (e) {
    throw transient(e);
  }
  let created = false;
  if (!row) {
    try {
      if (!has) {
        try {
          await schema(strapi).createTable(TABLE, (t) => {
            t.string('name', 32).primary();
            t.string('value', 64).notNullable();
            t.bigInteger('created_ms');
          });
        } catch (e) {
          if (!(await schema(strapi).hasTable(TABLE))) throw e; // another replica created it first
        }
      }
      try {
        await conn(strapi, TABLE).insert({ name: NAME, value: crypto.randomBytes(24).toString('base64url'), created_ms: Date.now() });
        created = true;
      } catch (e) {
        // another replica inserted it first: read theirs
      }
      row = await conn(strapi, TABLE).where({ name: NAME }).first();
    } catch (e) {
      throw recreateFailed(e);
    }
    if (!row) throw recreateFailed(new Error(`${TABLE} has no epoch row and none could be created`));
  }
  if (typeof row.value !== 'string' || !row.value) throw recreateFailed(new Error(`${TABLE} has no usable epoch row`));
  const before = M.rowEpoch();
  M.setRowEpoch(row.value, true);
  if (before.fromDb && before.epoch !== row.value) strapi.log.warn('[writesafe] the row key epoch changed (the database was replaced or the epoch reset): row keys read before are refused (stale_row_key)');
  Object.assign(state, { ok: true, created: state.created || created, reason: null });
  last = Date.now();
  lastGood = last;
  return row.value;
}

/** Bootstrap: load (or create) the epoch. Never throws: a failure leaves the per-process epoch (fail closed). */
async function init(strapi) {
  try {
    await load(strapi);
    strapi.log.info(`[writesafe] row key epoch ${state.created ? 'created' : 'loaded'} (${TABLE})`);
  } catch (e) {
    Object.assign(state, { ok: false, reason: e.message });
    strapi.log.error(`[writesafe] row key epoch unavailable (${e.message}): row keys use a per-process epoch and change on restart`);
  }
}

/**
 * Re-reads the epoch at most every REFRESH_MS, outside any transaction (a query outside the running transaction would
 * wait for SQLite's single connection). Called before reads and writes that hand out or take row keys.
 */
async function refresh(strapi) {
  if (Date.now() - last < REFRESH_MS) return;
  if (strapi.db.inTransaction && strapi.db.inTransaction()) return;
  if (pending) return pending;
  pending = load(strapi).catch((e) => {
    last = Date.now();
    Object.assign(state, { ok: false, reason: e.message });
    // A query or connection error (re-review N4): the database's epoch was read less than TRANSIENT_GRACE_MS (60 s)
    // ago, so keep it; a pool timeout must not make every key stale. Fail closed only when the read worked and showed
    // the epoch missing and it could not be made again, or when reads keep failing past the grace period.
    if (!e.recreateFailed && M.rowEpoch().fromDb && lastGood && Date.now() - lastGood <= TRANSIENT_GRACE_MS) {
      strapi.log.warn(`[writesafe] row key epoch check failed (${e.message}); keeping the epoch read ${Math.round((Date.now() - lastGood) / 1000)} s ago`);
      return;
    }
    // Fail closed (phase 2 A review, finding 5): keys read before this moment must not match. A fresh random epoch
    // does that; the next successful check switches to the database's epoch again (keys read meanwhile go stale too).
    M.setRowEpoch(crypto.randomBytes(24).toString('base64url'), false);
    strapi.log.warn(`[writesafe] row key epoch unavailable (${e.message}); using a fresh per-process epoch until the database's can be read: row keys read before are refused`);
  }).finally(() => { pending = null; });
  return pending;
}

/** Test hook: when the epoch was last read from the database. */
const _markLoaded = (t) => { lastGood = t; last = 0; };

module.exports = { TABLE, init, refresh, load, state, TRANSIENT_GRACE_MS, _markLoaded };
