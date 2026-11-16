'use strict';

/**
 * The filter grammar of ws_bulk, ws_replace and ws_find (one check, so the tools cannot drift apart): Strapi filters,
 * checked against the token's READ permission through the Content Manager permission checker.
 *
 *  - validateQuery refuses unknown fields and operators (the checker's own error, as `invalid`).
 *  - The filters must come through the read sanitizer unchanged: a filter on a field the token cannot read is refused,
 *    never silently dropped (a dropped key widens the match). The update/publish sanitizer is NOT used for this: it
 *    deletes keys on fields the token may read but not write, which widened a bulk job to every document (review).
 *  - withConditions adds the permission conditions of one action (e.g. "own entries only") as an $and.
 *
 * This folder has no index.js, so the module registry skips it.
 */
const { WsError } = require('../../engine');
const M = require('../../model');

const READ = 'plugin::content-manager.explorer.read';
// Not content: always filterable on a document the token may read (the callers add the read conditions).
const META = new Set(['id', 'documentId', 'locale', 'createdAt', 'updatedAt', 'publishedAt']);

/** The locales a rule's conditions allow, when its only condition is i18n's `locale $in [...]`; otherwise null. */
function localeOnly(cond) {
  if (!cond || typeof cond !== 'object') return null;
  const keys = Object.keys(cond);
  if (keys.length === 1 && keys[0] === 'locale' && cond.locale && Array.isArray(cond.locale.$in)) return cond.locale.$in;
  if (keys.length === 1 && keys[0] === '$and' && Array.isArray(cond.$and) && cond.$and.length) {
    let out = null;
    for (const c of cond.$and) {
      const l = localeOnly(c);
      if (!l) return null;
      out = out ? out.filter((x) => l.includes(x)) : l;
    }
    return out;
  }
  return null;
}

/**
 * The attribute paths a filter names, for one type: `seo.metaTitle` inside a component (the component itself only when
 * an operator compares it whole, e.g. `{seo: {$null: true}}`), `$and`, `$or` and `$not` followed. A relation or media
 * field is a path of its own, and what the filter names inside it is returned in `refs` with the target type, to be
 * checked against THAT type's read rules (filterProblems). Keys that are not attributes are left to validateQuery,
 * except META.
 */
const LOGIC = new Set(['$and', '$or', '$not']);
const REF_META = new Set(['id', 'documentId']);
function filterPaths(strapi, uid, filters, attrsIn, meta = META) {
  const out = new Set();
  const refs = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const walk = (v, attrs, prefix) => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, attrs, prefix)); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (LOGIC.has(k)) { walk(x, attrs, prefix); continue; }
      if (k.startsWith('$')) continue; // an operator on the enclosing path, which is already counted
      const path = prefix ? `${prefix}.${k}` : k;
      const a = attrs[k];
      if (!a) { if (!meta.has(k)) out.add(path); continue; }
      if (a.type === 'component') {
        const comp = (strapi.components || {})[a.component];
        // the component is compared whole when a comparison operator (not a logical one) is applied to it directly
        if (!isObj(x) || Object.keys(x).some((kk) => kk.startsWith('$') && !LOGIC.has(kk))) out.add(path);
        if (comp && isObj(x)) walk(Object.fromEntries(Object.entries(x).filter(([kk]) => !kk.startsWith('$') || LOGIC.has(kk))), comp.attributes || {}, path);
      } else if (a.type === 'relation' || a.type === 'media') {
        out.add(path);
        const target = a.type === 'media' ? 'plugin::upload.file' : a.target;
        if (isObj(x) || Array.isArray(x)) refs.push({ path, target, filters: x });
      } else {
        out.add(path);
      }
    }
  };
  let attrs = attrsIn;
  if (!attrs) { try { attrs = M.attrsOf(strapi, uid) || {}; } catch { attrs = {}; } }
  walk(filters || {}, attrs, '');
  return { paths: [...out], refs };
}

/**
 * Every filter path the token may not use, for `uid` and, through relation and media fields, for their target types
 * (each checked against its own read rules; a target whose model is unknown here has no paths but META). Depth-limited.
 */
function filterProblems(strapi, uid, ability, locale, filters, prefix = '', depth = 0, action = READ) {
  const attrs = ((strapi.contentTypes || {})[uid] || (strapi.components || {})[uid] || {}).attributes || {};
  // inside a relation only the target's identity is free; its timestamps and locale follow its read rules
  const { paths, refs } = filterPaths(strapi, uid, filters, attrs, depth ? REF_META : META);
  const bad = unreadableFilterPaths(strapi, uid, ability, locale, paths, action, { related: depth > 0 }).map((p) => prefix + p);
  for (const r of refs) {
    if (depth >= 4) { bad.push(`${prefix}${r.path}.*`); continue; }
    // a media field's files are read under the Media Library's own permission, not the Content Manager's
    bad.push(...filterProblems(strapi, r.target, ability, locale, r.filters, `${prefix}${r.path}.`, depth + 1, r.target === 'plugin::upload.file' ? 'plugin::upload.read' : READ));
  }
  return bad;
}

/**
 * Field-level read rules (review of #46). Strapi's read sanitizer and validateQuery accept a filter field that ANY read
 * rule allows, whatever that rule's conditions, and the read conditions the callers add are the OR of every read rule's
 * conditions (nothing at all when one rule has none). So with "read title on every page" plus "read title and
 * secretCode on own pages", a filter on secretCode counted other users' pages. A filter field is accepted only when
 *   (a) a read rule without conditions (or with only a locale list that contains this locale) allows it: it is readable
 *       on every document; or
 *   (b) every read rule allows it: a document the read conditions let through matches some rule, and that rule allows
 *       the field.
 * Inside a relation or media field, the target type's own read rules decide, and only (a): its read conditions are not
 * part of the query (for media, the Media Library's plugin::upload.read). Otherwise the filter is refused (fail closed). Any inverted read rule refuses every field filter. Without the rules
 * (no ability, or no rulesFor), only META may be used. The answer depends on the token's rules, never on the data.
 */
/** The leaf paths inside a component path (`seo` -> `seo.metaTitle`, ...); [] when `p` is not a component. */
function leafPaths(strapi, uid, p) {
  const comps = strapi.components || {};
  let attrs = ((strapi.contentTypes || {})[uid] || comps[uid] || {}).attributes || {};
  let a = null;
  for (const seg of p.split('.')) {
    a = attrs[seg];
    if (!a) return [];
    attrs = a.type === 'component' ? ((comps[a.component] || {}).attributes || {}) : {};
  }
  if (!a || a.type !== 'component') return [];
  const out = [];
  const walk = (at, prefix, depth) => {
    for (const [k, x] of Object.entries(at)) {
      if (x.type === 'component' && depth < 8) walk(((comps[x.component] || {}).attributes || {}), `${prefix}.${k}`, depth + 1);
      else out.push(`${prefix}.${k}`);
    }
  };
  walk(attrs, p, 0);
  return out;
}

function unreadableFilterPaths(strapi, uid, ability, locale, paths, action = READ, { related = false } = {}) {
  if (!paths.length) return [];
  let rules = null;
  // possibleRulesFor (CASL) returns every rule for the action and type, field-specific inverted rules included;
  // rulesFor without a field leaves those out
  try {
    if (ability && typeof ability.possibleRulesFor === 'function') rules = ability.possibleRulesFor(action, uid) || [];
    else if (ability && typeof ability.rulesFor === 'function') rules = ability.rulesFor(action, uid) || [];
  } catch { rules = null; }
  if (!rules || !rules.length || rules.some((r) => r && r.inverted)) return paths;
  const direct = (fields, p) => fields.some((f) => f === p || p.startsWith(`${f}.`));
  // a component compared whole (`{seo: {$null: true}}`) is covered when the rule covers every leaf inside it
  const covers = (r, p) => !Array.isArray(r.fields) || direct(r.fields, p)
    || (leafPaths(strapi, uid, p).length > 0 && leafPaths(strapi, uid, p).every((l) => direct(r.fields, l)));
  const free = rules.filter((r) => {
    const c = r.conditions;
    if (!c || !Object.keys(c).length) return true;
    const l = localeOnly(c);
    return Boolean(!related && l && locale && l.includes(locale));
  });
  // (b) relies on the read conditions being part of the query, which holds for the queried type only: a related type's
  // conditions are not applied to it, so there only (a) counts
  return paths.filter((p) => !(free.some((r) => covers(r, p)) || (!related && rules.every((r) => covers(r, p)))));
}

/**
 * Validates `filters` for this permission checker. Returns the filters (an object, {} when none were given).
 * opts.after: text appended to the refusal (ws_bulk: "Nothing was written.").
 * opts.strapi, opts.uid, opts.ability (the token's CASL ability), opts.locale: the field-level read rule check
 * (unreadableFilterPaths). The callers add the read conditions (withConditions(pc, 'read', ...)), which (b) relies on.
 */
async function checkFilters(pc, filters, { after = '', strapi, uid, ability, locale } = {}) {
  const query = { filters: filters || {} };
  try {
    await pc.validateQuery(query);
  } catch (e) {
    throw new WsError({ code: 'invalid', message: `filters: ${e.message}`, details: e.details?.errors?.map?.((x) => ({ path: x.path, message: x.message })) });
  }
  const readSafe = await pc.sanitizeQuery(query);
  if (M.canonical(readSafe.filters || {}) !== M.canonical(query.filters)) {
    throw new WsError({ code: 'invalid', message: `filters: uses fields or operators this token may not filter on.${after ? ` ${after}` : ''}` });
  }
  if (strapi && uid) {
    const bad = filterProblems(strapi, uid, ability, locale, query.filters);
    if (bad.length) {
      throw new WsError({
        code: 'invalid', fields: bad,
        message: `filters: may only use fields this token can read on every document it may read; not ${bad.join(', ')}.${after ? ` ${after}` : ''}`,
      });
    }
  }
  return query.filters;
}

/** `filters` narrowed by the permission conditions of `action` (read, update, publish, ...). */
async function withConditions(pc, action, filters) {
  const cond = (await pc.sanitizedQuery[action]({})).filters || {};
  if (!Object.keys(cond).length) return filters;
  return Object.keys(filters || {}).length ? { $and: [filters, cond] } : cond;
}

module.exports = { checkFilters, withConditions, filterPaths, filterProblems, unreadableFilterPaths };
