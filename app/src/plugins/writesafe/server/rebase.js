'use strict';

/**
 * The rebase of a stale admin form against the write journal (bench task X4; compat/stale-form.js runs it).
 * Pure functions: the content model comes in as attrsOf(uidOrComponent) -> attributes, so the unit tests need no Strapi.
 *
 * Paths: `f` for a top-level field; `f[rid].k` for field k of the component row rid of f (repeatable, single or dynamic
 * zone), nested as deep as the components go. rid is the row id, `<__component>#<id>` in a dynamic zone. A component
 * field also has a `list` entry at `f` when its rows' membership or order changed (one value: the row ids in order).
 *
 * journalOf(attrsOf, uid, before, after, fields): what a write changed, per leaf path, with before and after values.
 * rebase(attrsOf, uid, { mine, current, entries }): the submitted form `mine` rebased onto `current`, given the
 *   journal entries written since the form's base (oldest first). Per path the agent changed:
 *     mine == base     the editor did not change it: the agent's value stays (the key is dropped, or the row field set
 *                      to the current value);
 *     mine == current  both agree;
 *     otherwise        both changed it: a conflict (nothing is guessed).
 *   Rows are matched by id. A list whose rows changed on both sides is a conflict; on one side, the other side's field
 *   edits are applied to the rows by id. Edit against delete is a conflict.
 *   Returns { data, kept: [{ path, label, from, to }], conflicts: [{ path, label, mine, agent, base, why }] }.
 */

const SCALAR = new Set(['string', 'text', 'richtext', 'email', 'uid', 'enumeration', 'integer', 'biginteger', 'float', 'decimal', 'boolean', 'date', 'time', 'datetime', 'timestamp', 'password']);
const isComp = (a) => a && (a.type === 'component' || a.type === 'dynamiczone');
/** Attributes whose values never go into the journal, a message or a header: only a keyed hash of them is kept. */
const isSecret = (a) => Boolean(a && (a.private === true || a.type === 'password'));
const UNCHANGED_REL = Symbol('relation not changed by the form');

function canonical(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/**
 * A decimal as an exact string ("12.10" -> "12.1", "-0.0" -> "0"): never through a JS Number, which rounds past about
 * 15 significant digits (an editor's change would read as unchanged and be dropped). A Number in (SQLite returns
 * them) is printed as it is; an exponent form is compared as written.
 */
function decimalString(v) {
  let s = String(v).trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return s;
  let sign = '';
  if (s[0] === '+' || s[0] === '-') { sign = s[0] === '-' ? '-' : ''; s = s.slice(1); }
  let [int, frac = ''] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return out === '0' ? '0' : sign + out;
}

/** A field value in the form the merge compares (types the Content Manager and the Document Service spell differently). */
function norm(a, v) {
  if (v === undefined) return undefined;
  if (!a) return v;
  if (a.type === 'media') {
    const one = (x) => (x == null ? null : typeof x === 'object' ? x.id ?? null : x);
    if (a.multiple) return v == null ? [] : (Array.isArray(v) ? v : [v]).map(one);
    return Array.isArray(v) ? one(v[0]) : one(v);
  }
  if (a.type === 'relation') {
    if (v && typeof v === 'object' && !Array.isArray(v) && ('connect' in v || 'disconnect' in v || 'set' in v)) {
      const empty = (x) => !x || (Array.isArray(x) && x.length === 0);
      if (empty(v.connect) && empty(v.disconnect) && !('set' in v)) return UNCHANGED_REL;
      return { form: canonical(v) };
    }
    const ids = (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => (x && typeof x === 'object' ? x.documentId ?? x.id : x)).filter((x) => x != null).map(String).sort();
    return ids;
  }
  if (v === null || v === '') return a.type === 'string' || a.type === 'text' || a.type === 'richtext' ? (v === '' ? '' : null) : null;
  if (a.type === 'decimal') return decimalString(v);
  if (a.type === 'float') return Number(v);
  if (a.type === 'integer') return Number(v);
  if (a.type === 'biginteger') return String(v);
  if (a.type === 'datetime' || a.type === 'timestamp') { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString(); }
  if (a.type === 'boolean') return Boolean(v);
  return v;
}
const eq = (a, x, y) => canonical(norm(a, x)) === canonical(norm(a, y));

// ---------------------------------------------------------------- rows
const rowsOf = (a, v) => {
  if (v == null) return [];
  if (a.type === 'component' && !a.repeatable) return Array.isArray(v) ? v : [v];
  return Array.isArray(v) ? v : [];
};
const ridOf = (a, row) => (row && row.id != null ? (a.type === 'dynamiczone' ? `${row.__component}#${row.id}` : String(row.id)) : null);
const ridsOf = (a, rows) => rows.map((r) => ridOf(a, r));
const compOf = (a, row) => (a.type === 'dynamiczone' ? row && row.__component : a.component);
const HIDDEN = '(hidden)';
const SKIP = new Set(['id', '__component', '__temp_key__', '_key', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'locale', 'localizations']);
/**
 * A row's name in messages and in the journal: the field and the row's position ("items row 2"), never a value (a
 * value can be private, a password or a field the editor may not read: second review R2-S1).
 */
const rowName = (label, rows, rid, a) => { const i = rows.findIndex((r) => ridOf(a, r) === rid); return `${label} row ${i >= 0 ? i + 1 : '?'}`; };

/** A row as data the Document Service takes back (media as ids, relations left out: an id-matched row keeps them). */
function rowData(attrsOf, a, row) {
  const cuid = compOf(a, row);
  const attrs = attrsOf(cuid) || {};
  const out = { id: row.id };
  if (a.type === 'dynamiczone') out.__component = row.__component;
  for (const [k, v] of Object.entries(row)) {
    const ca = attrs[k];
    if (!ca || k === 'id') continue;
    if (ca.type === 'relation') continue;
    if (ca.type === 'media') out[k] = norm(ca, v);
    else if (isComp(ca)) {
      const rs = rowsOf(ca, v).map((r) => rowData(attrsOf, ca, r));
      out[k] = ca.type === 'component' && !ca.repeatable ? rs[0] ?? null : rs;
    } else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- journal
function diffValue(attrsOf, a, path, b, af, out, label, hash) {
  if (!isComp(a)) {
    if (eq(a, b, af)) return;
    if (isSecret(a)) {
      // the values stay out of the journal: a keyed hash is enough to tell whether the editor changed the field
      if (typeof hash !== 'function') return;
      out.push({ path, kind: 'field', hashed: true, before: { h: hash(canonical(norm(a, b === undefined ? null : b))) }, after: { h: hash(canonical(norm(a, af === undefined ? null : af))) }, label });
      return;
    }
    out.push({ path, kind: 'field', before: b === undefined ? null : b, after: af === undefined ? null : af, label });
    return;
  }
  const rb = rowsOf(a, b);
  const ra = rowsOf(a, af);
  if (canonical(ridsOf(a, rb)) !== canonical(ridsOf(a, ra))) out.push({ path, kind: 'list', before: rb.map((r) => scrub(attrsOf, a, r, hash)), after: ra.map((r) => scrub(attrsOf, a, r, hash)), label });
  const byB = new Map(rb.map((r) => [ridOf(a, r), r]));
  for (const r of ra) {
    const rid = ridOf(a, r);
    const prev = byB.get(rid);
    if (!prev || rid == null) continue;
    const attrs = attrsOf(compOf(a, r)) || {};
    const lab = rowName(label, rb, rid, a);
    for (const [k, ca] of Object.entries(attrs)) {
      if (ca.type === 'relation') continue;
      if (!(k in r) && !(k in prev)) continue;
      diffValue(attrsOf, ca, `${path}[${rid}].${k}`, prev[k], r[k], out, `${lab} ${k}`, hash);
    }
  }
}

/** A row as kept in a list entry: secret fields replaced by their keyed hash (recursively). */
function scrub(attrsOf, a, row, hash) {
  if (!row || typeof row !== 'object') return row;
  const attrs = attrsOf(compOf(a, row)) || {};
  const out = { ...row };
  for (const [k, ca] of Object.entries(attrs)) {
    if (!(k in out)) continue;
    if (isSecret(ca)) out[k] = { h: typeof hash === 'function' ? hash(canonical(norm(ca, out[k]))) : null };
    else if (isComp(ca)) { const rs = rowsOf(ca, out[k]).map((r) => scrub(attrsOf, ca, r, hash)); out[k] = ca.type === 'component' && !ca.repeatable ? rs[0] ?? null : rs; }
  }
  return out;
}

/**
 * Journal entries of one write: the fields it was given (`fields`), before and after, per leaf path. hash: a keyed
 * hash for secret attributes (private, password); without it those changes are not journaled.
 */
function journalOf(attrsOf, uid, before, after, fields, hash) {
  const attrs = attrsOf(uid) || {};
  const out = [];
  for (const f of fields) {
    const a = attrs[f];
    if (!a || SKIP.has(f)) continue;
    diffValue(attrsOf, a, f, before ? before[f] : undefined, after ? after[f] : undefined, out, f, hash);
  }
  return out;
}

// ---------------------------------------------------------------- rebase
function rebase(attrsOf, uid, { mine, current, entries, hash }) {
  const attrs = attrsOf(uid) || {};
  const first = new Map(); // path -> first entry since the base (its `before` is the base value)
  for (const e of entries) if (!first.has(e.path)) first.set(e.path, e);
  const data = { ...mine };
  const kept = [];
  const conflicts = [];
  const touched = (p) => [...first.keys()].some((k) => k === p || k.startsWith(`${p}[`) || k.startsWith(`${p}.`));

  const leaf = (a, path, mn, cur, label, set, del) => {
    const e = first.get(path);
    if (!e) return;
    if (e.hashed) {
      // a secret field: compare hashes; values never go into the result's messages
      const hv = (v) => (typeof hash === 'function' ? hash(canonical(norm(a, v === undefined ? null : v))) : null);
      const mh = hv(mn);
      if (mh !== null && mh === (e.before && e.before.h)) {
        if (mh !== hv(cur)) { kept.push({ path, label, from: HIDDEN, to: HIDDEN, secret: true }); if (del) del(); else set(cur); }
        return;
      }
      if (mh !== null && mh === hv(cur)) return;
      conflicts.push({ path, label, mine: HIDDEN, agent: HIDDEN, base: HIDDEN, why: 'both_changed', secret: true });
      return;
    }
    const base = e.before;
    if (a.type === 'relation') {
      if (norm(a, mn) === UNCHANGED_REL || mn === undefined) return;
      if (eq(a, mn, cur)) return;
      conflicts.push({ path, label, mine: mn, agent: cur, base, why: 'both_changed' });
      return;
    }
    if (eq(a, mn, base)) {
      if (!eq(a, mn, cur)) { kept.push({ path, label, from: base, to: cur }); if (del) del(); else set(cur); }
      return;
    }
    if (eq(a, mn, cur)) return;
    conflicts.push({ path, label, mine: mn, agent: cur, base, why: 'both_changed' });
  };

  // a row's base: the list entry's before-row when the list changed, else the current row with the journaled leaves
  // put back to their before values
  const baseRow = (a, path, rid, curRow, listEntry) => {
    if (listEntry) { const r = rowsOf(a, listEntry.before).find((x) => ridOf(a, x) === rid); if (r) return r; }
    return curRow;
  };
  // Did the editor change anything in this row, against its base? The whole row: scalars, media, relations (any
  // connect/disconnect counts), nested components by id and their rows' membership and order. When in doubt, yes
  // (the caller answers a conflict): an edit must never be dropped behind a 200.
  const sameValue = (ca, p, mv, bv) => {
    if (ca.type === 'relation') return norm(ca, mv) === UNCHANGED_REL || mv === undefined;
    if (isSecret(ca)) {
      const e = first.get(p);
      if (e && e.hashed) return typeof hash === 'function' && hash(canonical(norm(ca, mv === undefined ? null : mv))) === (e.before && e.before.h);
      if (bv && typeof bv === 'object' && 'h' in bv) return typeof hash === 'function' && hash(canonical(norm(ca, mv === undefined ? null : mv))) === bv.h;
      return eq(ca, mv, bv);
    }
    if (!isComp(ca)) return eq(ca, mv, first.has(p) ? first.get(p).before : bv);
    const le = first.get(p) && first.get(p).kind === 'list' ? first.get(p) : null;
    const baseRows = le ? rowsOf(ca, le.before) : rowsOf(ca, bv);
    const mineRows = rowsOf(ca, mv);
    if (canonical(ridsOf(ca, mineRows)) !== canonical(ridsOf(ca, baseRows))) return false;
    const byRid = new Map(baseRows.map((r) => [ridOf(ca, r), r]));
    return mineRows.every((r) => rowSame(ca, p, ridOf(ca, r), r, byRid.get(ridOf(ca, r))));
  };
  const rowSame = (a, path, rid, mineRow, base) => {
    if (!mineRow) return true;
    if (!base) return false;
    const ra = attrsOf(compOf(a, mineRow)) || {};
    for (const [k, ca] of Object.entries(ra)) {
      if (!(k in mineRow)) continue;
      if (!sameValue(ca, `${path}[${rid}].${k}`, mineRow[k], base[k])) return false;
    }
    return true;
  };
  const rowChanged = (a, path, rid, mineRow, base) => !rowSame(a, path, rid, mineRow, base);

  const mergeRows = (a, path, mineVal, curVal, label) => {
    const mineRows = rowsOf(a, mineVal);
    const curRows = rowsOf(a, curVal);
    const listEntry = first.get(path) && first.get(path).kind === 'list' ? first.get(path) : null;
    const baseIds = listEntry ? ridsOf(a, rowsOf(a, listEntry.before)) : ridsOf(a, curRows);
    const curIds = ridsOf(a, curRows);
    const mineIds = ridsOf(a, mineRows);
    const agentStruct = canonical(baseIds) !== canonical(curIds);
    const editorStruct = mineIds.some((x) => x == null) || canonical(mineIds) !== canonical(baseIds);
    if (agentStruct && editorStruct) {
      conflicts.push({ path, label, mine: mineIds, agent: curIds, base: baseIds, why: 'both_changed_rows' });
      return mineVal;
    }
    const curBy = new Map(curRows.map((r) => [ridOf(a, r), r]));
    const mineBy = new Map(mineRows.filter((r) => ridOf(a, r) != null).map((r) => [ridOf(a, r), r]));
    const mergeRow = (mineRow, curRow, rid) => {
      const cuid = compOf(a, mineRow);
      const ra = attrsOf(cuid) || {};
      const out = { ...mineRow };
      const lab = rowName(label, mineRows, rid, a);
      for (const [k, ca] of Object.entries(ra)) {
        if (!(k in mineRow)) continue;
        const p = `${path}[${rid}].${k}`;
        if (isComp(ca)) {
          if (touched(p)) out[k] = mergeRows(ca, p, mineRow[k], curRow[k], `${lab} ${k}`);
        } else {
          leaf(ca, p, mineRow[k], curRow[k], `${lab} ${k}`, (v) => { out[k] = ca.type === 'media' ? norm(ca, v) : v; });
        }
      }
      return out;
    };
    let rows;
    if (agentStruct) {
      // the agent changed the rows; the editor did not: the agent's rows, with the editor's field edits by id
      rows = [];
      for (const r of curRows) {
        const rid = ridOf(a, r);
        rows.push(mineBy.has(rid) ? mergeRow(mineBy.get(rid), r, rid) : rowData(attrsOf, a, r));
      }
      for (const [rid, mr] of mineBy) {
        if (curBy.has(rid)) continue;
        if (rowChanged(a, path, rid, mr, baseRow(a, path, rid, null, listEntry))) {
          conflicts.push({ path: `${path}[${rid}]`, label: `${rowName(label, mineRows, rid, a)} (edited by you, removed by the agent)`, mine: mr, agent: null, base: null, why: 'edit_vs_delete' });
        }
      }
      kept.push({ path, label, from: `${baseIds.length} rows`, to: `${curIds.length} rows`, list: true });
    } else {
      // the rows as the editor left them (her adds, removes and order), with the agent's field edits by id
      rows = mineRows.map((mr) => {
        const rid = ridOf(a, mr);
        return rid != null && curBy.has(rid) ? mergeRow(mr, curBy.get(rid), rid) : mr;
      });
      for (const [rid] of curBy) {
        if (mineBy.has(rid)) continue;
        // the editor removed a row the agent edited
        if ([...first.keys()].some((k) => k.startsWith(`${path}[${rid}].`))) {
          conflicts.push({ path: `${path}[${rid}]`, label: `${rowName(label, curRows, rid, a)} (removed by you, edited by the agent)`, mine: null, agent: curBy.get(rid), base: null, why: 'edit_vs_delete' });
        }
      }
    }
    return a.type === 'component' && !a.repeatable ? rows[0] ?? null : rows;
  };

  for (const [f, a] of Object.entries(attrs)) {
    if (!(f in mine) || !touched(f)) continue;
    if (isComp(a)) data[f] = mergeRows(a, f, mine[f], current ? current[f] : undefined, f);
    else leaf(a, f, mine[f], current ? current[f] : undefined, f, (v) => { data[f] = v; }, () => { delete data[f]; });
  }
  return { data, kept, conflicts };
}

/** Short text of a value for messages. */
function show(v) {
  if (v === undefined || v === null) return 'empty';
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return v.id != null ? `#${v.id}` : 'a value';
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

module.exports = { journalOf, rebase, norm, eq, canonical, show, rowName, decimalString, isSecret, UNCHANGED_REL, HIDDEN };
