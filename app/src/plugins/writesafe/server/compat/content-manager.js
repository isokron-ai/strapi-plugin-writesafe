'use strict';

/** Content Manager permission checker and the i18n locales service. See compat/index.js. */
const C = require('./index');

const pcService = (strapi) => {
  try { return strapi.plugin('content-manager')?.service('permission-checker'); } catch { return undefined; }
};
const localesService = (strapi) => {
  try { return strapi.plugin('i18n')?.service('locales'); } catch { return undefined; }
};

function permissionChecker(strapi, ctx, uid) {
  return pcService(strapi).create({ userAbility: ctx.userAbility, model: uid });
}

/** Codes of the configured locales and the default one, or null when i18n is not there. */
async function locales(strapi) {
  const svc = localesService(strapi);
  if (!svc || typeof svc.find !== 'function') return null;
  return { codes: (await svc.find()).map((l) => l.code), defaultLocale: await svc.getDefaultLocale() };
}

function probe(strapi) {
  const pc = pcService(strapi);
  C.note('cm.permission_checker', Boolean(pc && typeof pc.create === 'function'), pc ? 'service present' : 'content-manager permission-checker service missing');
  const ls = localesService(strapi);
  const ok = Boolean(ls && typeof ls.find === 'function' && typeof ls.getDefaultLocale === 'function');
  C.note('i18n.locales_service', ok, ok ? 'service present' : 'i18n locales service missing (locales not validated up front)');
  return Boolean(pc && typeof pc.create === 'function');
}

module.exports = { permissionChecker, locales, probe };
