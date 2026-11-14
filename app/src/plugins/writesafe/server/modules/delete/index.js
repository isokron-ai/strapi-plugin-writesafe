'use strict';

/**
 * ws_delete: delete a document, or one locale of it, only if it is still the version the caller saw.
 *
 * - expected_version is required (or force: true). For all_locales it is a map {locale: version} that must name every
 *   locale the document has, so a locale someone else added in the meantime is never deleted unseen.
 * - Localized types must name the locale, or say all_locales: true. Nothing is deleted by default.
 * - Idempotent: a document (or locale) that is already gone is answered ok with deleted: false, already_absent: true.
 * - dry_run is a preview: the checks above, and what would be deleted, without calling Strapi's delete (no middleware or
 *   lifecycle hook runs; phase 2 item 10).
 * - The receipt carries what is needed to recreate the deleted draft with ws_create (`recreate`), filtered to what the
 *   token may read; fields it could not read are listed in `recreate_missing`.
 */
const { z } = require('@strapi/utils');
const E = require('../../engine');
const M = require('../../model');
const U = require('../_bulk/util');
const DB = require('../../compat/db');

const { WsError } = E;

async function applyDelete(strapi, ctx, a) {
  const { uid } = a;
  E.checkUid(strapi, uid);
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.delete()) throw new WsError({ code: 'forbidden', message: `This token cannot delete ${uid}.` });
  const localized = E.isLocalized(strapi, uid);
  if (a.all_locales && !localized) throw new WsError({ code: 'invalid', message: `${uid} is not localized; leave out all_locales.` });
  if (a.all_locales && a.locale) throw new WsError({ code: 'invalid', message: 'Give either locale or all_locales, not both.' });
  if (localized && !a.locale && !a.all_locales) {
    throw new WsError({ code: 'invalid', message: `${uid} is localized: name the locale to delete, or set all_locales: true to delete the document in every locale.` });
  }
  const locale = a.all_locales ? undefined : await E.resolveLocale(strapi, uid, a.locale);

  let documentId = a.documentId;
  if (E.isSingle(strapi, uid) && !documentId) {
    const row = await strapi.db.query(uid).findOne({ select: ['documentId'], where: locale ? { locale } : {} });
    if (!row) return { ok: true, deleted: false, already_absent: true, uid, documentId: null, locale: locale || null };
    documentId = row.documentId;
  }
  if (!documentId) throw new WsError({ code: 'invalid', message: `documentId is required for the collection type ${uid}.` });

  // Which locales go: one, or every locale the document has now (locked first, then read).
  // every locale's draft row (the one lock order), also when one locale goes
  const rows = (await DB.lockDocuments(strapi, [{ uid, documentId }], { rows: true })).filter((r) => !locale || r.locale === locale);
  if (!rows.length) return { ok: true, deleted: false, already_absent: true, uid, documentId, locale: locale || null };
  const locales = localized ? [...new Set(rows.map((r) => r.locale))].sort() : [undefined];

  if (!a.force) {
    if (a.expected_version === undefined) {
      // No current_version here (1.0 hardening item 1; fourth review N2): a version handed out without the content it
      // stands for lets an agent delete without ever reading what it deletes.
      throw new WsError({
        code: 'precondition_required',
        message: a.all_locales
          ? 'Deleting needs expected_version: a map {locale: version} naming every locale of the document. Read each locale with ws_get and send the versions you read. Nothing was deleted.'
          : 'Deleting needs expected_version. Read the document with ws_get and send the version you read. Nothing was deleted.',
      });
    }
    if (a.all_locales) {
      if (!a.expected_version || typeof a.expected_version !== 'object' || Array.isArray(a.expected_version)) {
        throw new WsError({ code: 'invalid', message: 'With all_locales, expected_version is a map {locale: version}.' });
      }
      const missing = locales.filter((l) => !(l in a.expected_version));
      if (missing.length) {
        throw new WsError({ code: 'version_conflict', message: `The document also has locale(s) ${missing.join(', ')}, which expected_version does not name. Nothing was deleted.`, locales, retry: { hint: 'Read every locale with ws_get and send all their versions.' } });
      }
      for (const v of Object.values(a.expected_version)) E.assertVersion(v);
    } else if (typeof a.expected_version !== 'string') {
      throw new WsError({ code: 'invalid', message: 'expected_version is a version string (a map only with all_locales).' });
    } else E.assertVersion(a.expected_version);
  }

  const before = [];
  for (const l of locales) {
    const raw = await U.lockAndReadFresh(strapi, uid, documentId, l);
    if (pc.cannot.delete(raw)) throw new WsError({ code: 'forbidden', message: `This token cannot delete ${uid} ${documentId}${l ? ` (${l})` : ''}.` });
    const doc = M.normalize(strapi, uid, raw);
    const expected = a.force ? undefined : (a.all_locales ? a.expected_version[l] : a.expected_version);
    if (expected !== undefined && !M.versionMatches(strapi, uid, expected, raw)) {
      throw await E.conflict(strapi, pc, uid, raw, expected, undefined, { message: `The document${l ? ` (${l})` : ''} changed after you read it. Nothing was deleted.` }, 'delete');
    }
    const visible = await pc.sanitizeOutput(raw);
    const hidden = U.hiddenKeys(doc, M.normalize(strapi, uid, visible)).filter((k) => !M.SKIP_KEYS.has(k));
    const published = E.hasDP(strapi, uid)
      ? Boolean(await strapi.db.query(uid).findOne({ select: ['id'], where: { documentId, ...(l ? { locale: l } : {}), publishedAt: { $notNull: true } } }))
      : null;
    // Relations and media are kept as references (documentIds, file ids): ws_create takes them back.
    before.push({ locale: l || null, version: M.versionOf(strapi, uid, raw), published, data: U.freshDocData(strapi, uid, M.normalize(strapi, uid, visible)), hidden, doc, view: M.normalize(strapi, uid, visible) });
  }

  // A dry run never calls Strapi's delete (phase 2 item 10, N7): its middlewares and lifecycle hooks would run. Everything
  // above (locks, version and permission checks, what would be deleted) is the preview.
  if (!a.dry_run) for (const l of locales) await strapi.documents(uid).delete({ documentId, ...(l ? { locale: l } : {}) });
  // Module hooks (e.g. history: receipt and undo), one per deleted locale. Modules get the token's view.
  let moduleData;
  if (E.MOD.hasAfterWrite()) {
    for (const b of before) {
      const info = {
        tool: 'ws_delete', action: 'delete', uid, documentId, locale: b.locale, args: a, dryRun: Boolean(a.dry_run),
        sanitize: (d) => pc.sanitizeOutput(d), raw: { before: b.doc, after: null },
        versions: { before: b.version, after: null }, // from the raw draft, as ws_get shows it (re-review N7)
      };
      const m = await E.MOD.afterWrite(ctx, info, b.view, null);
      if (m) moduleData = { ...(moduleData || {}), ...m };
    }
  }

  const r = {
    ok: true, deleted: !a.dry_run, ...(a.dry_run ? { would_delete: true, preview: true } : {}), uid, documentId,
    locales: localized ? locales : undefined,
    previous_version: a.all_locales ? Object.fromEntries(before.map((b) => [b.locale, b.version])) : before[0].version,
    was_published: a.all_locales ? Object.fromEntries(before.map((b) => [b.locale, b.published])) : before[0].published,
    recreate: before.map((b) => ({ tool: 'ws_create', args: { uid, ...(b.locale ? { locale: b.locale } : {}), data: b.data } })),
  };
  if (!localized) delete r.locales;
  if (moduleData) r.modules = moduleData;
  const missing = before.flatMap((b) => b.hidden.map((f) => (b.locale ? `${b.locale}:${f}` : f)));
  if (missing.length) r.recreate_missing = missing;
  return r;
}

function toolDef(strapi, h) {
  const L = h.lenient;
  return {
    name: 'ws_delete',
    title: 'Write-safe: delete a document you have read',
    description: 'Delete one document (draft and published), or one locale of it, only if it is still the version you read: expected_version from ws_get is required'
      + `${h.forceAllowed() ? ' (force: true skips the check)' : ''}. Localized types need locale, or all_locales: true with expected_version as {locale: version} for every locale. `
      + 'Already deleted = ok with deleted: false (safe to retry). The receipt includes `recreate`: ws_create arguments that bring the draft back.',
    auth: h.policies(strapi, 'plugin::content-manager.explorer.delete'),
    resolveInputSchema: () => h.strict({
      uid: h.uidSchema(strapi),
      documentId: h.documentIdSchema,
      locale: z.string().optional().describe('Localized types: the one locale to delete. Required unless all_locales is true.'),
      all_locales: L.bool(z.boolean()).optional().describe('Localized types: delete the document in every locale.'),
      expected_version: z.union([z.string(), L.obj(z.object({}).catchall(z.string()))]).optional().describe('`version` from ws_get. With all_locales: {locale: version} for every locale.'),
      ...h.forceArg('Delete without a version check.'), // only with config.allowForce (server/force.js)
      dry_run: L.bool(z.boolean()).optional().describe('Preview: checks the version and permissions of every locale and returns what would be deleted (and `recreate`), but does not call Strapi\'s delete (no lifecycle hooks or middlewares run). Nothing is deleted.'),
      idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request.'),
      ...E.MOD.writeArgs(z), // [integration] e.g. `agent` (history module)
    }),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try { return h.ok(await U.retryStale(() => E.runWrite(strapi, context, 'ws_delete', args, () => applyDelete(strapi, context, args), extra))); } catch (e) { return h.fail(h.errorOf(e)); }
    },
  };
}

module.exports = {
  name: 'delete',
  tools: (strapi, api) => [toolDef(strapi, U.helpers(api), U.settings(strapi))],
  toolDef, applyDelete };
