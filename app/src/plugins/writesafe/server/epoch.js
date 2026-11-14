'use strict';

/**
 * The database epoch of component row keys (1.0 hardening item 16b).
 *
 * A random value, created once per database, mixed into every component row key (model.rowHandle). It lives in its own
 * table, `writesafe_row_epoch`, created with knex and NOT declared as a Strapi content type or model, because:
 *   - Strapi's data transfer (`strapi export`, `strapi import`, `strapi transfer`) carries every content type (plugin
 *     ones included: the receipts table travels with the content) and the core store (its `configuration` stage), but
 *     nothing else. So an import into a fresh database never brings the source's epoch: the fresh database creates its
 *     own at first start, and every key read from the source is refused (stale_row_key) instead of naming whatever row
 *     now has that id. An import into the same database leaves the table alone: keys stay valid where the row content
 *     is still the same (and fail where it is not).
 *   - Strapi's schema sync leaves tables it never created alone ("a user custom table that we should not touch",
 *     @strapi/database schema/diff), so the table survives restarts and upgrades.
 * A dump-and-restore of the whole database (pg_dump, mysqldump, a copied SQLite file) carries the table: the restored
 * database keeps its ids and sequences too, so its keys stay valid; the content MAC still refuses a key whose row
 * changed. An admin can force every key stale by deleting the row (or the table): the next check creates a new epoch.
 *
 * Missing at runtime (table or row gone): the next check (at most every REFRESH_MS, 10 s, before a read or write that
 * hands out or takes keys) creates a new epoch, so old keys are refused. If the read works but the epoch cannot be
 * created again, a fresh random per-process epoch is used at once (fail closed, phase 2 A review finding 5). If the
 * read itself fails (a pool timeout, a dropped connection), the epoch last read from the database is kept for up to
 * TRANSIENT_GRACE_MS (60 s, re-review N4), then the plugin fails closed the same way until a read works again. At
 * bootstrap there is no epoch to keep: a failed first read starts on a per-process epoch.
 * Several replicas: each re-reads the epoch on its own schedule, so after a reset a replica can keep accepting old keys
 * for up to REFRESH_MS (10 s); after that every replica uses the new one.
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
