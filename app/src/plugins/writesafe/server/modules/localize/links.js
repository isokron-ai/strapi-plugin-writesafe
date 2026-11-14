'use strict';

/**
 * The recorded source-to-target row map of ws_localize (1.0 hardening phase 2, item 12): which row of the target locale
 * each row of the source locale was written to, so the next sync of the same pair pairs rows by identity instead of by
 * position (build.js, pairRows).
 *
 * One row per document and locale pair in the receipts table (plugin::writesafe.receipt):
 *   key      "l10nmap:<sha256(uid|documentId|sourceLocale|targetLocale)>"
 *   tool     "ws_localize_map"
 *   receipt  { v: 2, epoch, pairs: [[componentUid, sourceRowId, targetRowId], ...] }   (row ids only, never content)
 * `epoch` is a hash of the database's row-key epoch (epoch.js, stream A's item 16b): an import into a fresh database
 * gets a new epoch, so a map carried over by the import (the receipts table travels with the content) is ignored
 * instead of naming whatever rows now have those ids. A map without an epoch (rc.2 to phase 2 C before the rebase) or
 * from another epoch is not used.
 * It is written in the localize write's own transaction, so a dry run or a refused write leaves it as it was. It has a
 * receipt and no requestHash, so the receipts retention (retention.js) never prunes it; the history prune only removes
 * "h:" rows. A pair whose rows no longer exist is simply not used (component ids are never reused by the databases).
 */
const M = require('../../model');

const RECEIPT_UID = 'plugin::writesafe.receipt';
const TOOL = 'ws_localize_map';
const keyOf = (uid, documentId, src, tgt) => `l10nmap:${M.sha(`${uid}|${documentId}|${src}|${tgt}`)}`;
/** The current row-key epoch as stored in a map (a hash of it), or null on a per-process epoch (fail closed). */
const epochTag = () => {
  const e = M.rowEpoch ? M.rowEpoch() : null;
  return e && e.epoch && e.fromDb ? M.sha(`l10nmap|${e.epoch}`).slice(0, 16) : null;
};
const usable = (receipt) => Boolean(receipt && Array.isArray(receipt.pairs) && receipt.epoch && receipt.epoch === epochTag());

/** Map "<componentUid>:<sourceRowId>" -> targetRowId (empty when nothing was recorded). */
async function read(strapi, uid, documentId, src, tgt) {
  const row = await strapi.db.query(RECEIPT_UID).findOne({ where: { key: keyOf(uid, documentId, src, tgt) }, select: ['id', 'receipt'] });
  const pairs = row && usable(row.receipt) ? row.receipt.pairs : [];
  const out = new Map();
  for (const p of pairs) if (Array.isArray(p) && p.length === 3) out.set(`${p[0]}:${p[1]}`, Number(p[2]));
  return out;
}

/** Every component row id of a (normalized) document, as "<componentUid>:<id>", at any depth. */
function rowIdsOf(strapi, uid, doc) {
  const out = new Set();
  const walk = (cuid, row) => {
    if (!row || typeof row !== 'object') return;
    for (const [k, a] of Object.entries(M.attrsOf(strapi, cuid))) {
      const v = row[k];
      if (v == null) continue;
      if (a.type === 'component') for (const r of (a.repeatable ? v : [v])) { if (r && r.id != null) out.add(`${a.component}:${r.id}`); walk(a.component, r); }
      if (a.type === 'dynamiczone') for (const r of v) { if (r && r.id != null) out.add(`${r.__component}:${r.id}`); walk(r.__component, r); }
    }
  };
  walk(uid, doc);
  return out;
}

/**
 * Record the pairs of this write (inside the caller's transaction), merged with what was recorded before: a pair of a
 * field this write did not rebuild (a token that cannot read it) is kept as long as its target row still exists in the
 * written locale `doc` (review finding 6). No write when nothing changed. The read locks the map row, so on MySQL it sees
 * the latest committed map (REPEATABLE READ; review finding 7); writers of one document already queue on its row locks.
 */
async function write(strapi, uid, documentId, src, tgt, pairs, doc) {
  const q = strapi.db.query(RECEIPT_UID);
  const key = keyOf(uid, documentId, src, tgt);
  const row = await strapi.db.queryBuilder(RECEIPT_UID).select(['id', 'receipt']).where({ key }).forUpdate().first().execute();
  if (row && typeof row.receipt === 'string') { try { row.receipt = JSON.parse(row.receipt); } catch { row.receipt = null; } }
  const fresh = new Map(pairs.map((p) => [`${p[0]}:${p[1]}`, p]));
  const taken = new Set(pairs.map((p) => `${p[0]}:${p[2]}`));
  const present = doc ? rowIdsOf(strapi, uid, doc) : null;
  for (const p of (row && usable(row.receipt) ? row.receipt.pairs : [])) {
    if (!Array.isArray(p) || p.length !== 3 || fresh.has(`${p[0]}:${p[1]}`) || taken.has(`${p[0]}:${p[2]}`)) continue;
    if (present && !present.has(`${p[0]}:${p[2]}`)) continue; // its target row is gone
    fresh.set(`${p[0]}:${p[1]}`, p);
  }
  const sorted = [...fresh.values()].sort((a, b) => (`${a[0]}:${a[1]}` < `${b[0]}:${b[1]}` ? -1 : 1));
  const tag = epochTag();
  if (!tag) return false; // no database epoch: a map recorded now could not be told from a stale one later
  const receipt = { v: 2, epoch: tag, pairs: sorted };
  if (row) {
    if (M.canonical(row.receipt) === M.canonical(receipt)) return false;
    await q.update({ where: { id: row.id }, data: { receipt } });
  } else {
    await q.create({ data: { key, tool: TOOL, receipt } }); // no targets, no receiptId: never listed by ws_history
  }
  return true;
}

module.exports = { read, write, keyOf, rowIdsOf, epochTag, TOOL };
