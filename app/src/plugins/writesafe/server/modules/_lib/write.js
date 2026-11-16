'use strict';

/**
 * Shared by the localize and history modules (this folder has no index.js, so the module registry skips it).
 *
 * writeFields(): write a set of whole field values to one draft (or create a missing locale of a document) with the
 * same checks ws_patch makes: the token's create/update permission on the entity and on every component sub-field the
 * write changes, Strapi's sanitizer (a dropped field refuses the whole write), creator fields, and the modules'
 * beforeWrite/afterWrite hooks (so the history module records the before-image). It must run inside a write
 * transaction (api.runWrite) with the target row already locked by the caller.
 *
 * Unlike ws_patch it takes complete field values, so it can carry media and relations inside components (localize
 * copies them from the source locale; undo puts back what was there). Rows that keep their `id` keep their identity.
 */
const { setCreatorFields } = require('@strapi/utils');
const M = require('../../model');
const MOD = require('..');
const L = require('./locales');

const same = (x, y) => M.canonical(x) === M.canonical(y);

/**
 * Leaf permission paths ("seo.metaTitle", "items.qty", "items.meta.note") whose values `data` changes against `prev`.
 * Nested components are followed down to their leaf fields, because permission fields name leaves only.
 */
function changedSubPaths(strapi, uid, data, prev) {
  const attrs = M.attrsOf(strapi, uid);
  const paths = new Set();
  // Clearing a component or dropping rows changes every leaf the old value had (same rule as the engine).
  const gone = (prefix, cuid, rows, keepIds) => { for (const r of rows || []) if (!keepIds.has(r && r.id)) visit(prefix, cuid, r, undefined); };
  const visit = (prefix, cuid, row, cur) => {
    const ca = M.attrsOf(strapi, cuid);
    for (const [k, v] of Object.entries(row || {})) {
      if (k === 'id' || k === '_key' || k === '__component') continue;
      const a = ca[k];
      const path = `${prefix}.${k}`;
      if (a && a.type === 'component') {
        if (!a.repeatable) { if (v != null) visit(path, a.component, v, cur && cur[k]); else if (cur && cur[k] != null) visit(path, a.component, Object.fromEntries(Object.keys(cur[k]).map((x) => [x, null])), cur[k]); continue; }
        const byId = new Map(((cur && cur[k]) || []).map((r) => [r.id, r]));
        for (const r of v || []) visit(path, a.component, r, r && r.id != null ? byId.get(r.id) : undefined);
        gone(path, a.component, cur && cur[k], new Set((v || []).map((r) => r && r.id).filter((x) => x != null)));
        continue;
      }
      if (!cur || !same(v, cur[k])) paths.add(path);
    }
  };
  for (const [f, v] of Object.entries(data)) {
    const a = attrs[f];
    if (!a || a.type !== 'component') continue;
    const was = prev && prev[f];
    if (!a.repeatable) {
      if (v != null) visit(f, a.component, v, was);
      else if (was != null) visit(f, a.component, was, undefined);
    } else {
      const byId = new Map((was || []).map((r) => [r.id, r]));
      for (const r of v || []) visit(f, a.component, r, r && r.id != null ? byId.get(r.id) : undefined);
      gone(f, a.component, was, new Set((v || []).map((r) => r && r.id).filter((x) => x != null)));
    }
  }
  return [...paths];
}

/**
 * Write `data` (field -> complete value, relations as documentIds, media as ids) to the draft of uid/documentId/locale.
 * raw: the current raw draft (read under lock), or null to create the locale.
 * Returns { raw: updatedRaw, doc: normalized }.
 */
async function writeFields(strapi, ctx, E, { tool, action, uid, documentId, locale, raw, data, args, dryRun, creators }) {
  const pc = E.permissionChecker(strapi, ctx, uid);
  const creating = !raw;
  if (creating ? pc.cannot.create({ locale }) : pc.cannot.update(raw)) {
    throw new E.WsError({ code: 'forbidden', message: `This token cannot ${creating ? 'create' : 'update'} ${uid} ${documentId}${locale ? ` (locale ${locale})` : ''}.` });
  }
  const prev = raw ? M.normalize(strapi, uid, raw) : null;
  const subs = changedSubPaths(strapi, uid, data, prev);
  // Permission fields name component sub-fields ("items.qty"), not the component field itself; zones are per field.
  const attrs = M.attrsOf(strapi, uid);
  const leaf = Object.keys(data).filter((k) => !attrs[k] || attrs[k].type !== 'component');
  const denied = [...leaf, ...subs].filter((p) => (creating ? pc.cannot.create({ locale }, p) : pc.cannot.update(raw, p)));
  if (denied.length) throw new E.WsError({ code: 'forbidden', message: `This token cannot write field(s): ${denied.join(', ')}. Nothing was written.` });
  const sanitized = creating ? await pc.sanitizeCreateInput(data) : await pc.sanitizeUpdateInput(raw)(data);
  const dropped = Object.keys(data).filter((k) => !(k in (sanitized || {})));
  if (dropped.length) throw new E.WsError({ code: 'forbidden', message: `This token cannot write field(s): ${dropped.join(', ')}. Nothing was written.` });
  const payload = setCreatorFields({ user: ctx.user, isEdition: !creating })(sanitized);
  if (creating && creators && creators.createdBy != null) payload.createdBy = creators.createdBy; // ws_undo of a delete
  if (creating && creators && creators.updatedBy != null) payload.updatedBy = creators.updatedBy;
  const info = { tool, action: creating ? 'create' : action || 'patch', uid, documentId, locale: locale || null, args, dryRun: Boolean(dryRun) };
  await MOD.beforeWrite(ctx, info);
  const updatedRaw = await strapi.documents(uid).update({
    documentId, ...(locale ? { locale } : {}), data: await E.MEDIA.toFileIds(strapi, uid, payload, (m) => { throw new E.WsError({ code: 'invalid', message: `File(s) ${m.join(', ')} are no longer in the media library, so this write cannot put them back. Nothing was written.`, files: m }); }), populate: M.populateFor(strapi, uid),
  });
  if (!updatedRaw) throw new E.WsError({ code: 'not_found', message: `No ${uid} document ${documentId} to write${locale ? ` locale ${locale} to` : ''}.` });
  const doc = M.normalize(strapi, uid, updatedRaw);
  info.versions = { before: raw ? M.versionOf(strapi, uid, raw) : null, after: M.versionOf(strapi, uid, updatedRaw) };
  await MOD.afterWrite(ctx, info, prev, doc);
  return { raw: updatedRaw, doc };
}

/** Delete the draft (and published version) of one locale, or of the whole document for a type without i18n. */
async function deleteLocale(strapi, ctx, E, { tool, uid, documentId, locale, raw, args, dryRun }) {
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.delete(raw)) throw new E.WsError({ code: 'forbidden', message: `This token cannot delete ${uid} ${documentId}${locale ? ` (locale ${locale})` : ''}.` });
  const info = { tool, action: 'delete', uid, documentId, locale: locale || null, args, dryRun: Boolean(dryRun) };
  await MOD.beforeWrite(ctx, info);
  const prev = M.normalize(strapi, uid, raw);
  // A dry run (ws_undo of a create) does not call Strapi's delete, so no middleware or lifecycle hook runs (phase 2 item 10).
  if (!dryRun) await strapi.documents(uid).delete({ documentId, ...(locale ? { locale } : {}) });
  await MOD.afterWrite(ctx, info, prev, null);
  return prev;
}

/**
 * Lock every draft row of a document (all locales), so a write that may create a locale queues behind any other
 * write to the same document instead of both seeing "no such locale" (SQLite: the transaction serialises writers).
 * The one ordered lock (compat/db.js lockDocuments).
 */
async function lockDocument(strapi, uid, documentId, hasDP) {
  await require('../../compat/db').lockDocuments(strapi, [{ uid, documentId }]);
}

/** Remove component ids at every depth (rows that are recreated must not point at deleted component rows). */
function stripIds(strapi, uid, value, attrsOverride) {
  const attrs = attrsOverride || M.attrsOf(strapi, uid);
  const row = (cuid, r) => {
    if (!r || typeof r !== 'object') return r;
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'id') continue;
      const a = M.attrsOf(strapi, cuid)[k];
      out[k] = a ? stripValue(a, v) : v;
    }
    return out;
  };
  const stripValue = (a, v) => {
    if (v == null) return v;
    if (a.type === 'component') return a.repeatable ? v.map((r) => row(a.component, r)) : row(a.component, v);
    if (a.type === 'dynamiczone') return v.map((r) => row(r.__component, r));
    return v;
  };
  const out = {};
  for (const [k, v] of Object.entries(value || {})) out[k] = attrs[k] ? stripValue(attrs[k], v) : v;
  return out;
}

/**
 * Recreate a deleted draft (undo of a delete). With another locale of the document still there, the locale is created
 * through the Document Service (Strapi fills the non-localized fields from that sibling, so only localized fields are
 * sent and the other locales are not touched). With nothing left, the document is created again with its documentId.
 */
async function recreate(strapi, ctx, E, { tool, uid, documentId, locale, raw, data, args, dryRun, creators }) {
  if (raw) return writeFields(strapi, ctx, E, { tool, action: 'patch', uid, documentId, locale, raw, data, args, dryRun });
  const sibling = await strapi.db.query(uid).findOne({ select: ['id'], where: { documentId } });
  if (sibling) {
    const own = L.localizedOnly(strapi, uid, data);
    return writeFields(strapi, ctx, E, { tool, action: 'create', uid, documentId, locale, raw: null, data: own, args, dryRun, creators });
  }
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.create(locale ? { locale } : undefined)) throw new E.WsError({ code: 'forbidden', message: `This token cannot create ${uid}.` });
  const attrs = M.attrsOf(strapi, uid);
  const leaf = Object.keys(data).filter((k) => !attrs[k] || attrs[k].type !== 'component');
  const denied = [...leaf, ...changedSubPaths(strapi, uid, data, null)].filter((p) => pc.cannot.create(locale ? { locale } : undefined, p));
  if (denied.length) throw new E.WsError({ code: 'forbidden', message: `This token cannot write field(s): ${denied.join(', ')}. Nothing was written.` });
  const sanitized = await pc.sanitizeCreateInput(data);
  const dropped = Object.keys(data).filter((k) => !(k in (sanitized || {})));
  if (dropped.length) throw new E.WsError({ code: 'forbidden', message: `This token cannot write field(s): ${dropped.join(', ')}. Nothing was written.` });
  const payload = setCreatorFields({ user: ctx.user })(sanitized);
  // ws_undo of a delete: the document comes back under its original creator and editor, not the undoer's
  if (creators && creators.createdBy != null) payload.createdBy = creators.createdBy;
  if (creators && creators.updatedBy != null) payload.updatedBy = creators.updatedBy;
  const info = { tool, action: 'create', uid, documentId, locale: locale || null, args, dryRun: Boolean(dryRun) };
  await MOD.beforeWrite(ctx, info);
  // The Document Service makes a new documentId on create; the entity layer keeps one given in data (Strapi's own
  // clone() relies on that), so the document comes back under its old id.
  const created = await strapi.documents(uid).create({ ...(locale ? { locale } : {}), data: { ...(await E.MEDIA.toFileIds(strapi, uid, payload, (m) => { throw new E.WsError({ code: 'invalid', message: `File(s) ${m.join(', ')} are no longer in the media library, so this write cannot put them back. Nothing was written.`, files: m }); })), documentId }, populate: M.populateFor(strapi, uid) });
  const doc = M.normalize(strapi, uid, created);
  await MOD.afterWrite(ctx, { ...info, documentId: doc.documentId, versions: { before: null, after: M.versionOf(strapi, uid, created) } }, null, doc);
  return { raw: created, doc };
}

module.exports = { writeFields, deleteLocale, recreate, lockDocument, changedSubPaths, stripIds, same };
