'use strict';

/**
 * True previews for the ws_publish and ws_delete dry runs (1.0 hardening phase 2, item 10; fourth review N7).
 * Design notes: docs/internals.md, section "server/preview.js".
 */
const M = require('./model');

/** Attributes Strapi fills itself on publish: never part of the validated data. */
const SKIP = new Set([...M.SKIP_KEYS]);

const idOf = (x) => (x && typeof x === 'object' ? x.id : x);

/** The draft (as Document Service returns it, relations and media populated) in the input form the validator takes. */
function inputOf(strapi, uid, row, depth = 0) {
  const model = strapi.contentTypes[uid] || strapi.components[uid];
  const out = {};
  if (!model || !row || depth > 10) return out;
  for (const [k, a] of Object.entries(model.attributes || {})) {
    if (SKIP.has(k) || !(k in row)) continue;
    const v = row[k];
    if (a.type === 'relation') {
      if (!a.target || /^morph/.test(a.relation || '')) continue; // polymorphic links: not validated here
      out[k] = Array.isArray(v) ? v.map(idOf).filter((x) => x != null) : (v == null ? null : idOf(v));
    } else if (a.type === 'media') {
      out[k] = Array.isArray(v) ? v.map(idOf).filter((x) => x != null) : (v == null ? null : idOf(v));
    } else if (a.type === 'component') {
      if (a.repeatable) out[k] = (v || []).map((r) => inputOf(strapi, a.component, r, depth + 1));
      else out[k] = v == null ? null : inputOf(strapi, a.component, v, depth + 1);
    } else if (a.type === 'dynamiczone') {
      out[k] = (v || []).map((r) => ({ __component: r.__component, ...inputOf(strapi, r.__component, r, depth + 1) }));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Would Strapi's publish accept this draft? Runs the validation Strapi's publish runs (entries.publishEntry ->
 * validateEntityCreation with isDraft false), read-only. The locale's current published row is excluded from the unique
 * checks, as it is when Strapi deletes it just before validating the new one. Throws Strapi's ValidationError (the
 * engine maps it to `invalid` with details, like a real publish's).
 */
async function validatePublish(strapi, uid, documentId, locale, draftRaw) {
  const validator = strapi.entityValidator;
  if (!validator || typeof validator.validateEntityCreation !== 'function') {
    return { validated: false, note: 'strapi.entityValidator is not available on this Strapi: only versions and permissions were checked' };
  }
  const live = await strapi.db.query(uid).findOne({ select: ['id'], where: { documentId, ...(locale ? { locale } : {}), publishedAt: { $notNull: true } } });
  const data = { ...inputOf(strapi, uid, draftRaw), publishedAt: new Date() };
  await validator.validateEntityCreation(strapi.contentTypes[uid], data, {
    isDraft: false, locale: locale || null, strictRelations: strapi.config.get('api.documents.strictRelations', false) === true,
  }, live ? { id: live.id } : undefined);
  return { validated: true };
}

/** Compat probe (compat/index.js, documents.publish_preview). */
function probe(strapi) {
  const ok = Boolean(strapi.entityValidator && typeof strapi.entityValidator.validateEntityCreation === 'function');
  require('./compat').note('documents.publish_preview', ok, ok ? 'strapi.entityValidator.validateEntityCreation present' : 'strapi.entityValidator missing: publish dry runs check versions and permissions only');
  return ok;
}

module.exports = { validatePublish, inputOf, probe };
