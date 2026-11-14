'use strict';

/** Database internals: row locks, knex error events, the receipts table's unique index. See compat/index.js. */
const C = require('./index');

const clientOf = (strapi) => strapi.db?.config?.connection?.client || strapi.db?.dialect?.client || '';
const isSqlite = (strapi) => /sqlite/i.test(String(clientOf(strapi)));

/**
 * THE ordered lock, for every writesafe write and the Document Service lock (docs/locking.md): every locale's draft
 * row; types by uid, documents by documentId, one `ORDER BY id FOR UPDATE` statement per document (never IN (...): MySQL
 * planned 25 as a primary-key scan and deadlocked), re-run until two runs agree (rows a discard recreated while we
 * waited). Held documents are remembered per transactor, never one whose lock found no row. opts.rows returns the rows
 * (re-read even when held); `.changed` says they changed during the wait. SQLite: no FOR UPDATE.
 */
const HELD = new WeakMap(); // knex transactor -> Set of "uid\u0000documentId"
const heldKey = (uid, documentId) => `${uid}\u0000${documentId}`;
const stats = { statements: 0, documents: 0, rows: 0, skippedHeld: 0, rowsChanged: 0 };

function draftRowsWhere(strapi, uid, documentIds) {
  const dp = Boolean(strapi.contentTypes[uid]?.options?.draftAndPublish);
  return { documentId: documentIds.length === 1 ? documentIds[0] : { $in: documentIds }, ...(dp ? { publishedAt: null } : {}) };
}

async function lockDocuments(strapi, targets, opts = {}) {
  const byUid = new Map();
  for (const t of targets || []) {
    if (!t || !t.uid || typeof t.documentId !== 'string' || !t.documentId) continue;
    (byUid.get(t.uid) || byUid.set(t.uid, new Set()).get(t.uid)).add(t.documentId);
  }
  if (!byUid.size) return [];
  const sqlite = isSqlite(strapi);
  if (sqlite && !opts.rows) return [];
  return strapi.db.transaction(async ({ trx }) => {
    let held = trx ? HELD.get(trx) : null;
    if (trx && !held && !sqlite) { held = new Set(); HELD.set(trx, held); }
    const out = [];
    for (const uid of [...byUid.keys()].sort()) {
      const all = [...byUid.get(uid)].sort();
      const ids = opts.rows || !held ? all : all.filter((d) => !held.has(heldKey(uid, d)));
      stats.skippedHeld += all.length - ids.length;
      if (!ids.length) continue;
      const localized = Boolean(strapi.contentTypes[uid]?.pluginOptions?.i18n?.localized);
      for (const d of ids) {
        const run = async () => {
          let q = strapi.db.queryBuilder(uid).select(['id', 'documentId', 'updatedAt', ...(localized ? ['locale'] : [])])
            .where(draftRowsWhere(strapi, uid, [d])).orderBy({ id: 'asc' });
          if (!sqlite) q = q.forUpdate();
          if (!sqlite) stats.statements += 1;
          return q.execute();
        };
        const idsOf = (rs) => rs.map((r) => r.id).join(',');
        let rows = await run();
        if (!sqlite) {
          for (let i = 0; i < 5; i += 1) {
            const again = await run();
            if (idsOf(again) === idsOf(rows)) break;
            rows = again;
            out.changed = true;
            stats.rowsChanged += 1;
          }
          stats.documents += 1; stats.rows += rows.length;
          if (held && rows.length) held.add(heldKey(uid, d));
        }
        if (opts.rows) for (const r of rows) out.push({ ...r, uid });
      }
    }
    return out;
  });
}

/** Has this transaction (knex transactor) locked the document? */
const holds = (trx, uid, documentId) => Boolean(trx && HELD.get(trx)?.has(heldKey(uid, documentId)));
/** Documents this transaction has locked (test probe). */
const heldCount = (trx) => (trx && HELD.get(trx)?.size) || 0;


function probe(strapi) {
  try {
    const qb = strapi.db.queryBuilder(Object.keys(strapi.contentTypes).find((u) => u.startsWith('api::')) || 'admin::user');
    C.note('db.row_lock', typeof qb.forUpdate === 'function', typeof qb.forUpdate === 'function' ? `forUpdate present (${clientOf(strapi) || 'client ?'})` : 'queryBuilder().forUpdate missing');
  } catch (e) {
    C.note('db.row_lock', false, e.message);
  }
  const knex = strapi.db?.connection;
  C.note('db.query_error_events', Boolean(knex && typeof knex.on === 'function'), knex && typeof knex.on === 'function' ? 'knex emitter present' : 'strapi.db.connection.on missing');
}

/**
 * Deadlocks and lock timeouts, seen per write attempt.
 * Why not read the thrown error: on MySQL, when Strapi's entity manager fails while updating relations, it tries to
 * restore the row with the raw values it read, and that restore fails on JSON columns (mysql2 expands the array into
 * "[object Object]"), so the error that reaches the plugin is an SQL syntax error, not the deadlock. knex still emits
 * the original error as 'query-error', so it is recorded against the running attempt (getStore()).
 */
// Retryable (nothing written): MySQL 1213/1205; Postgres 40P01, 40001, 55P03; SQLITE_BUSY (N11).
const RETRYABLE = /ER_LOCK_DEADLOCK|ER_LOCK_WAIT_TIMEOUT|\b40P01\b|\b40001\b|\b55P03\b|SQLITE_BUSY|deadlock|lock_not_available|could not obtain lock/i;
function watchQueryErrors(strapi, getStore) {
  const knex = strapi.db?.connection;
  if (!knex || typeof knex.on !== 'function') return false;
  knex.on('query-error', (err) => {
    const st = getStore();
    if (!st || !RETRYABLE.test(`${err?.code || ''} ${err?.message || ''}`)) return;
    (st.errors || (st.errors = [])).push({ code: err.code, message: err.message });
    if (!st.retryable) st.retryable = { code: err.code, message: err.message };
  });
  return true;
}

/**
 * Is there a unique index on exactly `column` of `table`? Read from the database's catalog, per dialect. Throws when
 * the catalog cannot be read (the caller then tries to create the index).
 */
async function hasUniqueIndex(strapi, table, column) {
  const knex = strapi.db.connection;
  const client = String(clientOf(strapi) || knex?.client?.config?.client || '');
  if (/sqlite/i.test(client)) {
    const list = await knex.raw(`PRAGMA index_list(${JSON.stringify(table)})`);
    for (const ix of list || []) {
      if (!Number(ix.unique)) continue;
      const cols = (await knex.raw(`PRAGMA index_info(${JSON.stringify(ix.name)})`) || []).map((c) => c.name);
      if (cols.length === 1 && cols[0] === column) return true;
    }
    return false;
  }
  if (/postgres|^pg$/i.test(client)) {
    // only the schema Strapi uses (phase 1 review): another schema can hold a table of the same name
    const schema = strapi.db?.config?.connection?.connection?.schema || strapi.db?.config?.connection?.schema || null;
    const r = await knex.raw('select indexdef from pg_indexes where tablename = ? and schemaname = coalesce(?, current_schema())', [table, schema]);
    return (r.rows || []).some((x) => /^CREATE UNIQUE INDEX/i.test(x.indexdef) && new RegExp(`\\("?${column}"?\\)$`).test(x.indexdef.trim()));
  }
  if (/mysql/i.test(client)) {
    const [rows] = await knex.raw(`SHOW INDEX FROM \`${table}\``);
    const byName = new Map();
    for (const x of rows || []) {
      if (Number(x.Non_unique)) continue;
      (byName.get(x.Key_name) || byName.set(x.Key_name, []).get(x.Key_name)).push(x.Column_name);
    }
    return [...byName.values()].some((cols) => cols.length === 1 && cols[0] === column);
  }
  throw new Error(`unknown database client ${client || '?'}`);
}

/**
 * Unique index on receipts.key: Strapi's `unique` attribute is checked by the app only, not by the database.
 * Returns { ok, reason }. Idempotency keys and jobs are refused while ok is false (1.0 hardening item 7).
 * The index is looked up first (1.0 hardening item 5; fourth review N16): rc.2 ran a GROUP BY over the whole table on
 * every boot to remove duplicates, though duplicates can only exist when the index does not.
 */
async function ensureUniqueIndex(strapi, uid, column) {
  let table;
  try {
    table = strapi.db.metadata.get(uid).tableName;
  } catch (e) {
    C.note('db.receipt_unique_index', false, `metadata lookup failed: ${e.message}`);
    return { ok: false, reason: `metadata lookup failed: ${e.message}` };
  }
  const knex = strapi.db.connection;
  const name = `${table}_${column}_uq`; // 0.2 created `${table}_key_uq`: same name, so an existing index is kept
  try {
    if (await hasUniqueIndex(strapi, table, column)) {
      C.note('db.receipt_unique_index', true, `unique index on ${table}.${column} present`);
      return { ok: true };
    }
  } catch (e) {
    strapi.log.warn(`[writesafe] could not read the indexes of ${table} (${e.message}); creating ${name}`);
  }
  try {
    // Remove duplicates left by a build without the index (keep the first row of each). One key at a time, so the
    // same statements work on MySQL, which refuses a DELETE whose subquery reads the same table.
    const dups = await knex(table).select(column).count({ n: '*' }).groupBy(column).havingRaw('count(*) > 1');
    for (const d of dups) {
      const keep = await knex(table).where({ [column]: d[column] }).min({ id: 'id' }).first();
      await knex(table).where({ [column]: d[column] }).whereNot('id', keep.id).del();
    }
    await knex.schema.alterTable(table, (t) => t.unique([column], { indexName: name }));
    strapi.log.info(`[writesafe] created unique index ${name}${dups.length ? ` (removed duplicates of ${dups.length} keys)` : ''}`);
    C.note('db.receipt_unique_index', true, `created ${name}`);
    return { ok: true };
  } catch (e) {
    if (/already exists|Duplicate key name/i.test(e.message)) {
      C.note('db.receipt_unique_index', true, `${name} present`);
      return { ok: true };
    }
    C.note('db.receipt_unique_index', false, e.message);
    strapi.log.warn(`[writesafe] could not create unique index ${name}: ${e.message}. idempotency_key and jobs are refused until it exists.`);
    return { ok: false, reason: e.message };
  }
}

/**
 * Plain (non-unique) index on one attribute, created once: receipts.receiptId, which ws_history and ws_undo look up by
 * equality and by prefix (a job's chunk receipts). Failure only costs speed, so it is logged, not fatal.
 */
async function ensureIndex(strapi, uid, attribute) {
  let table;
  let column;
  try {
    const meta = strapi.db.metadata.get(uid);
    table = meta.tableName;
    column = (meta.attributes[attribute] && meta.attributes[attribute].columnName) || attribute;
  } catch (e) {
    strapi.log.warn(`[writesafe] index on ${uid}.${attribute} skipped: ${e.message}`);
    return;
  }
  const name = `${table}_${column}_ix`;
  try {
    await strapi.db.connection.schema.alterTable(table, (t) => t.index([column], name));
    strapi.log.info(`[writesafe] created index ${name}`);
  } catch (e) {
    if (!/already exists|Duplicate key name/i.test(e.message)) strapi.log.warn(`[writesafe] could not create index ${name}: ${e.message}`);
  }
}

module.exports = { lockDocuments, holds, heldCount, draftRowsWhere, watchQueryErrors, ensureUniqueIndex, hasUniqueIndex, ensureIndex, probe, RETRYABLE, clientOf, isSqlite, stats };
