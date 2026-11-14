'use strict';

/**
 * Field-level diffs between two presented documents (M.presentDoc views: the token's read view, rows with _key).
 * Used by dry_run (before -> after of the touched fields, rows matched by key) and by the draft-vs-live comparison
 * (published -> draft, rows matched by content: draft and published rows are separate database rows with other ids).
 */
const M = require('./model');

const canon = (v) => M.canonical(v);
const withoutKey = (r) => {
  if (!r || typeof r !== 'object') return r;
  const { _key, ...rest } = r;
  return rest;
};

function rowFieldChanges(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (k === '_key') continue;
    if (canon(a?.[k]) !== canon(b?.[k])) out[k] = { before: a?.[k] ?? null, after: b?.[k] ?? null };
  }
  return out;
}

/** Rows matched by _key (component lists of one document) or by content (blocks; draft vs published). */
function listDiff(before, after, matchBy) {
  before = before || [];
  after = after || [];
  if (matchBy === 'key') {
    // Rows match by identity ("<component>:<id>"): keys carry a content MAC since 1.0 hardening item 16b, so a row this
    // write changed has a new key. `key` is the row's key after the write (before it, for a removed row).
    const id = (r) => M.keyIdentity(r && r._key);
    const bk = new Map(before.map((r) => [id(r), r]));
    const ak = new Map(after.map((r) => [id(r), r]));
    const added = after.filter((r) => !bk.has(id(r))).map((r) => ({ key: r._key, row: withoutKey(r) }));
    const removed = before.filter((r) => !ak.has(id(r))).map((r) => ({ key: r._key, row: withoutKey(r) }));
    const changed = after.filter((r) => bk.has(id(r))).map((r) => ({ key: r._key, ...(bk.get(id(r))._key !== r._key ? { key_before: bk.get(id(r))._key } : {}), fields: rowFieldChanges(bk.get(id(r)), r) }))
      .filter((c) => Object.keys(c.fields).length);
    const keptOrderBefore = before.filter((r) => ak.has(id(r))).map(id);
    const keptOrderAfter = after.filter((r) => bk.has(id(r))).map(id);
    const out = {};
    if (added.length) out.added = added;
    if (removed.length) out.removed = removed;
    if (changed.length) out.changed = changed;
    if (canon(keptOrderBefore) !== canon(keptOrderAfter)) out.reordered = true;
    out.count = { before: before.length, after: after.length };
    return out;
  }
  // by content (multiset), ignoring keys
  const bag = (rows) => {
    const m = new Map();
    rows.forEach((r, i) => { const c = canon(withoutKey(r)); (m.get(c) || m.set(c, []).get(c)).push({ r, i }); });
    return m;
  };
  const bb = bag(before);
  const ab = bag(after);
  const take = (m, c) => { const l = m.get(c); return l && l.length ? l.shift() : null; };
  const added = [];
  for (const [i, r] of after.entries()) {
    const c = canon(withoutKey(r));
    if (!take(bb, c)) added.push({ index: i, ...(r && r._key ? { key: r._key } : {}), row: withoutKey(r) });
  }
  const removed = [];
  for (const [i, r] of before.entries()) {
    const c = canon(withoutKey(r));
    if (!take(ab, c)) removed.push({ index: i, row: withoutKey(r) });
  }
  const out = {};
  if (added.length) out.added = added;
  if (removed.length) out.removed = removed;
  if (!added.length && !removed.length && canon(before.map(withoutKey)) !== canon(after.map(withoutKey))) out.reordered = true;
  out.count = { before: before.length, after: after.length };
  return out;
}

/**
 * Diff of `fields` (default: every field present in either view) between two presented views.
 * kinds: field -> M.fieldKind. matchRows: 'key' | 'content'. Unchanged fields are left out.
 */
function diffViews(kinds, before, after, { fields, matchRows = 'key' } = {}) {
  const names = fields || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const out = {};
  const LIST = new Set(['repeatable', 'dynamiczone', 'blocks']);
  for (const f of names) {
    const kind = kinds[f];
    // a missing value (e.g. no published version yet) is null, or [] for list fields
    let b = before ? before[f] : undefined;
    let a = after ? after[f] : undefined;
    if (b === undefined) b = LIST.has(kind) ? [] : null;
    if (a === undefined) a = LIST.has(kind) ? [] : null;
    if (canon(matchRows === 'content' ? stripKeys(b) : b) === canon(matchRows === 'content' ? stripKeys(a) : a)) continue;
    if (kind === 'repeatable' || kind === 'dynamiczone') out[f] = listDiff(b, a, matchRows);
    else if (kind === 'blocks') out[f] = listDiff(b, a, 'content');
    else if (kind === 'component' && (a == null || b == null)) out[f] = { before: matchRows === 'content' ? withoutKey(b) : b, after: matchRows === 'content' ? withoutKey(a) : a };
    else if (kind === 'component') out[f] = { fields: rowFieldChanges(matchRows === 'content' ? withoutKey(b) : b, matchRows === 'content' ? withoutKey(a) : a) };
    else out[f] = { before: b ?? null, after: a ?? null };
  }
  return out;
}

function stripKeys(v) {
  if (Array.isArray(v)) return v.map(stripKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== '_key') o[k] = stripKeys(x);
    return o;
  }
  return v;
}

const kindsOf = (strapi, uid) => Object.fromEntries(Object.entries(M.attrsOf(strapi, uid)).map(([k, a]) => [k, M.fieldKind(a)]));

module.exports = { diffViews, listDiff, kindsOf };
