'use strict';

/**
 * localize module (config.modules.localize = true): ws_localize.
 *
 * Creates or updates one target locale of a document from the source locale's structure. The agent supplies only
 * translated text, keyed by the paths ws_localize lists in plan mode (call it without `translations`); the plugin
 * copies everything else (rows, order, component types, media, mapped relations) and never touches non-localized
 * fields or other locales. It does not call any language model: translation is the agent's job.
 *
 * Contract (same as the other ws_* writes): one transaction, row locks on the source and target drafts (taken in
 * locale order), version tokens (expected_source_version is required; expected_version for an existing target),
 * the token's create/update permission on the target and its read permission on the source, isError with structured
 * codes, idempotency_key, dry_run (with the full resulting diff) and a compact receipt.
 */
const M = require('../../model');
const W = require('../_lib/write');
const L = require('../_lib/locales');
const B = require('./build');
const LK = require('./links');

const PLAN_HINT = 'Translate each unit\'s `source` and send them as translations: {"<path>": "<text>"} with expected_source_version '
  + '(and expected_version when the target locale exists). Units you leave out keep the target\'s text, or the source text in a new row.';
const AMBIGUOUS_HINT = ' Some rows cannot be paired safely (ambiguous_rows): compare the source and target text of those rows, then send '
  + 'row_map: {"<list path>": {"<source row>": "<target row>" or null for a new row}} with the write (`proposed` is only an order-based guess).';
const KEPT_HINT = ' target_only_rows exist only in the target locale and are kept; send remove_extra_rows: true only if they should be deleted.';

async function readDraftOrNull(strapi, E, uid, documentId, locale) {
  try {
    return await E.lockAndRead(strapi, uid, documentId, locale);
  } catch (err) {
    if (err instanceof E.WsError && err.payload.code === 'not_found') return null;
    throw err;
  }
}

/** Leaf diff of two presented documents (ws_get views): fields, and list rows by key. */
function diffViews(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    if (M.canonical(b ?? null) === M.canonical(a ?? null)) continue;
    const isRows = (v) => Array.isArray(v) && v.every((r) => r && typeof r === 'object' && '_key' in r);
    if (isRows(b ?? []) && isRows(a ?? []) && (b || a)) {
      // rows by identity: keys carry a content MAC (1.0 hardening item 16b), so a changed row has a new key
      const id = (r) => M.keyIdentity(r._key);
      const bm = new Map((b || []).map((r) => [id(r), r]));
      const am = new Map((a || []).map((r) => [id(r), r]));
      const d = { added: [], removed: [], changed: {} };
      for (const [key, r] of am) {
        if (!bm.has(key)) d.added.push(r);
        else if (M.canonical(r) !== M.canonical(bm.get(key))) {
          const c = {};
          for (const f of new Set([...Object.keys(r), ...Object.keys(bm.get(key))])) {
            if (M.canonical(r[f] ?? null) !== M.canonical(bm.get(key)[f] ?? null)) c[f] = { before: bm.get(key)[f] ?? null, after: r[f] ?? null };
          }
          d.changed[bm.get(key)._key] = c; // the key the agent read (the row's key changes with its content)
        }
      }
      for (const [key, r] of bm) if (!am.has(key)) d.removed.push(r._key);
      d.order = (a || []).map((r) => r._key);
      out[k] = d;
    } else out[k] = { before: b ?? null, after: a ?? null };
  }
  return out;
}

async function resolve(strapi, E, a) {
  const { uid } = a;
  E.checkUid(strapi, uid);
  if (!L.isLocalizedType(strapi, uid)) throw new E.WsError({ code: 'invalid', message: `${uid} is not localized (no i18n); ws_localize works on localized types.` });
  const sourceLocale = await E.resolveLocale(strapi, uid, a.source_locale);
  if (!a.locale) throw new E.WsError({ code: 'invalid', message: 'locale (the target locale) is required.' });
  const locale = await E.resolveLocale(strapi, uid, a.locale);
  if (locale === sourceLocale) throw new E.WsError({ code: 'invalid', message: `The target locale ${locale} is the source locale; pick another target (source_locale defaults to the default locale).` });
  const documentId = await E.resolveDocumentId(strapi, uid, a.documentId, sourceLocale);
  return { uid, sourceLocale, locale, documentId };
}

async function prepare(strapi, ctx, E, a, lock) {
  const { uid, sourceLocale, locale, documentId } = await resolve(strapi, E, a);
  const read = lock ? (l) => readDraftOrNull(strapi, E, uid, documentId, l) : async (l) => strapi.documents(uid).findOne({
    documentId, locale: l, ...(E.hasDP(strapi, uid) ? { status: 'draft' } : {}), populate: M.populateFor(strapi, uid),
  });
  // Every locale row of the document is locked first, so two calls that would both create the target locale queue:
  // the second then finds the first one's locale and needs its expected_version (review finding 3).
  if (lock) await W.lockDocument(strapi, uid, documentId, E.hasDP(strapi, uid));
  const got = {};
  for (const l of [sourceLocale, locale].sort()) got[l] = await read(l);
  const srcRaw = got[sourceLocale];
  const tgtRaw = got[locale];
  if (!srcRaw) throw new E.WsError({ code: 'not_found', message: `No ${uid} draft ${documentId} in the source locale ${sourceLocale}.`, documentId, locale: sourceLocale });
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.read(srcRaw)) throw new E.WsError({ code: 'forbidden', message: `This token cannot read ${uid} ${documentId} in ${sourceLocale}.` });
  // Built from what the token may read: a field it cannot read is neither shown nor copied.
  const src = M.normalize(strapi, uid, await pc.sanitizeOutput(srcRaw));
  const tgt = tgtRaw ? M.normalize(strapi, uid, tgtRaw) : null;
  // What the plan may show of the target: only what this token can read there (it may be limited to some locales).
  const tgtVisible = tgtRaw && !pc.cannot.read(tgtRaw) ? M.normalize(strapi, uid, await pc.sanitizeOutput(tgtRaw)) : null;
  return { uid, sourceLocale, locale, documentId, srcRaw, tgtRaw, src, tgt, tgtVisible, pc, sourceVersion: E.versionOfRaw(strapi, uid, srcRaw), targetVersion: tgtRaw ? E.versionOfRaw(strapi, uid, tgtRaw) : null };
}

const opts = (strapi, a, p, translations, links) => ({
  strapi, translations: translations || {}, targetLocale: p.locale, relations: a.relations || 'map', copyNonText: Boolean(a.copy_non_text),
  // phase 2 item 12: the explicit row map (recorded links, the caller's row_map) and target-only rows
  links, rowMap: a.row_map, removeExtraRows: Boolean(a.remove_extra_rows),
});

/** buildTarget with its row-map errors as WsErrors. */
async function build(E, o, uid, src, tgt) {
  try {
    return await B.buildTarget(o, uid, src, tgt);
  } catch (e) {
    if (e instanceof B.MapError) throw new E.WsError({ code: 'invalid', message: `${e.message} Nothing was written.`, ...e.extra });
    throw e;
  }
}

const linksOf = (strapi, p) => (p.tgtRaw ? LK.read(strapi, p.uid, p.documentId, p.sourceLocale, p.locale) : new Map());

/** Plan mode: the text units to translate, with the versions to send back. Read-only. */
async function plan(strapi, ctx, E, a) {
  const p = await prepare(strapi, ctx, E, a, false);
  const b = await build(E, opts(strapi, a, p, undefined, await linksOf(strapi, p)), p.uid, p.src, p.tgtVisible);
  const units = b.units.map((u) => ({ path: u.path, source: u.source, ...(u.value !== u.source ? { current: u.value } : {}) }));
  const out = {
    mode: 'plan', documentId: p.documentId, source_locale: p.sourceLocale, locale: p.locale,
    source_version: p.sourceVersion, target_exists: Boolean(p.tgt), target_version: p.tgtVisible ? p.targetVersion : null,
    units, untranslated: b.units.filter((u) => u.untranslated).length,
  };
  if (Object.keys(b.rows).length) out.rows = b.rows;
  if (p.tgtVisible && Object.keys(b.rowMap).length) out.row_map = b.rowMap;
  if (b.ambiguous.length) out.ambiguous_rows = b.ambiguous;
  if (b.targetOnly.length) out.target_only_rows = b.targetOnly;
  if (b.unmapped.length) out.unmapped_relations = b.unmapped;
  out.next = PLAN_HINT + (b.ambiguous.length ? AMBIGUOUS_HINT : '') + (b.targetOnly.some((x) => x.action === 'keep') ? KEPT_HINT : '');
  return out;
}

async function applyLocalize(strapi, ctx, E, a) {
  E.assertVersion(a.expected_source_version, 'expected_source_version');
  E.assertVersion(a.expected_version);
  const p = await prepare(strapi, ctx, E, a, true);
  // Checked up front, so a call that would change nothing is refused the same way as one that would.
  if (p.tgt ? p.pc.cannot.update(p.tgtRaw) : p.pc.cannot.create({ locale: p.locale })) {
    throw new E.WsError({ code: 'forbidden', message: `This token cannot ${p.tgt ? 'update' : 'create'} ${p.uid} ${p.documentId} in locale ${p.locale}.` });
  }
  if (!M.versionMatches(strapi, p.uid, a.expected_source_version, p.srcRaw)) {
    // No source version in this reply (1.0 hardening item 1): it carries none of the source text, so the version would
    // stand for text the agent has not seen. The plan returns both.
    throw new E.WsError({
      code: 'version_conflict', message: `The source locale ${p.sourceLocale} changed after you read it. Nothing was written.`,
      documentId: p.documentId, locale: p.sourceLocale, expected_version: a.expected_source_version,
      retry: { hint: 'Call ws_localize without translations (plan) to get the current source text, paths and source_version, translate what changed, and send that source_version.' },
    });
  }
  if (p.tgt) {
    if (a.expected_version !== undefined && !M.versionMatches(strapi, p.uid, a.expected_version, p.tgtRaw)) {
      throw await E.conflict(strapi, p.pc, p.uid, p.tgtRaw, a.expected_version, { message: `The target locale ${p.locale} changed after you read it. Nothing was written.` }, 'localize');
    }
    if (a.expected_version === undefined && !a.force) {
      throw new E.WsError({
        code: 'precondition_required', locale: p.locale,
        message: `The ${p.locale} locale already exists: call ws_localize without translations (plan) and send its target_version as expected_version, so a colleague's edit there is not overwritten. Nothing was written.`,
      });
    }
  }
  const b = await build(E, opts(strapi, a, p, a.translations, await linksOf(strapi, p)), p.uid, p.src, p.tgt);
  if (b.ambiguous.length) {
    throw new E.WsError({
      code: 'ambiguous_rows', ambiguous: b.ambiguous,
      message: `The ${p.locale} locale has rows that cannot be paired with the source's rows safely: ${b.ambiguous.map((x) => `${x.field} (${x.component})`).join(', ')} `
        + 'have several rows of the same component type and no recorded pairing, so text, media and links could land on the wrong section. '
        + 'Compare the source and target text of those rows (the plan shows both), then send row_map: {"<list path>": {"<source row>": "<target row>" or null for a new row}}. Nothing was written.',
    });
  }
  const unknown = Object.keys(a.translations || {}).filter((k) => !b.used.has(k));
  if (unknown.length) {
    throw new E.WsError({
      code: 'invalid', message: `Unknown translation path(s): ${unknown.slice(0, 20).join(', ')}${unknown.length > 20 ? ` (+${unknown.length - 20} more)` : ''}. Nothing was written. Use the paths from plan mode (ws_localize without translations); only text values can be translated.`,
      unknown_paths: unknown.slice(0, 50),
    });
  }
  let doc = p.tgt;
  let written = null;
  if (Object.keys(b.data).length) {
    written = await W.writeFields(strapi, ctx, E, {
      tool: 'ws_localize', action: 'patch', uid: p.uid, documentId: p.documentId, locale: p.locale, raw: p.tgtRaw, data: b.data, args: a, dryRun: a.dry_run,
    });
    doc = written.doc;
  }
  // Record which target row each source row now lives in (phase 2 item 12), in this transaction.
  if (!a.dry_run) await LK.write(strapi, p.uid, p.documentId, p.sourceLocale, p.locale, B.linksAfterWrite(strapi, p.uid, b, doc), doc);
  const untranslated = b.units.filter((u) => u.untranslated).map((u) => u.path);
  // The source as it is now, re-read inside this transaction (1.0 hardening items 12 and 15; Phase 0 N13): creating a
  // locale makes Strapi's i18n sync recreate the source's non-localized component rows. The semantic version does not
  // move for that, and the re-read makes sure the receipt describes the source this transaction commits.
  let sourceVersion = p.sourceVersion;
  if (written) {
    const fresh = await strapi.documents(p.uid).findOne({
      documentId: p.documentId, locale: p.sourceLocale, ...(E.hasDP(strapi, p.uid) ? { status: 'draft' } : {}), populate: M.populateFor(strapi, p.uid),
    });
    if (fresh) sourceVersion = E.versionOfRaw(strapi, p.uid, fresh);
  }
  const receipt = {
    ok: true, documentId: p.documentId, locale: p.locale, source_locale: p.sourceLocale, source_version: sourceVersion,
    created: !p.tgt, previous_version: p.targetVersion, version: written ? E.versionOfRaw(strapi, p.uid, written.raw) : (p.tgtRaw ? E.versionOfRaw(strapi, p.uid, p.tgtRaw) : null),
    changed: Object.keys(b.data), translated: b.units.filter((u) => u.given).length, units: b.units.length,
    untranslated_count: untranslated.length,
  };
  if (untranslated.length) receipt.untranslated = untranslated.slice(0, 50);
  if (Object.keys(b.rows).length) receipt.rows = b.rows;
  if (b.unmapped.length) receipt.unmapped_relations = b.unmapped;
  if (a.dry_run || a.return === 'full') {
    const view = async (raw) => (raw ? M.presentDoc(strapi, p.uid, await p.pc.sanitizeOutput(raw), undefined, { full: raw }).data : null);
    const after = written ? await view(written.raw) : await view(p.tgtRaw);
    if (a.dry_run) receipt.diff = diffViews(await view(p.tgtRaw), after);
    if (a.return === 'full') receipt.document = after;
  }
  return receipt;
}

module.exports = {
  name: 'localize',
  tools(strapi, api) {
    const { z, lenient: Lz } = api;
    const E = api.engine;
    const localized = E.writableUids(strapi).filter((u) => L.isLocalizedType(strapi, u));
    if (!localized.length) {
      strapi.log.info('[writesafe] localize: no localized api:: content types; ws_localize not registered');
      return [];
    }
    return [{
      name: 'ws_localize',
      title: 'Write-safe: create or update a locale from the source locale\'s structure',
      description: 'Translate a document safely. 1) Call without `translations` (plan): get every text unit of the source locale as '
        + '{path, source}, plus source_version and target_version. 2) Call with translations {path: text}: the plugin creates or updates '
        + 'the target locale from the source\'s structure (rows, order, component types, media, relations mapped to the target locale) and '
        + 'writes only your text into it; non-localized fields and other locales are never touched. On an update each source row is paired with '
        + 'its own target row (the plan shows row_map); rows that cannot be paired safely are listed as ambiguous_rows and the write is refused until '
        + 'you send row_map; rows only in the target are kept unless remove_extra_rows. Refused if the source changed since '
        + 'you read it (expected_source_version), or the target did (expected_version). Unknown paths are refused; the receipt lists '
        + 'untranslated units left. dry_run returns the full diff. No language model is called: you translate.',
      auth: api.policies('plugin::content-manager.explorer.update'),
      resolveInputSchema: () => api.strict({
        uid: z.enum(localized).describe('A localized content type UID.'),
        documentId: z.string().optional().describe('Required for collection types.'),
        locale: z.string().describe('Target locale to create or update, e.g. fr.'),
        source_locale: z.string().optional().describe('Locale to copy the structure and source text from (default: the default locale).'),
        translations: Lz.obj(z.object({}).catchall(z.string())).optional()
          .describe('Translated text by unit path from plan mode, e.g. {"title": "…", "sections[0:blocks.hero].heading": "…"}. Leave out to get the plan.'),
        expected_source_version: z.string().optional().describe('source_version from the plan (or `version` of ws_get on the source locale). Required with translations.'),
        expected_version: z.string().optional().describe('target_version from the plan when the target locale exists.'),
        relations: z.enum(['map', 'skip']).optional().describe('map (default): link the related documents\' target-locale versions (missing ones are reported, not linked). skip: do not copy relations.'),
        copy_non_text: Lz.bool(z.boolean()).optional().describe('Update only: also copy media, enumerations, numbers and relations from the source into rows the target already has (default: keep the target\'s own).'),
        row_map: Lz.obj(z.object({}).catchall(z.object({}).catchall(z.string().nullable()))).optional()
          .describe('Update only: which target row each source row belongs to, per list path: {"sections": {"<source row>": "<target row>" or null for a new row}}. Needed when the plan lists ambiguous_rows; rows are the keys the plan shows.'),
        remove_extra_rows: Lz.bool(z.boolean()).optional().describe('Update only: delete the target rows that have no source row (target_only_rows in the plan). Default: they are kept.'),
        ...api.forceArg('Update an existing target locale without expected_version (last write wins).'), // config.allowForce only
        dry_run: Lz.bool(z.boolean()).optional().describe('Run the whole write and roll it back; the reply has the full diff. Strapi lifecycle hooks and Document Service middlewares do run during it (their database work is rolled back; webhooks are not sent).'),
        idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request.'),
        return: z.enum(['receipt', 'full']).optional().describe('receipt (default) or full: also return the written locale.'),
        ...api.engine.MOD.writeArgs(z),
      }),
      resolveOutputSchema: () => z.object({}).passthrough(),
      createHandler: (s, context) => async ({ args, extra }) => {
        try {
          if (args.translations === undefined) return api.ok(await plan(strapi, context, E, args));
          if (!args.expected_source_version) {
            return api.fail({ ok: false, error: { code: 'precondition_required', message: 'expected_source_version is required with translations: use source_version from the plan, so text translated from an older source is not written.' } });
          }
          return api.ok(await api.runWrite(context, 'ws_localize', { ...args, locale: args.locale }, () => applyLocalize(strapi, context, E, args), extra));
        } catch (e) {
          return api.fail(api.errorOf(e));
        }
      },
    }];
  },
};

module.exports.diffViews = diffViews;
