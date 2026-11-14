'use strict';

/**
 * Content Manager custom order (5.62+, flag unstableCustomOrder): move() takes the type's order lock, then rewrites
 * many documents' rows; a write that creates a row takes it after. Writes that may create a row of an ordered type take
 * it before any document lock (docs/locking.md). Absent before 5.62.
 */
const CM = require('./content-manager');

const service = (strapi) => {
  try {
    const s = strapi.service('plugin::content-manager.custom-order');
    return s && typeof s.isEnabled === 'function' && typeof s.withOrderLock === 'function' ? s : null;
  } catch { return null; }
};

/** Is custom order on for this type? (Called before a transaction opens, its stale-settings refresh starts outside.) */
function enabled(strapi, uid) {
  const s = service(strapi);
  try { return Boolean(s && s.isEnabled(uid)); } catch { return false; }
}

const HELD = new WeakMap(); // knex transactor -> Set of uids whose order lock it holds

/** Take the type's order lock in the running transaction (once per transaction). */
async function lockOrder(strapi, uid) {
  const s = service(strapi);
  if (!s) return false;
  return strapi.db.transaction(async ({ trx }) => {
    const held = trx && (HELD.get(trx) || HELD.set(trx, new Set()).get(trx));
    if (held && held.has(uid)) return false;
    await s.withOrderLock(uid, async () => {});
    if (held) held.add(uid);
    return true;
  });
}

/** Can this update create a row (a missing locale) of an ordered type? Read outside any transaction (no snapshot). */
async function updateMayCreateRow(strapi, uid, documentId, locale) {
  if (!enabled(strapi, uid)) return false;
  const ct = strapi.contentTypes[uid];
  if (!ct?.pluginOptions?.i18n?.localized) return false;
  let loc = locale;
  if (loc === undefined || loc === null) loc = (await CM.locales(strapi))?.defaultLocale;
  if (typeof loc !== 'string' || !loc || loc === '*') return false;
  const meta = strapi.db.metadata.get(uid);
  const col = (a, d) => meta.attributes[a]?.columnName || d;
  const q = strapi.db.connection(meta.tableName).select('id').where({ [col('documentId', 'document_id')]: documentId, [col('locale', 'locale')]: loc });
  if (ct.options?.draftAndPublish) q.whereNull(col('publishedAt', 'published_at'));
  return !(await q.first());
}

module.exports = { enabled, lockOrder, updateMayCreateRow, service };
