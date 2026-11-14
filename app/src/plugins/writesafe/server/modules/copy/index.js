'use strict';

/**
 * Module `copy`: the `copy` row op for ws_patch (and ws_batch items).
 *
 *   {"op": "copy", "field": "sections", "key": "blocks.hero:505:<mac>"}                  duplicate a row in place (after itself)
 *   {"op": "copy", "field": "sections", "keys": ["blocks.hero:505:<mac>", "blocks.cta:9:<mac>"], "position": "end"}
 *   {"op": "copy", "field": "sections", "key": "blocks.hero:77:<mac>", "from": {"documentId": "abc", "locale": "fr"}}
 *   {"op": "copy", "field": "items", "key": "shared.item:3:<mac>", "from": {"uid": "api::guide.guide", "documentId": "x", "field": "items"}}
 * Keys are the ones ws_get shows for the SOURCE document and field.
 *
 * prepare (async, inside the write transaction, after the target draft is locked and its version checked) reads the
 * source rows: from the target draft itself, or from another document, locale or content type, read with the caller's
 * read permission. A source row with a field the token cannot read is refused (forbidden) instead of being copied
 * without it, and so is a copied sub-field the token may not write. apply (synchronous, in the row-op pass) inserts the
 * copies as NEW rows (no ids; nested components new too; relations kept as documentIds) through the same checks as an
 * `add` (component allowed in the zone, unknown fields, relation targets).
 */
const { z } = require('@strapi/utils');
const E = require('../../engine');
const M = require('../../model');
const U = require('../_bulk/util');

const { WsError } = E;
const prepared = new WeakMap(); // op object -> { rows: [{ cuid, row }], defaultAfter, tkind }

async function source(p) {
  const { strapi, ctx, op } = p;
  const from = op.from || {};
  const suid = from.uid || p.uid;
  const same = suid === p.uid && (!from.documentId || from.documentId === p.documentId)
    && (from.locale === undefined || (from.locale || null) === (p.locale || null));
  if (same) return { uid: suid, documentId: p.documentId, locale: p.locale, raw: p.raw, doc: p.doc, pc: p.pc, inPlace: true, label: 'this document' };
  E.checkUid(strapi, suid);
  const pc = E.permissionChecker(strapi, ctx, suid);
  if (pc.cannot.read()) throw new WsError({ code: 'forbidden', message: `This token cannot read ${suid}, the copy source.` });
  const wantLocale = from.locale !== undefined ? from.locale : (E.isLocalized(strapi, suid) && suid === p.uid ? p.locale : undefined);
  const locale = await E.resolveLocale(strapi, suid, wantLocale || undefined);
  const documentId = from.documentId || await E.resolveDocumentId(strapi, suid, suid === p.uid ? p.documentId : undefined, locale);
  const raw = await strapi.documents(suid).findOne({
    documentId, ...(locale ? { locale } : {}), ...(E.hasDP(strapi, suid) ? { status: 'draft' } : {}), populate: M.populateFor(strapi, suid),
  });
  if (!raw) throw new WsError({ code: 'not_found', message: `Copy source ${suid} ${documentId}${locale ? ` (${locale})` : ''} not found.`, documentId, locale: locale || null });
  if (pc.cannot.read(raw)) throw new WsError({ code: 'forbidden', message: `This token cannot read the copy source ${suid} ${documentId}.` });
  return { uid: suid, documentId, locale: locale || null, raw, doc: M.normalize(strapi, suid, raw), pc, inPlace: false, label: `${suid} ${documentId}${locale ? ` (${locale})` : ''}` };
}

/**
 * Permission paths of the values a new row writes: "items.label", and for a nested component its leaves
 * ("items.meta.note"); Strapi's field permissions name leaves, never the component itself. Empty values are skipped:
 * a new row without them is the same as one with them empty.
 */
function leafPaths(strapi, cuid, row, prefix, depth = 0) {
  const out = [];
  const attrs = M.attrsOf(strapi, cuid);
  for (const [k, v] of Object.entries(row || {})) {
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    const a = attrs[k];
    if (a && a.type === 'component' && depth < 8) {
      for (const r of a.repeatable ? v : [v]) out.push(...leafPaths(strapi, a.component, r, `${prefix}.${k}`, depth + 1));
    } else out.push(`${prefix}.${k}`);
  }
  return out;
}

async function prepare(p) {
  const { strapi, op } = p;
  const where = `copy on ${op.field}`;
  const ta = M.attrsOf(strapi, p.uid)[op.field];
  const tkind = M.fieldKind(ta);
  if (!M.isListKind(tkind)) throw new WsError({ code: 'invalid', message: `${where}: copy applies to dynamic zones, repeatable components and blocks fields.` });
  if (op.key && op.keys) throw new WsError({ code: 'invalid', message: `${where}: give key or keys, not both.` });
  const keys = op.keys || (op.key ? [op.key] : []);
  if (!keys.length) throw new WsError({ code: 'invalid', message: `${where}: give key (or keys) of the row(s) to copy.` });
  if (op.data !== undefined || op.component !== undefined) throw new WsError({ code: 'invalid', message: `${where}: copy takes no data or component; it copies the source row as it is (change the copy with an update op afterwards).` });
  const src = await source(p);
  const sfield = (op.from && op.from.field) || op.field;
  const sa = M.attrsOf(strapi, src.uid)[sfield];
  const skind = M.fieldKind(sa);
  if (!M.isListKind(skind)) throw new WsError({ code: 'invalid', message: `${where}: source field ${sfield} is not a dynamic zone, repeatable component or blocks field of ${src.uid}.` });
  if ((skind === 'blocks') !== (tkind === 'blocks')) throw new WsError({ code: 'invalid', message: `${where}: blocks nodes can only be copied into a blocks field, and component rows only into a zone or repeatable component.` });
  const visibleRaw = await src.pc.sanitizeOutput(src.raw);
  if (!(sfield in visibleRaw)) throw new WsError({ code: 'forbidden', message: `${where}: this token cannot read ${sfield} on ${src.label}.` });
  const vlist = M.normalize(strapi, src.uid, visibleRaw)[sfield] || [];
  const list = src.doc[sfield] || [];
  // The source keys are content-bound like every row key (1.0 hardening item 16b): a source row edited since it was
  // read, or a key from another database, is refused with stale_row_key instead of copying whatever row has that id.
  // keys from the raw rows, as ws_get shows them (a relation's linked locale is in the key; re-review N5)
  const srcKeys = M.rowHandles(strapi, skind, sa, (src.raw && src.raw[sfield]) || list, M.keyScope(src.uid, src.documentId, src.locale || null, sfield));
  const rows = keys.map((k) => {
    const i = srcKeys.indexOf(k);
    if (i < 0) throw E.keyError(srcKeys.map((key) => ({ key, isNew: false })), k, sfield, `${where} (source ${src.label})`);
    const row = list[i];
    if (skind === 'blocks') return { row: JSON.parse(JSON.stringify(row)) };
    const vrow = vlist.find((r) => r && r.id === row.id && (skind !== 'dynamiczone' || r.__component === row.__component));
    // Recursive: a nested component sub-field the token cannot read is refused too (review finding).
    const hidden = vrow ? U.droppedPaths(row, vrow) : Object.keys(row).filter((x) => x !== 'id' && x !== '__component');
    if (hidden.length) throw new WsError({ code: 'forbidden', message: `${where}: this token cannot read ${hidden.map((x) => `${sfield}.${x}`).join(', ')} of row ${k}; it is not copied. Nothing was written.` });
    const cuid = skind === 'dynamiczone' ? row.__component : sa.component;
    if (tkind === 'repeatable' && cuid !== ta.component) throw new WsError({ code: 'invalid', message: `${where}: ${op.field} holds ${ta.component} rows; row ${k} is ${cuid}.` });
    if (tkind === 'dynamiczone' && !ta.components.includes(cuid)) throw new WsError({ code: 'invalid', message: `${where}: ${op.field} accepts ${ta.components.join(', ')}; row ${k} is ${cuid}.` });
    // Empty values are left out: a new row without them is the same row, and the engine's sub-field permission check
    // would otherwise ask for write permission on an empty nested component ("items.meta").
    const body = U.freshRows(strapi, cuid, Object.fromEntries(Object.entries(row).filter(([f, v]) => f !== '__component' && v != null)));
    // Sub-field write permission on the target (zones are permitted per field; repeatable components per sub-field).
    if (tkind === 'repeatable') {
      const denied = leafPaths(strapi, cuid, body, op.field).filter((path) => p.pc.cannot.update(p.raw, path));
      if (denied.length) throw new WsError({ code: 'forbidden', message: `${where}: this token cannot write ${denied.map((f) => `${op.field}.${f}`).join(', ')}. Nothing was written.` });
    }
    return { cuid, row: body };
  });
  prepared.set(op, { rows, defaultAfter: src.inPlace && sfield === op.field ? keys[keys.length - 1] : null, tkind });
}

function apply(o) {
  const st = prepared.get(o.op);
  if (!st) throw new o.WsError({ code: 'invalid', message: `${o.where}: copy was not prepared` });
  let at;
  if (o.op.position !== undefined) at = o.resolvePos(o.op.position);
  else if (st.defaultAfter) at = o.find(st.defaultAfter) + 1;
  else at = o.work.length;
  for (const r of st.rows) {
    let row;
    if (st.tkind === 'blocks') row = r.row;
    else {
      o.checkComponentData(r.cuid, r.row);
      row = st.tkind === 'dynamiczone' ? { __component: r.cuid, ...r.row } : { ...r.row };
    }
    const key = o.newKey();
    o.work.splice(at, 0, { key, row, isNew: true });
    at += 1;
    o.summary.added.push(key);
  }
}

module.exports = {
  name: 'copy',
  ops: {
    copy: {
      schema: {
        keys: z.array(z.string()).min(1).max(100).optional().describe('copy: several row keys to copy, in order (instead of key).'),
        from: z.object({
          documentId: z.string().optional().describe('Source document (default: this one).'),
          locale: z.string().optional().describe('Source locale (default: this one).'),
          uid: z.string().optional().describe('Source content type (default: the same type).'),
          field: z.string().optional().describe('Source field (default: the same field name).'),
        }).strict().optional().describe('op "copy" duplicates the row(s) named by key/keys as new rows (relations kept), at position (default: right after the source when copying within the same field, else the end). '
          + 'from: where the source rows are, when not this document and locale, e.g. {"documentId": "...", "locale": "fr"}.'),
      },
      prepare,
      apply,
    },
  },
};
