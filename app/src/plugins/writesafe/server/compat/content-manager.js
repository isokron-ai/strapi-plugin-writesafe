'use strict';

/** Content Manager permission checker and the i18n locales service. See compat/index.js. */
const C = require('./index');

const pcService = (strapi) => {
  try { return strapi.plugin('content-manager')?.service('permission-checker'); } catch { return undefined; }
};
const localesService = (strapi) => {
  try { return strapi.plugin('i18n')?.service('locales'); } catch { return undefined; }
};

/**
 * Per-document read fields. Strapi's sanitizeOutput decides the fields once for all documents: when any read rule has no
 * field list it allows every field, whatever that rule's conditions, so with "title on every page" plus "every field on
 * own pages" it returned other users' hidden fields. readableOnly() keeps, of what sanitizeOutput returned, only the
 * fields this token may read on THIS document (pc.can.read(entity, path): CASL with the document as subject, as the
 * Content Manager checks a single field). Components are checked per sub-field; a dynamic zone is one permission field.
 * It only removes: what sanitizeOutput already left out stays out.
 */
function readableOnly(strapi, uid, pc, entity, out) {
  if (Array.isArray(out)) return out.map((x, i) => readableOnly(strapi, uid, pc, Array.isArray(entity) ? entity[i] : x, x));
  if (!out || typeof out !== 'object') return out;
  const comps = strapi.components || {};
  const model = (strapi.contentTypes || {})[uid] || comps[uid];
  const attrs = (model && model.attributes) || {};
  const can = (path) => { try { return Boolean(pc.can.read(entity, path)); } catch { return false; } };
  // a populated related document or file: its identity only (defence in depth; replies normalize relations anyway)
  const ref = (v) => {
    const one = (x) => (x && typeof x === 'object' ? Object.fromEntries(['id', 'documentId', 'locale'].filter((k) => k in x).map((k) => [k, x[k]])) : x);
    return Array.isArray(v) ? v.map(one) : one(v);
  };
  const isRef = (a) => a && (a.type === 'relation' || a.type === 'media');
  // the readable part of a component value; undefined when no sub-field of it is readable (whatever its value, so an
  // unreadable component does not tell an empty one from a filled one)
  const sub = (value, cattrs, prefix, depth) => {
    const readableHere = Object.entries(cattrs).some(([k, a]) => can(`${prefix}.${k}`)
      || (a.type === 'component' && depth < 8 && sub(undefined, ((comps[a.component] || {}).attributes) || {}, `${prefix}.${k}`, depth + 1) !== undefined));
    if (!readableHere) return undefined;
    const one = (row) => {
      if (!row || typeof row !== 'object') return row;
      const kept = {};
      for (const [k, v] of Object.entries(row)) {
        const a = cattrs[k];
        if (!a) { kept[k] = v; continue; } // id, __component
        const p = `${prefix}.${k}`;
        if (can(p)) kept[k] = isRef(a) ? ref(v) : v;
        else if (a.type === 'component' && depth < 8) {
          const inner = sub(v, ((comps[a.component] || {}).attributes) || {}, p, depth + 1);
          if (inner !== undefined) kept[k] = inner;
        }
      }
      return kept;
    };
    if (value === undefined) return true;
    return Array.isArray(value) ? value.map(one) : (value == null ? value : one(value));
  };
  const res = {};
  for (const [k, v] of Object.entries(out)) {
    const a = attrs[k];
    if (!a) { res[k] = v; continue; } // id, documentId, locale, timestamps: not permission fields
    if (can(k)) { res[k] = isRef(a) ? ref(v) : v; continue; }
    if (a.type === 'component') {
      const inner = sub(v, ((comps[a.component] || {}).attributes) || {}, k, 0);
      if (inner !== undefined) res[k] = inner;
    }
  }
  return res;
}

function permissionChecker(strapi, ctx, uid) {
  const pc = pcService(strapi).create({ userAbility: ctx.userAbility, model: uid });
  return {
    ...pc,
    sanitizeOutput: async (data, opts) => readableOnly(strapi, uid, pc, data, await pc.sanitizeOutput(data, opts)),
    // Strapi's own field-level sanitizer, without the per-document step: ONLY for data kept server-side and never
    // returned as it is (ws_delete's history recreate image, which ws_undo re-filters for whoever shows or restores it)
    sanitizeOutputServerSide: (data, opts) => pc.sanitizeOutput(data, opts),
  };
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

module.exports = { permissionChecker, readableOnly, locales, probe };
