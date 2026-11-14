'use strict';

/** i18n helpers shared by the localize and history modules. */
const M = require('../../model');

const isLocalizedType = (strapi, uid) => strapi.contentTypes[uid]?.pluginOptions?.i18n?.localized === true;

/**
 * Whether a top-level attribute is per-locale. Uses i18n's own rule when the service is there (localized option,
 * every relation, uid fields); otherwise the attribute's pluginOptions.
 */
function isLocalizedAttr(strapi, uid, name) {
  const a = M.attrsOf(strapi, uid)[name];
  if (!a) return false;
  if (!isLocalizedType(strapi, uid)) return true;
  try {
    const svc = strapi.plugin('i18n').service('content-types');
    if (svc && typeof svc.isLocalizedAttribute === 'function') return svc.isLocalizedAttribute(a);
  } catch {
    // fall through
  }
  return a.pluginOptions?.i18n?.localized === true || a.type === 'relation' || a.type === 'uid';
}

/** Only the per-locale fields of `data` (non-localized fields are Strapi's to sync between locales). */
function localizedOnly(strapi, uid, data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) if (isLocalizedAttr(strapi, uid, k)) out[k] = v;
  return out;
}

module.exports = { isLocalizedType, isLocalizedAttr, localizedOnly };
