'use strict';

/**
 * Build a target locale from a source locale's structure.
 *
 * Text units are the translatable values of the source: string, text, richtext and uid fields, at any depth inside
 * components and dynamic zones, and the text leaves of blocks. Each has a STRUCTURAL path (1.0 hardening item 15):
 * positions and types, never database row ids, so a path stays the same when Strapi recreates the source's component
 * rows without changing them (the i18n sync on a new locale, an import), e.g.
 *   title                                         a top-level field
 *   seo.metaTitle                                 a field of a single component
 *   sections[0:blocks.hero].heading              a field of the first dynamic-zone row, a blocks.hero
 *   items[1:shared.item].label                    a field of the second row of a repeatable component
 *   groups[0:shared.group].entries[1:shared.meta].note   a row of a repeatable nested in a component row
 *   body[0:paragraph].children[0].text            a text leaf of the first blocks node, a paragraph
 * A path names a position of a given type: if the source moves, removes or retypes a row, its version changes and the
 * plan must be read again (expected_source_version).
 *
 * Everything else is structure and is copied: row order, component types, numbers, enumerations, booleans, JSON,
 * media (ids) and relations (mapped: a relation to a localized type points to the related document's version in the
 * target locale when it exists, and is left out and reported otherwise; a relation to a type without i18n is kept).
 * Non-localized fields are never written (Strapi keeps them in sync across locales).
 *
 * Updating an existing target locale: every source row is paired with a target row through an explicit row map
 * (1.0 hardening phase 2, item 12; ChatGPT review, fourth review N18), never by position. A paired row keeps its id and
 * its own per-locale values (translated text, media, enumerations, relations). In order:
 *   1. row_map from the caller: {"<list path>": {"<source row ref>": "<target row ref>" | null}} (null: a new row);
 *   2. the map recorded by earlier ws_localize writes of this document and locale pair (links.js): source row id ->
 *      target row id, kept up to date after every write;
 *   3. a component type with exactly one unpaired, unrecorded row on each side pairs those two.
 * Anything else (two same-type rows on one side, one or more on the other) is ambiguous: the plan lists it with a
 * proposed pairing, and a write is refused (ambiguous_rows) until the caller sends a row_map. Source rows left unpaired
 * are added (copied from the source). Target rows left unpaired (only in the target, or their source row was removed)
 * are KEPT where they are, unless remove_extra_rows is set; the plan lists them either way. The output follows the
 * source order, with kept target rows after the target row they followed. Blocks nodes match by index when their
 * node structure is the same. copy_non_text: true copies non-text values from the source into paired rows too.
 *
 * Row refs: the plan shows rows as structural positions "<index>:<component>" (as in unit paths such as
 * sections[0:blocks.hero]); row_map also takes a ws_get row key ("<component>:<id>:<mac>") or identity for a row.
 */
const M = require('../../model');
const L = require('../_lib/locales');

const TEXT = new Set(['string', 'text', 'richtext', 'uid']);
const hasLetters = (s) => typeof s === 'string' && /\p{L}/u.test(s);

const shapeOf = (n) => (n && typeof n === 'object' ? { t: n.type, c: Array.isArray(n.children) ? n.children.map(shapeOf) : null } : null);

/**
 * opts: { strapi, translations: {path: text}, targetLocale, relations: 'map'|'skip', copyNonText, sourceLocale }
 * Returns { data, units, used, unmapped, rows }.
 */
async function buildTarget(opts, uid, src, tgt) {
  // links: Map "<cuid>:<sourceRowId>" -> targetRowId (recorded map); linkedTgt: "<cuid>:<targetRowId>" -> sourceRowId
  const links = opts.links || new Map();
  const linkedTgt = new Map();
  for (const [k, tid] of links) {
    const at = k.lastIndexOf(':');
    linkedTgt.set(`${k.slice(0, at)}:${tid}`, Number(k.slice(at + 1)));
  }
  const st = {
    ...opts, links, linkedTgt, units: [], used: new Set(), unmapped: [], rows: {}, cache: new Map(),
    ambiguous: [], targetOnly: [], rowMapOut: {}, mapUsed: new Set(), origin: new WeakMap(),
  };
  const attrs = M.attrsOf(opts.strapi, uid);
  const data = {};
  const built = {};
  for (const [name, attr] of Object.entries(attrs)) {
    if (M.SKIP_KEYS.has(name)) continue;
    if (!L.isLocalizedAttr(opts.strapi, uid, name)) continue;
    if (!(name in src)) continue; // not readable by this token: left alone
    const t = tgt ? tgt[name] : undefined;
    const v = await value(st, attr, src[name], t, name, Boolean(tgt));
    if (v === undefined) continue;
    built[name] = v;
    if (!tgt || M.canonical(v) !== M.canonical(t === undefined ? null : t)) data[name] = v;
  }
  const unknown = Object.keys(opts.rowMap || {}).filter((p) => !st.mapUsed.has(p));
  if (unknown.length) throw new MapError(`row_map names list(s) that are not in the document: ${unknown.join(', ')} (use the list paths from the plan's row_map).`, { unknown });
  return {
    data, built, units: st.units, used: st.used, unmapped: st.unmapped, rows: st.rows,
    ambiguous: st.ambiguous, targetOnly: st.targetOnly, rowMap: st.rowMapOut, origin: st.origin,
  };
}


function textUnit(st, type, s, t, path, matched) {
  if (typeof s !== 'string' || s === '') {
    // Nothing to translate: keep the target's own value where it has one.
    return matched && t !== undefined ? t : s;
  }
  const given = Object.prototype.hasOwnProperty.call(st.translations, path);
  let v;
  if (given) { v = st.translations[path]; st.used.add(path); } else if (matched && typeof t === 'string' && t !== '') v = t; else v = s;
  st.units.push({ path, source: s, value: v, given, untranslated: !given && v === s && type !== 'uid' && hasLetters(s) });
  return v;
}

async function relationValue(st, attr, s) {
  if (s == null) return s;
  const target = attr.target;
  if (!target || !L.isLocalizedType(st.strapi, target)) return s;
  const ids = Array.isArray(s) ? s : [s];
  const kept = [];
  for (const id of ids) {
    const k = `${target}|${id}`;
    if (!st.cache.has(k)) {
      const hit = await st.strapi.db.query(target).findOne({ select: ['id'], where: { documentId: id, locale: st.targetLocale } });
      st.cache.set(k, Boolean(hit));
    }
    if (st.cache.get(k)) kept.push(id);
    else st.unmapped.push({ target, documentId: id });
  }
  return Array.isArray(s) ? kept : kept[0] ?? null;
}

async function value(st, attr, s, t, path, matched) {
  const keepT = matched && !st.copyNonText && t != null && !(Array.isArray(t) && !t.length);
  if (TEXT.has(attr.type)) return textUnit(st, attr.type, s, t, path, matched);
  if (attr.type === 'blocks') return blocks(st, s, t, path, matched);
  if (attr.type === 'relation') {
    if (!attr.target) return matched ? undefined : undefined; // polymorphic: not copied
    if (keepT) return t;
    if (st.relations === 'skip') return matched ? t : undefined;
    const r = await relationValue(st, attr, s);
    if (matched && (r == null || (Array.isArray(r) && !r.length)) && t !== undefined) return t;
    return r;
  }
  if (attr.type === 'component') {
    if (!attr.repeatable) {
      if (s == null) return null;
      const row = await compRow(st, attr.component, s, matched && t ? t : undefined, path);
      if (matched && t) row.id = t.id;
      return row;
    }
    return list(st, path, (s || []).map((r) => ({ cuid: attr.component, row: r })), (matched && t ? t : []).map((r) => ({ cuid: attr.component, row: r })), false);
  }
  if (attr.type === 'dynamiczone') {
    return list(st, path, (s || []).map((r) => ({ cuid: r.__component, row: r })), (matched && t ? t : []).map((r) => ({ cuid: r.__component, row: r })), true);
  }
  // media, enumeration, number, boolean, date, json, ...: structure copied, a target's own value kept
  if (keepT) return t;
  return s === undefined ? undefined : s;
}

async function compRow(st, cuid, s, t, path) {
  const out = {};
  for (const [k, a] of Object.entries(M.attrsOf(st.strapi, cuid))) {
    if (!(k in s)) continue;
    const v = await value(st, a, s[k], t ? t[k] : undefined, `${path}.${k}`, Boolean(t));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

class MapError extends Error {
  constructor(message, extra = {}) { super(message); this.code = 'invalid'; this.extra = extra; }
}

/**
 * A row ref the caller sends in row_map: a structural position "<index>:<component>" (the form the plan shows, the same
 * as in unit paths such as sections[0:blocks.hero]) -> { cuid, index }; a ws_get row key "<component>:<id>:<mac>" (stream
 * A's content-bound key, 1.0 hardening item 16b) or a row identity "<component>:<id>" -> { cuid, id }.
 * Keys are matched by their identity (M.keyIdentity), not their MAC: expected_source_version and expected_version already
 * pin both lists to what the plan showed, and a key's MAC is computed over the full row while the plan may only show the
 * token's view of it.
 */
function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && parts[1].includes('.')) return { cuid: parts[1], index: Number(parts[0]) };
  const ident = M.keyIdentity(ref);
  const ip = ident ? ident.split(':') : [];
  if (ip.length === 2 && ip[0].includes('.') && /^\d+$/.test(ip[1])) return { cuid: ip[0], id: Number(ip[1]) };
  return null;
}

/** Index of the row `ref` names in `rows` (entries {cuid, row}), or -1. */
function findRow(rows, ref) {
  const p = parseRef(ref);
  if (!p) return -1;
  if (p.index !== undefined) return p.index < rows.length && rows[p.index].cuid === p.cuid ? p.index : -1;
  return rows.findIndex((e) => e.cuid === p.cuid && e.row && e.row.id === p.id);
}

/**
 * The refs the plan shows for a list's rows: structural positions "<index>:<component>", like the unit paths (1.0
 * hardening item 15). No database ids are handed out; a ws_get key or identity is accepted back too (parseRef).
 */
const keysOf = (rows) => rows.map((e, i) => `${i}:${e.cuid}`);

/**
 * Pair source rows with target rows (see the header): Map srcIndex -> tgtIndex, plus the ambiguous groups.
 * `explicit` is the caller's row_map for this list path (or undefined).
 */
function pairRows(st, path, srcRows, tgtRows, srcKeys, tgtKeys, explicit) {
  const pairs = new Map();
  const fresh = new Set(); // source rows the caller declared new
  const usedT = new Set();
  if (explicit !== undefined) {
    if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) throw new MapError(`row_map["${path}"] must be an object {"<source row>": "<target row>" | null}.`);
    for (const [sref, tref] of Object.entries(explicit)) {
      const si = findRow(srcRows, sref);
      if (si < 0) throw new MapError(`row_map["${path}"]: no source row ${sref} in ${path} (use the keys from the plan).`, { field: path, row: sref });
      if (pairs.has(si) || fresh.has(si)) throw new MapError(`row_map["${path}"]: source row ${sref} is named twice.`, { field: path, row: sref });
      if (tref === null) { fresh.add(si); continue; }
      const ti = findRow(tgtRows, tref);
      if (ti < 0) throw new MapError(`row_map["${path}"]: no target row ${tref} in ${path} of the target locale (use the keys from the plan).`, { field: path, row: tref });
      if (tgtRows[ti].cuid !== srcRows[si].cuid) throw new MapError(`row_map["${path}"]: ${sref} is a ${srcRows[si].cuid} row but ${tref} is a ${tgtRows[ti].cuid} row.`, { field: path });
      if (usedT.has(ti)) throw new MapError(`row_map["${path}"]: target row ${tref} is paired twice.`, { field: path, row: tref });
      pairs.set(si, ti);
      usedT.add(ti);
    }
    st.mapUsed.add(path);
  }
  // recorded links: source row id -> target row id
  for (const [si, e] of srcRows.entries()) {
    if (pairs.has(si) || fresh.has(si) || !e.row || e.row.id == null) continue;
    const tid = st.links.get(`${e.cuid}:${e.row.id}`);
    if (tid == null) continue;
    const ti = tgtRows.findIndex((t, j) => !usedT.has(j) && t.cuid === e.cuid && t.row && t.row.id === tid);
    if (ti >= 0) { pairs.set(si, ti); usedT.add(ti); }
  }
  // Inference: one unpaired, unrecorded row of a type on each side pairs. A target row recorded for a source row that is
  // still in the source belongs to that row and is never a candidate. A target row recorded for a source row that is
  // gone ("stale") cannot be told apart: the source row may have been deleted (and a new one added), or recreated with a
  // new id (Strapi's discard-draft, a whole-list replace, an import into a fresh database). So when an unpaired source row
  // of the same type exists, the pair is ambiguous and the caller decides; otherwise the row is target-only.
  const srcIdSet = new Set(srcRows.map((e) => `${e.cuid}:${e.row && e.row.id}`));
  const recordedFor = (t) => (t.row && t.row.id != null ? st.linkedTgt.get(`${t.cuid}:${t.row.id}`) : undefined);
  const live = (t) => { const s = recordedFor(t); return s != null && srcIdSet.has(`${t.cuid}:${s}`); };
  const stale = (t) => { const s = recordedFor(t); return s != null && !srcIdSet.has(`${t.cuid}:${s}`); };
  const ambiguous = [];
  const types = [...new Set(srcRows.map((e) => e.cuid))];
  for (const cuid of types) {
    const S = srcRows.map((e, i) => i).filter((i) => srcRows[i].cuid === cuid && !pairs.has(i) && !fresh.has(i));
    const T = tgtRows.map((e, j) => j).filter((j) => tgtRows[j].cuid === cuid && !usedT.has(j) && !live(tgtRows[j]));
    if (!S.length || !T.length) continue;
    if (S.length === 1 && T.length === 1 && !stale(tgtRows[T[0]])) { pairs.set(S[0], T[0]); usedT.add(T[0]); continue; }
    ambiguous.push({
      field: path, component: cuid, source: S.map((i) => srcKeys[i]), target: T.map((j) => tgtKeys[j]),
      // the old order-based guess, for the caller to check against the text of both locales
      proposed: Object.fromEntries(S.map((i, k) => [srcKeys[i], k < T.length ? tgtKeys[T[k]] : null])),
    });
  }
  return { pairs, usedT, ambiguous };
}

async function list(st, path, srcRows, tgtRows, zone) {
  const srcKeys = keysOf(srcRows);
  const tgtKeys = keysOf(tgtRows);
  const explicit = st.rowMap ? st.rowMap[path] : undefined;
  const { pairs, ambiguous } = pairRows(st, path, srcRows, tgtRows, srcKeys, tgtKeys, explicit);
  st.ambiguous.push(...ambiguous);
  const out = [];
  const outOfT = new Map(); // target index -> output index of its paired row
  const map = {};
  for (const [i, s] of srcRows.entries()) {
    const j = pairs.get(i);
    const t = j === undefined ? undefined : tgtRows[j].row;
    const row = await compRow(st, s.cuid, s.row, t, `${path}[${i}:${s.cuid}]`);
    if (zone) row.__component = s.cuid;
    if (t) row.id = t.id;
    st.origin.set(row, { cuid: s.cuid, srcId: s.row.id ?? null });
    if (j !== undefined) outOfT.set(j, out.length);
    map[srcKeys[i]] = j === undefined ? null : tgtKeys[j];
    out.push(row);
  }
  if (tgtRows.length) st.rowMapOut[path] = map;
  // Target rows left unpaired: kept in place (after the target row they followed), or removed with remove_extra_rows.
  const srcIds = new Set(srcRows.map((e) => `${e.cuid}:${e.row && e.row.id}`));
  const head = [];
  const after = new Map();
  let kept = 0;
  let removed = 0;
  let anchor = -1;
  for (const [j, t] of tgtRows.entries()) {
    if (outOfT.has(j)) { anchor = outOfT.get(j); continue; }
    const linkedSrc = t.row && t.row.id != null ? st.linkedTgt.get(`${t.cuid}:${t.row.id}`) : undefined;
    const reason = linkedSrc != null && !srcIds.has(`${t.cuid}:${linkedSrc}`) ? 'source_row_removed' : 'only_in_target';
    st.targetOnly.push({ field: path, key: tgtKeys[j], component: t.cuid, reason, action: st.removeExtraRows ? 'remove' : 'keep' });
    if (st.removeExtraRows) { removed += 1; continue; }
    kept += 1;
    const row = { ...t.row };
    if (zone) row.__component = t.cuid;
    st.origin.set(row, { cuid: t.cuid, srcId: linkedSrc ?? null });
    if (anchor < 0) head.push(row);
    else after.set(anchor, [...(after.get(anchor) || []), row]);
  }
  const final = [...head, ...out.flatMap((r, i) => [r, ...(after.get(i) || [])])];
  const top = path.includes('[') ? null : path;
  if (top) {
    const r = st.rows[top] || { matched: 0, added: 0, kept: 0, removed: 0 };
    r.matched += pairs.size;
    r.added += srcRows.length - pairs.size;
    r.kept += kept;
    r.removed += removed;
    st.rows[top] = r;
  }
  return final;
}

/**
 * The source-to-target pairs to record after a write (links.js): [componentUid, sourceRowId, targetRowId] for every
 * list row at any depth. `written` is the written target locale (normalized); a new row gets its id there, by position.
 */
function linksAfterWrite(strapi, uid, b, written) {
  const out = [];
  const walkRow = (cuid, r, w) => {
    if (!r || typeof r !== 'object') return;
    for (const [k, a] of Object.entries(M.attrsOf(strapi, cuid))) {
      if (a.type !== 'component' || !(k in r)) continue;
      if (a.repeatable) walkList(r[k] || [], w && w[k], () => a.component);
      else walkRow(a.component, r[k], w && w[k]);
    }
  };
  const walkList = (rows, wrows, cuidOf) => rows.forEach((r, i) => {
    const w = Array.isArray(wrows) ? wrows[i] : undefined;
    const o = b.origin.get(r);
    const tid = r && r.id != null ? r.id : (w && w.id);
    if (o && o.srcId != null && tid != null) out.push([o.cuid, o.srcId, tid]);
    walkRow(cuidOf(r), r, w);
  });
  for (const [k, a] of Object.entries(M.attrsOf(strapi, uid))) {
    const v = b.built[k];
    if (v == null) continue;
    if (a.type === 'dynamiczone') walkList(v, written && written[k], (r) => r.__component);
    else if (a.type === 'component' && a.repeatable) walkList(v, written && written[k], () => a.component);
    else if (a.type === 'component') walkRow(a.component, v, written && written[k]);
  }
  return out;
}

function blocks(st, s, t, path, matched) {
  if (!Array.isArray(s)) return matched && t !== undefined ? t : s;
  // base is the node the result starts from: the target's node when it has the same structure (its own text, links
  // and other values kept), else a copy of the source node. Text leaves are then translated by path.
  const walk = (sn, base, p, m) => {
    if (!sn || typeof sn !== 'object') return sn;
    const out = { ...base };
    if (sn.type === 'text' && typeof sn.text === 'string') {
      out.text = textUnit(st, 'text', sn.text, base.text, `${p}.text`, m);
      return out;
    }
    if (Array.isArray(sn.children)) out.children = sn.children.map((c, j) => walk(c, base.children[j], `${p}.children[${j}]`, m));
    return out;
  };
  return s.map((node, i) => {
    const m = Boolean(matched && Array.isArray(t) && t[i] && M.canonical(shapeOf(t[i])) === M.canonical(shapeOf(node)));
    return walk(node, JSON.parse(JSON.stringify(m ? t[i] : node)), `${path}[${i}:${node && typeof node === 'object' && typeof node.type === 'string' ? node.type : 'node'}]`, m);
  });
}

module.exports = { buildTarget, linksAfterWrite, parseRef, findRow, shapeOf, TEXT, MapError };
