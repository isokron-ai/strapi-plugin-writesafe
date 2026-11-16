'use strict';

/**
 * ws_create: create one document, optionally as an upsert keyed by a unique field (slug, external id).
 *
 * - Same input shape as ws_patch's `set`: scalars, a single component as an object, repeatable components and dynamic
 *   zones as lists (rows may carry a `_key` from a ws_get read; it is ignored, every row is new), blocks, relations
 *   inside components as documentIds, and top-level relations as documentIds.
 * - unique_by: the field that identifies the document (e.g. "slug" or "externalId"). If a draft with that value exists
 *   in the same locale, nothing is created: the reply is the existing document with existed: true.
 *   Concurrent identical creates are serialised by a transient claim on the value (see util.claim), so exactly one
 *   document is created.
 * - UID fields: a value the caller gives is checked for collisions in the same locale (`uid_conflict`, with a free
 *   suggestion); a missing value is generated from the target field the way the Content Manager does.
 * - Locales: only the locale named (or, when none is named, the default locale, which the receipt reports) is created.
 *   An upsert looks only in that locale; a match in another locale is reported, never turned into a new locale.
 */
const { z, setCreatorFields } = require('@strapi/utils');
const E = require('../../engine');
const M = require('../../model');
const U = require('../_bulk/util');

const { WsError } = E;

let slugify;
try { slugify = require('@sindresorhus/slugify'); } catch { slugify = null; }
const slug = (s, options) => (slugify ? slugify(s, options) : String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));

const UNIQUE_TYPES = new Set(['string', 'uid', 'email', 'integer', 'biginteger']);
const UID_RE = /^[A-Za-z0-9-_.~]*$/;

/** Validate and prepare the data payload (refs collected for an existence check). */
function prepareData(strapi, uid, data, refs) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WsError({ code: 'invalid', message: 'data must be an object of field values.' });
  const attrs = M.attrsOf(strapi, uid);
  const out = {};
  for (const [f, v] of Object.entries(data)) {
    const a = attrs[f];
    if (!a || M.SKIP_KEYS.has(f)) throw new WsError({ code: 'invalid', message: `Unknown or read-only field ${f}`, allowed: Object.keys(attrs).filter((k) => !M.SKIP_KEYS.has(k)) });
    const kind = M.fieldKind(a);
    if (kind === 'repeatable' || kind === 'dynamiczone') {
      if (!Array.isArray(v)) throw new WsError({ code: 'invalid', message: `${f} must be a list of rows.` });
      out[f] = v.map((r, i) => {
        const cuid = kind === 'dynamiczone' ? r?.__component : a.component;
        if (kind === 'dynamiczone' && !a.components.includes(cuid)) throw new WsError({ code: 'invalid', message: `${f}[${i}].__component must be one of ${a.components.join(', ')}` });
        const body = kind === 'dynamiczone' ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== '__component')) : r;
        E.checkComponentData(strapi, cuid, body, `data.${f}[${i}]`, refs);
        const fresh = U.freshRows(strapi, cuid, body);
        return kind === 'dynamiczone' ? { __component: cuid, ...fresh } : fresh;
      });
    } else if (kind === 'component') {
      if (v === null) { out[f] = null; continue; }
      E.checkComponentData(strapi, a.component, v, `data.${f}`, refs);
      out[f] = U.freshRows(strapi, a.component, v);
    } else if (kind === 'blocks') {
      if (v !== null && !Array.isArray(v)) throw new WsError({ code: 'invalid', message: `${f} is a blocks field: give a list of nodes.` });
      out[f] = v;
    } else if (kind === 'relation' || kind === 'media') {
      // As ws_patch set (1.0): relations as documentIds, media as existing file documentIds or ids; checked to exist.
      if (kind === 'relation' && !a.target) throw new WsError({ code: 'unsupported', message: `${f} is a polymorphic relation; not supported by ws_create.` });
      E.checkRefValue(a, f, v, `data.${f}`, refs);
      out[f] = v;
    } else {
      out[f] = v;
    }
  }
  return out;
}

/** Draft rows of `uid` in `locale` whose `field` equals `value` (locking read: latest committed rows on every database). */
async function findByValue(strapi, uid, locale, field, value) {
  return strapi.db.queryBuilder(uid).select(['id', 'documentId', 'locale'])
    .where(U.draftWhere(strapi, uid, locale, { [field]: value })).orderBy({ id: 'asc' }).forUpdate().execute();
}

/**
 * A free UID for a generated value, the way the Content Manager picks one (value, value-1, value-2, ...), read with a
 * locking read so a create that waited on a claim sees the other create's document.
 */
async function freeUid(strapi, uid, locale, field, value) {
  const rows = await strapi.db.queryBuilder(uid).select([field])
    .where(U.draftWhere(strapi, uid, locale, { [field]: { $startsWith: value } })).forUpdate().execute();
  const taken = new Set(rows.map((r) => r[field]));
  if (!taken.has(value)) return value;
  let i = 1;
  while (taken.has(`${value}-${i}`)) i += 1;
  return `${value}-${i}`;
}

/** The documentId of a conflicting row when this token may read that entry (its permission conditions included), else null. */
async function readableHit(strapi, pc, uid, hit) {
  if (pc.cannot.read()) return null;
  const raw = await strapi.db.query(uid).findOne({ where: { id: hit.id }, populate: M.permQueryPopulate(strapi, uid) });
  return raw && !pc.cannot.read(raw) ? hit.documentId : null;
}

/** Same value in other locales (reported on an upsert miss, so a caller can see it may want a translation instead). */
async function otherLocales(strapi, uid, locale, field, value) {
  if (!E.isLocalized(strapi, uid)) return [];
  const rows = await strapi.db.query(uid).findMany({ select: ['documentId', 'locale'], where: { [field]: value, ...(E.hasDP(strapi, uid) ? { publishedAt: null } : {}), locale: { $ne: locale } } });
  return rows.map((r) => ({ documentId: r.documentId, locale: r.locale }));
}

async function applyCreate(strapi, ctx, a) {
  const { uid } = a;
  E.checkUid(strapi, uid);
  if (E.isSingle(strapi, uid)) throw new WsError({ code: 'unsupported', message: `${uid} is a single type; create its first document with the built-in write_${strapi.contentTypes[uid].info.singularName} tool, then edit it with ws_patch.` });
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.create()) throw new WsError({ code: 'forbidden', message: `This token cannot create ${uid}.` });
  const locale = await E.resolveLocale(strapi, uid, a.locale);
  const attrs = M.attrsOf(strapi, uid);
  const refs = [];
  const data = prepareData(strapi, uid, a.data, refs);

  // UID fields: given values are checked, missing ones generated from their target field (Content Manager rules).
  const generated = {};
  const uidFields = Object.entries(attrs).filter(([, x]) => x.type === 'uid').map(([k]) => k);
  for (const f of uidFields) {
    const at = attrs[f];
    if (data[f] != null && data[f] !== '') {
      if (typeof data[f] !== 'string' || !UID_RE.test(data[f])) throw new WsError({ code: 'invalid', message: `${f} must match ${UID_RE} (letters, digits, - _ . ~).` });
    } else if (at.targetField && typeof data[at.targetField] === 'string' && data[at.targetField] !== '') {
      data[f] = slug(data[at.targetField], at.options);
      generated[f] = true;
    }
  }

  // Upsert key.
  let uniq = null;
  if (a.unique_by) {
    const f = a.unique_by;
    if (!attrs[f] || !UNIQUE_TYPES.has(attrs[f].type)) {
      throw new WsError({ code: 'invalid', message: `unique_by must be a string, uid, email or integer field of ${uid}.`, allowed: Object.entries(attrs).filter(([, x]) => UNIQUE_TYPES.has(x.type)).map(([k]) => k) });
    }
    if (data[f] == null || data[f] === '') throw new WsError({ code: 'invalid', message: `unique_by is ${f}, but data has no value for it${attrs[f].type === 'uid' && attrs[f].targetField ? ` (nor for ${attrs[f].targetField}, which it is generated from)` : ''}.` });
    // The lookup must not answer questions about a field the token may not read or create (review finding: existed:
    // true would confirm a guess of a hidden value).
    if (pc.cannot.read(null, f) || pc.cannot.create(null, f)) throw new WsError({ code: 'forbidden', message: `unique_by ${f}: this token may not read and create ${f}.` });
    uniq = { field: f, value: data[f] };
  }

  // Claim every unique value this create writes (upsert key, UID fields, unique fields), in a fixed order.
  const claimed = new Set();
  if (uniq) claimed.add(uniq.field);
  for (const [f, x] of Object.entries(attrs)) if ((x.type === 'uid' || x.unique) && data[f] != null && data[f] !== '') claimed.add(f);
  const claims = [];
  // Claim keys are case-folded: MySQL's default collation compares "Hello" and "hello" as equal, so two creators must
  // queue on the same claim (review finding). On Postgres/SQLite this only serialises a few more creates.
  for (const f of [...claimed].sort()) claims.push(await U.claim(strapi, ['create', uid, locale || '', f, String(data[f]).toLowerCase()]));

  if (uniq) {
    const hits = await findByValue(strapi, uid, locale, uniq.field, uniq.value);
    if (hits.length) {
      await U.release(strapi, claims);
      const docIds = [...new Set(hits.map((h) => h.documentId))];
      if (docIds.length > 1) throw new WsError({ code: 'ambiguous', message: `${docIds.length} documents have this ${uniq.field} in this locale; nothing was created.`, field: uniq.field, value: uniq.value, documentIds: docIds });
      const raw = await strapi.documents(uid).findOne({ documentId: docIds[0], ...(locale ? { locale } : {}), ...(E.hasDP(strapi, uid) ? { status: 'draft' } : {}), populate: M.populateFor(strapi, uid) });
      if (!raw) throw new U.Stale(); // MySQL: the locking lookup saw a document this transaction's snapshot predates
      if (pc.cannot.read(raw)) throw new WsError({ code: 'forbidden', message: `A document with this ${uniq.field} exists, but this token cannot read it. Nothing was created.`, field: uniq.field });
      const doc = M.normalize(strapi, uid, raw);
      const visible = await pc.sanitizeOutput(raw);
      const differs = Object.keys(data).filter((f) => f in visible && M.fieldKind(attrs[f]) === 'scalar' && M.canonical(doc[f]) !== M.canonical(data[f]));
      // A version only together with the content it stands for (phase 1 review, N2 again): with return: "full" the
      // reply carries the document and its version; otherwise neither, and the hint says to read it.
      const r = {
        ok: true, created: false, existed: true, documentId: raw.documentId, locale: raw.locale || null, unique_by: uniq,
        hint: 'Nothing was created. To change the existing document, read it with ws_get and patch it with the version you read.',
      };
      if (differs.length) r.differs = differs;
      if (a.return === 'full') {
        r.version = M.versionOf(strapi, uid, raw);
        r.document = M.presentDoc(strapi, uid, visible, undefined, { full: raw }).data;
        r.hint = 'Nothing was created. `version` stands for `document`: to change it, patch with that version as expected_version.';
      }
      return r;
    }
  }

  // Collisions: a UID or unique value taken by another draft in this locale.
  for (const f of [...claimed]) {
    if (uniq && f === uniq.field) continue;
    const hits = await findByValue(strapi, uid, locale, f, data[f]);
    if (!hits.length) continue;
    if (attrs[f].type === 'uid') {
      const suggestion = await freeUid(strapi, uid, locale, f, data[f]);
      if (generated[f]) {
        // Generated, not given: take the next free value, as the admin does ("hello-world-1"), under its own claim.
        claims.push(await U.claim(strapi, ['create', uid, locale || '', f, suggestion.toLowerCase()]));
        const again = await freeUid(strapi, uid, locale, f, data[f]);
        if (again !== suggestion) throw new WsError({ code: 'busy', message: `Another create took ${f} "${suggestion}" at the same moment. Nothing was created. Retry the same request.` });
        data[f] = suggestion;
        continue;
      }
      // The other document is named only when this token may read THAT entry (1.0 hardening item 9; fourth review N23:
      // a token limited to its own entries learned another entry's documentId). Values stay out of the message (N20).
      const other = await readableHit(strapi, pc, uid, hits[0]);
      throw new WsError({ code: 'uid_conflict', field: f, value: data[f], generated: Boolean(generated[f]), suggestion, ...(other ? { documentId: other } : {}),
        message: `The ${f} value is already used by ${other ? `document ${other}` : 'another document'} in this locale. Nothing was created. Use unique_by: "${f}" to get that document back instead, or send a different ${f} (\`suggestion\` is free).` });
    }
    const other = await readableHit(strapi, pc, uid, hits[0]);
    throw new WsError({ code: 'unique_conflict', field: f, value: data[f], ...(other ? { documentId: other } : {}), message: `${f} must be unique and the value is already used by another document in this locale. Nothing was created.` });
  }

  await E.checkRefs(strapi, refs, ctx);
  const sanitized = await pc.sanitizeCreateInput(data);
  const dropped = U.droppedPaths(data, sanitized);
  if (dropped.length) throw new WsError({ code: 'forbidden', message: `This token cannot write field(s): ${dropped.join(', ')}. Nothing was created.` });
  const payload = setCreatorFields({ user: ctx.user })(sanitized);
  const createdRaw = await strapi.documents(uid).create({
    data: await E.MEDIA.toFileIds(strapi, uid, payload), ...(locale ? { locale } : {}), ...(E.hasDP(strapi, uid) ? { status: 'draft' } : {}), populate: M.populateFor(strapi, uid),
  });
  await U.release(strapi, claims);
  const created = M.normalize(strapi, uid, createdRaw);
  const r = { ok: true, created: true, existed: false, documentId: createdRaw.documentId, locale: createdRaw.locale || null, version: M.versionOf(strapi, uid, createdRaw) };
  // Module hooks (e.g. history: receipt and undo for the create). Modules get the token's view; raw stays internal.
  if (E.MOD.hasAfterWrite()) {
    const info = {
      tool: 'ws_create', action: 'create', uid, documentId: createdRaw.documentId, locale: createdRaw.locale || null, args: a,
      dryRun: Boolean(a.dry_run), data: payload, sanitize: (d) => pc.sanitizeOutput(d), raw: { before: null, after: created },
      versions: { before: null, after: r.version }, // from the raw draft, as ws_get shows it (re-review N7)
    };
    const moduleData = await E.MOD.afterWrite(ctx, info, null, M.normalize(strapi, uid, await pc.sanitizeOutput(createdRaw)));
    if (moduleData) r.modules = moduleData;
  }
  if (E.isLocalized(strapi, uid) && !a.locale) r.locale_defaulted = true;
  if (uniq) {
    r.unique_by = uniq;
    const elsewhere = await otherLocales(strapi, uid, locale, uniq.field, uniq.value);
    if (elsewhere.length) r.same_value_in_other_locales = elsewhere;
  }
  const gen = Object.keys(generated);
  if (gen.length) r.generated = Object.fromEntries(gen.map((f) => [f, created[f]]));
  if (a.return === 'full') {
    // a token that may create but not read gets the create's facts only (E.cannotReadDoc)
    if (E.cannotReadDoc(pc, createdRaw)) { r.readable = false; r.note = E.NOT_READABLE; } else r.document = M.presentDoc(strapi, uid, await pc.sanitizeOutput(createdRaw), undefined, { full: createdRaw }).data;
  }
  return r;
}

function toolDef(strapi, h, cfg) {
  const L = h.lenient;
  return {
    name: 'ws_create',
    title: 'Write-safe: create a document (optionally upsert by a unique field)',
    description: 'Create one draft document. data takes the same shape as ws_patch set (components, dynamic-zone rows with __component, blocks, relations as documentIds). '
      + 'With unique_by (e.g. "slug" or "externalId") it is an upsert: if a draft with that value exists in the locale, nothing is created and the existing document '
      + 'comes back with existed: true (with return: "full", its content and version). Safe to retry, also when two agents create the same item at once, '
      + 'as long as the plugin\'s unique index on its receipts table exists (otherwise creates with unique values are refused). UID fields (slugs) left out are generated '
      + 'from their target field like the admin does; a taken UID is refused with uid_conflict and a free suggestion. Creates only the locale named (default locale otherwise). '
      + 'dry_run validates and rolls back; idempotency_key makes a retry return the first receipt.',
    auth: h.policies(strapi, 'plugin::content-manager.explorer.create'),
    resolveInputSchema: () => z.object({
      uid: h.uidSchema(strapi),
      locale: h.localeSchema,
      data: L.obj(z.object({}).catchall(z.any())).describe('Field values. Lists (dynamic zones, repeatable components, blocks) are given whole; `_key`/`id` in rows are ignored (all rows are new).'),
      unique_by: z.string().optional().describe('Upsert key: a unique field such as "slug" or "externalId". If a draft with data[unique_by] exists in this locale it is returned (existed: true) instead of creating a duplicate.'),
      dry_run: L.bool(z.boolean()).optional().describe('Validate and run the create, then roll it back. Strapi lifecycle hooks and Document Service middlewares do run during it (their database work is rolled back; webhooks are not sent).'),
      idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request.'),
      ...E.MOD.writeArgs(z), // [integration] e.g. `agent` (history module)
      return: z.enum(['receipt', 'full']).optional().describe('receipt (default) or full: also return the created document.'),
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try { return h.ok(await U.retryStale(() => E.runWrite(strapi, context, 'ws_create', args, () => applyCreate(strapi, context, args), extra))); } catch (e) { return h.fail(h.errorOf(e)); }
    },
  };
}

module.exports = {
  name: 'create',
  tools: (strapi, api) => [toolDef(strapi, U.helpers(api), U.settings(strapi))],
  toolDef, applyCreate, prepareData };
