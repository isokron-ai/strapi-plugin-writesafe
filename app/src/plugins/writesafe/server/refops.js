'use strict';

/**
 * Ref ops (1.0 hardening item 20): {op: "add" | "remove", field, ref, key?, path?, position?} link or unlink one
 * document of a to-many relation or one file of a multiple media field (top level, inside a single component with
 * path, inside a row with key + path). They edit the current list under the row lock and need no version; a top-level
 * relation op becomes Strapi's connect/disconnect of its own link (relationOps). Already linked / not linked are
 * reported no-ops. Nested lists (nestedListChanges): a write that replaces a list inside a component needs a version.
 * Errors use the engine's WsError (setErrorClass).
 */
const M = require('./model');

let WsError = class extends Error {
  constructor(payload) { super(payload.message || payload.code); this.payload = payload; }
};
const setErrorClass = (C) => { WsError = C; };
const invalid = (message, extra = {}) => new WsError({ code: 'invalid', message, ...extra });

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const isRefOp = (op) => Boolean(op) && (op.op === 'add' || op.op === 'remove') && has(op, 'ref');

const isToManyRel = (a) => Boolean(a) && a.type === 'relation' && M.isToMany(a);
const isMultiMedia = (a) => Boolean(a) && a.type === 'media' && a.multiple === true;
const LEAF_HINT = 'ref ops apply to a to-many relation or a multiple media field';

/** The leaf a ref op edits, checked: a to-many relation (with a target) or a multiple media field. */
function checkLeaf(a, name, where) {
  if (!a) throw invalid(`${where}: unknown field ${name}.`);
  if (a.type === 'relation') {
    if (!a.target) throw new WsError({ code: 'unsupported', message: `${where}: ${name} is a polymorphic relation; not supported.` });
    if (!M.isToMany(a)) throw invalid(`${where}: ${name} is a ${a.relation} relation (one document): use set (with expected_version) to change it; ${LEAF_HINT}.`);
    return 'relation';
  }
  if (a.type === 'media') {
    if (!a.multiple) throw invalid(`${where}: ${name} is a single media field: use set (with expected_version) to change it; ${LEAF_HINT}.`);
    return 'media';
  }
  if (a.type === 'component' && a.repeatable) {
    throw invalid(`${where}: ${name} is a nested repeatable component: its rows have no keys, so ${LEAF_HINT}. Replace that list with expected_version instead.`);
  }
  throw invalid(`${where}: ${name} is not a list of references; ${LEAF_HINT}.`);
}

const segsOf = (path) => (Array.isArray(path) ? path : String(path).split('.')).filter((s) => s !== '');

/**
 * Walk `path` from component `cuid` through nested SINGLE components to the leaf. Returns { kind, attr, path }.
 */
function pathAttr(strapi, cuid, path, where = 'ref op') {
  const segs = segsOf(path);
  if (!segs.length) throw invalid(`${where}: path is empty.`);
  let model = strapi.components[cuid];
  for (const [i, s] of segs.entries()) {
    const a = model && model.attributes ? model.attributes[s] : null;
    const name = segs.slice(0, i + 1).join('.');
    if (!a) throw invalid(`${where}: no field ${name} in component ${cuid}.`);
    if (i === segs.length - 1) return { kind: checkLeaf(a, name, where), attr: a, path: segs };
    if (a.type !== 'component' || a.repeatable) {
      throw invalid(`${where}: ${name} is not a single component, so the path cannot go through it${a.type === 'component' ? ' (nested rows have no keys: replace that list with expected_version)' : ''}.`);
    }
    model = strapi.components[a.component];
  }
  throw invalid(`${where}: bad path.`);
}

/** What one ref op edits, checked against the schema: {kind, attr, field, path, container} (dz leaf: checked later). */
function refTarget(strapi, uid, op, where = `ref op (${op && op.op} on ${op && op.field})`) {
  if (has(op, 'data')) throw invalid(`${where}: a ref op takes ref, not data.`);
  if (op.component !== undefined) throw invalid(`${where}: a ref op takes no component.`);
  const ref = op.ref;
  if (!((typeof ref === 'string' && ref) || (Number.isInteger(ref) && ref > 0))) throw invalid(`${where}: ref must be a documentId (or, for media, a file documentId or numeric id).`);
  const attrs = M.attrsOf(strapi, uid);
  const a = attrs[op.field];
  if (!a || M.SKIP_KEYS.has(op.field)) throw invalid(`${where}: unknown or read-only field ${op.field}.`);
  const kind = M.fieldKind(a);
  const hasPath = op.path !== undefined && op.path !== null;
  if (kind === 'relation' || kind === 'media') {
    if (hasPath) throw invalid(`${where}: path is for fields inside a component; ${op.field} is a ${kind} field itself.`);
    if (op.key !== undefined) throw invalid(`${where}: key names a row of a list field; ${op.field} is a ${kind} field (leave key out).`);
    const k = checkLeaf(a, op.field, where);
    if (k === 'relation' && typeof ref !== 'string') throw invalid(`${where}: ref must be the related document's documentId (a string).`);
    return { kind: k, attr: a, field: op.field, path: [], container: null };
  }
  if (kind === 'component') {
    if (!hasPath) throw invalid(`${where}: ${op.field} is a component: give path, the to-many relation or multiple media field inside it (e.g. "people").`);
    if (op.key !== undefined) throw invalid(`${where}: ${op.field} is a single component: leave key out.`);
    const p = pathAttr(strapi, a.component, op.path, where);
    return { kind: p.kind, attr: p.attr, field: op.field, path: p.path, container: 'component' };
  }
  if (kind === 'repeatable' || kind === 'dynamiczone') {
    if (!hasPath) throw invalid(`${where}: ${op.field} is a list of rows: give key (the row) and path (the to-many relation or multiple media field inside it).`);
    if (op.key === undefined) throw invalid(`${where}: give key, the row of ${op.field} (from ws_get rows) whose ${segsOf(op.path).join('.')} to edit.`);
    if (kind === 'repeatable') {
      const p = pathAttr(strapi, a.component, op.path, where);
      return { kind: p.kind, attr: p.attr, field: op.field, path: p.path, container: 'repeatable' };
    }
    if (!segsOf(op.path).length) throw invalid(`${where}: path is empty.`);
    return { kind: null, attr: null, field: op.field, path: segsOf(op.path), container: 'dynamiczone' };
  }
  throw invalid(`${where}: ${op.field} is ${kind}; ${LEAF_HINT} (or a component holding one, with path).`);
}

const ident = (x) => x;

/** Index for an add's position in `list` (ids compared through idOf). */
function positionOf(list, pos, idOf) {
  if (pos === undefined || pos === null || pos === 'end') return list.length;
  if (pos === 'start') return 0;
  if (pos && typeof pos === 'object') {
    if (typeof pos.index === 'number') return Math.max(0, Math.min(list.length, pos.index));
    const anchor = pos.before !== undefined ? pos.before : pos.after;
    if (anchor !== undefined) {
      const id = idOf(anchor);
      const i = list.findIndex((x) => idOf(x) === id && id !== undefined);
      if (i < 0) throw invalid('position: the ref in before/after is not linked in this field.');
      return pos.before !== undefined ? i : i + 1;
    }
  }
  throw invalid('position must be "start", "end", {index: n}, {before: ref} or {after: ref}.');
}

/** Apply ref ops to one list (idOf: identity of a ref or item). { list, statuses, changed } */
function applyRefList(current, ops, idOf = ident) {
  const list = Array.isArray(current) ? [...current] : [];
  const before = JSON.stringify(list.map((x) => idOf(x)));
  const statuses = [];
  for (const op of ops) {
    const id = idOf(op.ref);
    const at = list.findIndex((x) => idOf(x) === id);
    if (op.op === 'add') {
      if (at >= 0) { statuses.push('already_linked'); continue; }
      list.splice(positionOf(list, op.position, idOf), 0, id === undefined ? op.ref : id);
      statuses.push('added');
    } else {
      if (at < 0) { statuses.push('not_linked'); continue; }
      list.splice(at, 1);
      statuses.push('removed');
    }
  }
  return { list, statuses, changed: JSON.stringify(list.map((x) => idOf(x))) !== before };
}

/**
 * Ref ops on a top-level relation as connect/disconnect of only the changed links (review M5): { payload | null,
 * statuses, list }. Remove then add again is a move (one connect with its position). Media have no connect form.
 */
function relationOps(current, ops, targetLocale) {
  const original = Array.isArray(current) ? [...current] : [];
  const work = [...original];
  const statuses = [];
  const lastPos = new Map(); // ref -> connect position of its last effective add
  const moved = new Set();
  const removedOnce = new Set();
  const posOf = (pos) => {
    if (pos === undefined || pos === null || pos === 'end') return { end: true };
    if (pos === 'start') return { start: true };
    if (pos && typeof pos === 'object') {
      if (typeof pos.index === 'number') {
        const i = Math.max(0, Math.min(work.length, pos.index));
        return i < work.length ? { before: work[i] } : { end: true };
      }
      if (pos.before !== undefined || pos.after !== undefined) {
        const anchor = pos.before !== undefined ? pos.before : pos.after;
        if (!work.includes(anchor)) throw invalid('position: the ref in before/after is not linked in this field.');
        return pos.before !== undefined ? { before: anchor } : { after: anchor };
      }
    }
    throw invalid('position must be "start", "end", {index: n}, {before: ref} or {after: ref}.');
  };
  for (const op of ops) {
    const at = work.indexOf(op.ref);
    if (op.op === 'add') {
      if (at >= 0) { statuses.push('already_linked'); continue; }
      const p = posOf(op.position);
      lastPos.set(op.ref, p);
      if (removedOnce.has(op.ref)) moved.add(op.ref);
      work.splice(positionOf(work, op.position, ident), 0, op.ref);
      statuses.push('added');
    } else {
      if (at < 0) { statuses.push('not_linked'); continue; }
      work.splice(at, 1);
      removedOnce.add(op.ref);
      lastPos.delete(op.ref);
      statuses.push('removed');
    }
  }
  const ref = (d) => (targetLocale ? { documentId: d, locale: targetLocale } : { documentId: d });
  const disconnect = original.filter((d) => !work.includes(d)).map(ref);
  const connect = work.filter((d) => !original.includes(d) || moved.has(d)).map((d) => ({ ...ref(d), position: lastPos.get(d) || { end: true } }));
  const payload = disconnect.length || connect.length ? { ...(disconnect.length ? { disconnect } : {}), ...(connect.length ? { connect } : {}) } : null;
  return { payload, statuses, list: work };
}

/** Ref ops on the list at `path` in one row (copies on the path keep their ids; missing components are created). */
function applyRefInRow(strapi, cuid, row, path, ops, idOf = ident) {
  const segs = segsOf(path);
  const out = row && typeof row === 'object' ? { ...row } : {};
  let node = out;
  for (const s of segs.slice(0, -1)) {
    node[s] = node[s] && typeof node[s] === 'object' ? { ...node[s] } : {};
    node = node[s];
  }
  const leaf = segs[segs.length - 1];
  const r = applyRefList(node[leaf] || [], ops, idOf);
  node[leaf] = r.list;
  return { row: out, statuses: r.statuses, changed: r.changed };
}

/** A value as compared for "did this nested list change": component ids and keys dropped, references as refs. */
function semantic(strapi, attr, v, depth = 0) {
  if (v == null || depth > 10) return v === undefined ? null : v;
  if (attr.type === 'relation' || attr.type === 'media') {
    const refOf = (x) => (x && typeof x === 'object' ? (x.documentId ?? x.id) : x);
    return Array.isArray(v) ? v.map(refOf) : refOf(v);
  }
  if (attr.type === 'component') {
    const row = (r) => {
      if (!r || typeof r !== 'object') return r;
      const m = strapi.components[attr.component];
      const o = {};
      for (const [k, x] of Object.entries(r)) {
        if (k === 'id' || k === '_key') continue;
        const a = m && m.attributes ? m.attributes[k] : null;
        o[k] = a ? semantic(strapi, a, x, depth + 1) : x;
      }
      return o;
    };
    return attr.repeatable ? (Array.isArray(v) ? v.map(row) : v) : row(v);
  }
  return v;
}

const isNestedList = (a) => Boolean(a) && ((a.type === 'component' && a.repeatable) || isToManyRel(a) || isMultiMedia(a) || a.type === 'blocks');

/** Does component `cuid` hold a list (to-many relation, multiple media, repeatable, blocks), also in nested single components? */
function hasNestedList(strapi, cuid, depth = 0) {
  const m = strapi.components && strapi.components[cuid];
  if (!m || depth > 8) return false;
  return Object.values(m.attributes || {}).some((a) => isNestedList(a) || (a.type === 'component' && !a.repeatable && hasNestedList(strapi, a.component, depth + 1)));
}

/** Paths of nested lists `data` would replace with a different value than `cur` (echoes and new components: none). */
function nestedListChanges(strapi, cuid, data, cur, prefix, depth = 0) {
  const out = [];
  if (!data || typeof data !== 'object' || !cur || typeof cur !== 'object' || depth > 8) return out;
  const m = strapi.components[cuid];
  const attrs = (m && m.attributes) || {};
  for (const [k, v] of Object.entries(data)) {
    const a = attrs[k];
    if (!a) continue;
    const p = `${prefix}.${k}`;
    if (isNestedList(a)) {
      if (M.canonical(semantic(strapi, a, v === undefined ? null : v)) !== M.canonical(semantic(strapi, a, cur[k] === undefined ? null : cur[k]))) out.push(p);
    } else if (a.type === 'component' && !a.repeatable && v && typeof v === 'object') {
      out.push(...nestedListChanges(strapi, a.component, v, cur[k], p, depth + 1));
    } else if (a.type === 'component' && !a.repeatable && v === null && cur[k] != null && hasNestedList(strapi, a.component)) {
      // clearing a nested single component drops every list inside it (review L1)
      out.push(p);
    }
  }
  return out;
}

module.exports = {
  setErrorClass, isRefOp, refTarget, pathAttr, applyRefList, applyRefInRow, relationOps, nestedListChanges, hasNestedList, segsOf, isNestedList,
};
