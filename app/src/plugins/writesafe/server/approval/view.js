'use strict';

/**
 * What one approver is shown of a request (review finding 4). The samples, the change and the filter were taken with
 * the REQUESTING token's read permission; an approver may be allowed less. Before a request leaves the admin API they
 * pass through the approver's own ability: values of fields the approver cannot read are replaced, a filter on such a
 * field is not shown, and an approver who cannot read the content type at all sees no sample. Field names stay: they
 * are the schema, and the approver needs them to know what the job touches (`fields`).
 */
const READ = 'plugin::content-manager.explorer.read';
const HIDDEN = '[hidden: you cannot read this field]';
const HIDDEN_FILTER = '[hidden: the filter uses fields you cannot read]';
const PARTIAL_FILTER = '[filter not stored in full (a request from before the whole filter was kept); the start of it follows] ';

/** Every field a bulk spec touches (set, unset, ops, relation ops), sorted. */
function fieldsOf(spec) {
  const s = spec || {};
  const out = new Set([...Object.keys(s.set || {}), ...(s.unset || []),
    ...[...(s.ops || []), ...(s.relation_ops || []), ...(s.relations || [])].map((o) => o && o.field).filter(Boolean),
    ...(Array.isArray(s.fields) ? s.fields : [])]);
  return [...out].sort();
}

/** Top-level field names a Strapi filter uses ($and/$or/$not walked). */
function filterFields(f, out = new Set()) {
  if (Array.isArray(f)) { f.forEach((x) => filterFields(x, out)); return out; }
  if (!f || typeof f !== 'object') return out;
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('$')) filterFields(v, out);
    else out.add(k);
  }
  return out;
}

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
 * approverView(ability, r, modelOf?): modelOf(uid) -> { attributes } lets the filter be checked through relations
 * and components (third review B7); without it, top-level names are checked.
 */
function approverView(ability, r, modelOf = null) {
  const can = (...a) => { try { return Boolean(ability && ability.can(...a)); } catch { return false; } };
  const canType = can(READ, r.uid);
  const canField = (f) => canType && can(READ, r.uid, f);
  // a value at `path`: kept when the path may be read, else masked leaf by leaf (components are permitted per leaf,
  // "items.label"; third review B3), else HIDDEN
  const maskAt = (path, x, depth = 0) => {
    if (canField(path)) return x;
    if (depth > 6 || x == null || typeof x !== 'object') return HIDDEN;
    if (Array.isArray(x)) return x.map((y) => maskAt(path, y, depth + 1));
    return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k === 'id' || k === '__component' || k === '_key' ? y : maskAt(`${path}.${k}`, y, depth + 1)]));
  };
  const spec = r.spec || {};
  const v = { ...r, fields: fieldsOf(spec) };
  const out = {};
  for (const [k, val] of Object.entries(spec)) {
    if (k === 'set') out.set = Object.fromEntries(Object.entries(val || {}).map(([f, x]) => [f, maskAt(f, x)]));
    else if (k === 'unset') out.unset = val;
    else if (k === 'ops' || k === 'relation_ops') out[k] = (val || []).map((o) => (o && o.field ? { ...o, ...(o.data !== undefined ? { data: maskAt(o.field, o.data) } : {}) } : o));
    else out[k] = canType ? val : HIDDEN; // e.g. ws_replace's find/replace: text of the type
  }
  v.spec = out;
  // The whole filter is stored (r.filter). An older request kept only the start of it: say so, rather than calling it
  // hidden (re-review A2: an agent's padding must not make a filter look hidden to a Super Admin).
  let filter = r.filter || null;
  let partial = false;
  if (!filter && r.filter_summary) {
    try { filter = JSON.parse(r.filter_summary); } catch { partial = true; }
  }
  if (filter) {
    v.filter_summary = canType ? JSON.stringify(maskFilter(filter, { can, modelOf, uid: r.uid, prefix: '' })) : HIDDEN_FILTER;
  } else if (partial) {
    v.filter_summary = canType ? PARTIAL_FILTER + r.filter_summary : HIDDEN_FILTER;
  }
  delete v.filter;
  // Read rights with conditions cannot be checked against a sample without loading each document, so samples are not
  // shown then (re-review A4; fail closed), except a condition that is only i18n's locale list containing the job's
  // locale (third review B3).
  let conditional = false;
  try {
    conditional = typeof ability.rulesFor === 'function' && (ability.rulesFor(READ, r.uid) || []).some((x) => {
      if (!x || !x.conditions || !Object.keys(x.conditions).length) return false;
      const locales = localeOnly(x.conditions);
      return !(locales && r.locale && locales.includes(r.locale));
    });
  } catch { conditional = true; }
  if (!canType) {
    v.samples = [];
    v.samples_hidden = true;
  } else if (conditional) {
    v.samples = [];
    v.samples_hidden = 'conditional_read';
  } else {
    const mask = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([f, x]) => [f, maskAt(f, x)])) : o);
    v.samples = (r.samples || []).map((s) => ({ ...s, before: mask(s.before), after: mask(s.after) }));
  }
  return v;
}

/**
 * A filter with every part the approver may not read replaced by HIDDEN: a field of the job's type by its path
 * (components by dotted path), a relation by the related type's own read permission (third review B7).
 */
function maskFilter(f, c, depth = 0) {
  if (depth > 12) return HIDDEN;
  if (Array.isArray(f)) return f.map((x) => maskFilter(x, c, depth + 1));
  if (!f || typeof f !== 'object') return f;
  const out = {};
  const model = c.modelOf ? c.modelOf(c.model || c.uid) : null;
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('$')) { out[k] = maskFilter(v, c, depth + 1); continue; }
    const path = c.prefix ? `${c.prefix}.${k}` : k;
    const a = model && model.attributes ? model.attributes[k] : null;
    // a component is permitted per leaf ("seo.metaTitle"): go into it, the leaves are checked there
    if (a && a.type === 'component') { out[k] = maskFilter(v, { ...c, model: a.component, prefix: path }, depth + 1); continue; }
    if (!c.can(READ, c.uid, path)) { out[k] = HIDDEN; continue; }
    if (a && a.type === 'relation' && a.target) out[k] = maskFilter(v, { ...c, uid: a.target, model: a.target, prefix: '' }, depth + 1);
    else out[k] = v;
  }
  return out;
}

module.exports = { approverView, maskFilter, localeOnly, fieldsOf, filterFields, HIDDEN, HIDDEN_FILTER, PARTIAL_FILTER };
