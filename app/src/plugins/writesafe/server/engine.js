'use strict';

/**
 * Write engine. Every write runs inside one strapi.db.transaction:
 *   lock the draft row (SELECT ... FOR UPDATE on Postgres/MySQL; SQLite serialises writers),
 *   read the current draft, check the version, apply set/unset/row ops to the CURRENT state,
 *   write through the Document Service with component ids kept, read back the new version.
 * Batches run their items in one transaction: all commit or none do.
 * Idempotency keys are stored in plugin::writesafe.receipt in the same transaction as the write.
 * dry_run runs the whole write (including Strapi's own validation) and then rolls back; Document Service middlewares and
 * lifecycle hooks run in it (webhooks and entry.* events do not: Strapi sends them after the commit). The publish and
 * delete dry runs are previews instead: they never call Strapi's publish or delete (preview.js; phase 2 item 10).
 */
const { errors: strapiErrors, setCreatorFields } = require('@strapi/utils');
const M = require('./model');
const DB = require('./compat/db');
const CO = require('./compat/custom-order');
const CM = require('./compat/content-manager');
const MCP = require('./compat/mcp');
const BV = require('./compat/base-version');
const MOD = require('./modules');
const D = require('./diff');
const MEDIA = require('./compat/media');
const EPOCH = require('./epoch');
const PREVIEW = require('./preview');
const RO = require('./refops');

const RECEIPT_UID = 'plugin::writesafe.receipt';

class WsError extends Error {
  constructor(payload) {
    super(payload.message || payload.code);
    this.payload = payload;
  }
}
RO.setErrorClass(WsError); // ref ops (item 20) throw the engine's typed errors
class DryRun extends Error {
  constructor(result) { super('dry-run rollback'); this.result = result; }
}
class BatchAbort extends Error {
  constructor(done, failed, index, total) { super('batch abort'); Object.assign(this, { done, failed, index, total }); }
}

const RETRY_HINT = 'Re-read the document (ws_get, or use `current` below), re-apply only your own change to it, '
  + 'and retry with expected_version set to current_version. Do not resend your earlier copy: it would undo the other change.';

/**
 * Retry advice per action (1.0 hardening, item 1; fourth review N1). Only a patch may be re-applied to the new state
 * by the agent itself, so only a patch conflict carries `retry.expected_version`. A publish, a delete or a translation
 * into a locale someone else changed must not simply be repeated with the new version: that would publish, delete or
 * overwrite a state nobody reviewed.
 */
const RETRY_HINTS = {
  patch: RETRY_HINT,
  publish: 'The draft is no longer the version that was reviewed. Do not publish it as it is now: show what changed '
    + '(`current` below, or ws_get with compare: "published") to whoever approved the publish, and publish only the version '
    + 'they approve, with that version as expected_version.',
  delete: 'The document changed after you read it. Re-read it (ws_get), make sure deleting its current content is still '
    + 'intended (ask the user if they approved the earlier state), then delete with the version you read.',
  localize: 'The target locale changed after you read it (someone edited it). Call ws_localize without translations to '
    + 'see its current text, redo your translations against it, and send the target_version from that plan.',
};

/**
 * Content types the plugin reads and writes: api:: collection types and single types whose content the version can
 * cover (phase 2 A review, finding 4: model.unhashable; types with a polymorphic relation or components nested deeper
 * than the read populates are left out, with one warning, instead of being versioned with a blind spot).
 */
const unhashableWarned = new Set();
const writableUids = (strapi) => Object.values(strapi.contentTypes)
  .filter((ct) => ct.uid.startsWith('api::') && (ct.kind === 'collectionType' || ct.kind === 'singleType'))
  .filter((ct) => {
    const why = M.unhashable(strapi, ct.uid);
    if (why && !unhashableWarned.has(ct.uid)) {
      unhashableWarned.add(ct.uid);
      (strapi.log || console).warn(`[writesafe] ${ct.uid} is not covered by the ws_* tools: ${why}, so its version could not see every change`);
    }
    return !why;
  })
  .map((ct) => ct.uid);
/** The api:: types left out because the version cannot cover them, with the reason (named in ws_schema and the
 * server instructions; re-review N6). */
const uncoveredUids = (strapi) => Object.values(strapi.contentTypes)
  .filter((ct) => ct.uid.startsWith('api::') && (ct.kind === 'collectionType' || ct.kind === 'singleType'))
  .map((ct) => ({ uid: ct.uid, reason: M.unhashable(strapi, ct.uid) }))
  .filter((x) => x.reason);
const isSingle = (strapi, uid) => strapi.contentTypes[uid]?.kind === 'singleType';

/**
 * The documentId a call works on. Collection types need it. A single type has one document, so it may be left out;
 * if it is given it must be that document's id.
 */
async function resolveDocumentId(strapi, uid, documentId, locale) {
  if (!isSingle(strapi, uid)) {
    if (!documentId) throw new WsError({ code: 'invalid', message: `documentId is required for the collection type ${uid}.` });
    return documentId;
  }
  if (documentId) return documentId;
  const row = await strapi.db.query(uid).findOne({ select: ['documentId'], where: locale ? { locale } : {} });
  if (!row) {
    const slug = strapi.contentTypes[uid].info.singularName;
    throw new WsError({ code: 'not_found', message: `The single type ${uid} has no content${locale ? ` in locale ${locale}` : ''} yet. Create it first (built-in write_${slug} tool); ws_patch only changes an existing document.`, locale: locale || null });
  }
  return row.documentId;
}

const hasDP = (strapi, uid) => Boolean(strapi.contentTypes[uid]?.options?.draftAndPublish);
const isLocalized = (strapi, uid) => strapi.contentTypes[uid]?.pluginOptions?.i18n?.localized === true;

/**
 * The locale a call works on. Localized types: the given locale (it must exist) or the default locale, resolved here
 * so that the row lock, the version and the receipt all name one locale. Non-localized types refuse a locale instead
 * of ignoring it.
 */
async function resolveLocale(strapi, uid, locale) {
  if (!isLocalized(strapi, uid)) {
    if (locale) throw new WsError({ code: 'invalid', message: `${uid} is not localized; leave out locale.` });
    return undefined;
  }
  const ls = await CM.locales(strapi);
  const codes = ls ? ls.codes : [];
  if (locale) {
    if (codes.length && !codes.includes(locale)) throw new WsError({ code: 'invalid', message: `Unknown locale ${locale}. Available: ${codes.join(', ')}` });
    return locale;
  }
  return ls ? ls.defaultLocale : undefined;
}

const permissionChecker = (strapi, ctx, uid) => CM.permissionChecker(strapi, ctx, uid);

function checkUid(strapi, uid) {
  if (!writableUids(strapi).includes(uid)) {
    throw new WsError({ code: 'invalid', message: `Unknown or unsupported content type ${uid}. Supported: ${writableUids(strapi).join(', ')}` });
  }
}

const draftWhere = (strapi, uid, documentId, locale) => ({ documentId, ...(locale ? { locale } : {}), ...(hasDP(strapi, uid) ? { publishedAt: null } : {}) });

async function lockAndRead(strapi, uid, documentId, locale) {
  // every locale's draft row in the one lock order, re-read with the locking read
  const rows = await DB.lockDocuments(strapi, [{ uid, documentId }], { rows: true });
  const locked = rows.find((r) => !locale || r.locale === undefined || r.locale === locale) || null;
  if (!locked && rows.changed) staleRetry('ROWS_CHANGED', 'the draft rows were recreated while the write waited for them');
  const doc = await strapi.documents(uid).findOne({
    documentId, ...(locale ? { locale } : {}), ...(hasDP(strapi, uid) ? { status: 'draft' } : {}),
    populate: M.populateFor(strapi, uid),
  });
  if (!doc || !locked) throw new WsError({ code: 'not_found', message: `No ${uid} draft with documentId ${documentId}${locale ? ` in locale ${locale}` : ''}.`, documentId, locale: locale || null });
  // [bulk stream] MySQL (REPEATABLE READ): a consistent read sees the snapshot of the transaction's FIRST read, which can
  // predate the lock just granted (resolveLocale or the idempotency lookup read before it). Then `doc` is older than the
  // locked row, or the row was deleted meanwhile (found with ws_delete racing ws_patch: the patch answered ok and wrote
  // nothing). The locking read above returns the latest committed row, so compare: a mismatch re-runs the attempt in a
  // new transaction (runWrite). Postgres (READ COMMITTED) and SQLite never differ here.
  if (locked.updatedAt !== undefined && M.isoOf(locked.updatedAt) !== M.isoOf(doc.updatedAt)) staleRetry('STALE_SNAPSHOT', 'read snapshot older than the locked row');
  return doc;
}

/** Abort this attempt so that runWrite runs it again in a new transaction (nothing was written). */
function staleRetry(code, message) {
  const st = attemptCtx.getStore();
  if (st) st.retryable = { code, message, own: true };
  const e = new WsError({ code: 'busy', message: 'Another write committed while this one waited for the row lock. Nothing was written. Retry the same request.' });
  e.retryAttempt = true;
  throw e;
}

/** Version token of a raw draft (relations reduced to documentIds first, so a target's row id never matters). */
// The RAW draft: relations to localized types carry their linked locale there (phase 2 A review, finding 4).
const versionOfRaw = (strapi, uid, raw) => M.versionOf(strapi, uid, raw);

/**
 * Conflict payload. `current` is filtered through the token's read permissions (sanitizeOutput). `kind` picks the retry
 * advice (RETRY_HINTS): only 'patch' hands back the new version in `retry`; the version shown at the top level always
 * comes with the state it stands for (`current`).
 */
async function conflict(strapi, pc, uid, raw, expected, fields, extra = {}, kind = 'patch') {
  const visible = await pc.sanitizeOutput(raw);
  const { data, rows } = M.presentDoc(strapi, uid, visible, fields && fields.length ? fields : undefined, { documentId: raw.documentId, locale: raw.locale || null, full: raw });
  const current = versionOfRaw(strapi, uid, raw);
  return new WsError({
    code: 'version_conflict',
    message: 'The document changed after you read it. Nothing was written.',
    documentId: raw.documentId, locale: raw.locale || null,
    expected_version: expected, current_version: current,
    current: data, current_rows: rows,
    retry: kind === 'patch' ? { hint: RETRY_HINT, expected_version: current } : { hint: RETRY_HINTS[kind] || RETRY_HINTS.delete },
    ...extra,
  });
}

/**
 * precondition_required for a `set` or `unset` without expected_version (1.0 hardening item 3 for whole lists, item 16c
 * for every field): no version in it (item 1, N2: a version without the state it stands for would let the agent
 * "retry" without reading), and no advice to use force.
 */
function preconditionFields(fields, attrs, nested = []) {
  const lists = fields.filter((f) => M.isListAttr(attrs[f]));
  const rowFields = lists.filter((f) => M.isListKind(M.fieldKind(attrs[f])));
  const refFields = lists.filter((f) => !M.isListKind(M.fieldKind(attrs[f])));
  const named = fields.map((f) => `${f}`).join(', ');
  return new WsError({
    code: 'precondition_required', field: fields[0] || (nested[0] || '').split('.')[0], fields: [...fields, ...nested], ...(nested.length ? { nested } : {}),
    message: `${fields.length ? `set and unset need expected_version (${named}): read the document with ws_get and send its version as expected_version, `
      + `so a change another writer made since is not overwritten${lists.length ? ` (and items another writer added to ${lists.join(', ')} are not deleted)` : ''}.` : ''}`
      + `${nested.length ? `${fields.length ? ' ' : ''}This write replaces or clears a list nested in a component (${nested.join(', ')}), so a link or row another writer added since would be lost: `
        + 'send the version from ws_get as expected_version.' : ''}`
      + `${rowFields.length ? ` For single rows of ${rowFields.join(', ')}, use ops: they need no version.` : ''}`
      + `${refFields.length || nested.length ? ` For single links of a to-many relation or multiple media field${refFields.length ? ` (${refFields.join(', ')})` : ''}, use ref ops {op: "add" | "remove", field, ref} (key and path inside a row, path inside a single component): they need no version.` : ''}`
      + ' Nothing was written.',
  });
}

/**
 * expected_version must be a version token from ws_get ("v3.<mac>", 1.0 hardening item 15; the content revision since D1).
 * - A bare updatedAt (what get_<type> and REST return) is refused (item 3): it skipped the content check, and a write
 *   built from a built-in read is usually a whole-list copy without row keys.
 * - A token of 1.0.0-rc.2 or the Phase 1 builds ("<updatedAt>~<hash>") is refused as version_format
 *   (requires_reread): those tokens bound component row ids and updatedAt, which the semantic version drops on purpose,
 *   so comparing them would need the old rules kept alive next to the new ones. One re-read gives a current token.
 */
function assertVersion(v, name = 'expected_version') {
  if (v === undefined) return;
  if (M.isLegacyVersionToken(v)) {
    throw new WsError({
      code: 'version_format', field: name, requires_reread: true, retryable: false,
      message: `${name} has the version format of writesafe 1.0.0-rc.2 ("<updatedAt>~<hash>"), which this version no longer accepts. Read the document again with ws_get and send its new \`version\` ("v3.…"). Nothing was written.`,
    });
  }
  if (typeof v === 'string' && /^v2\.[A-Za-z0-9_-]{43}$/.test(v)) {
    // a content-only token from before the content revision was bound in (D1): stale by format, not by a change
    throw new WsError({
      code: 'version_format', field: name, requires_reread: true, retryable: false,
      message: `${name} is a version token from before writesafe bound the draft's content revision into its versions ("v2.…"; an upgrade, or another server of a rolling deploy). The document may not have changed. Read it again with ws_get and send its current \`version\` ("v3.…"). Nothing was written.`,
    });
  }
  if (typeof v !== 'string' || !M.isVersionToken(v)) {
    throw new WsError({ code: 'invalid', field: name, message: `${name} must be a \`version\` from ws_get ("v3.…"). A bare updatedAt is not accepted: read the document with ws_get and send its version.` });
  }
}

/**
 * if_match: compare-and-set on the top-level fields it names, in semantic form (as the version) on the token's view.
 * A set/unset without expected_version needs an entry for each field it writes; other fields never block it.
 */
const IF_MATCH_HINT = 'Re-read with ws_get, re-apply only your change to the new value, and retry with if_match set to the value read now '
  + '(or with expected_version). Do not resend your old copy: it would undo the other change.';
function ifMatchKeys(strapi, uid, a) {
  const m = a.if_match;
  if (m === undefined) return null;
  const bad = (msg, x) => new WsError({ code: 'invalid', field: 'if_match', message: `${msg} Nothing was written.`, ...x });
  if (!m || typeof m !== 'object' || Array.isArray(m) || !Object.keys(m).length) throw bad('if_match is an object {"<field>": <the value you read with ws_get>}.');
  if (a.force) throw bad('if_match and force contradict each other: leave one out.');
  const keys = Object.keys(m);
  const dotted = keys.filter((k) => /[.[\]]/.test(k));
  if (dotted.length) throw bad(`if_match takes top-level fields only (${dotted.join(', ')}); a component, list or relation is compared whole.`);
  const attrs = M.attrsOf(strapi, uid);
  const unknown = keys.filter((k) => !attrs[k] || M.SKIP_KEYS.has(k));
  if (unknown.length) throw bad(`Unknown or read-only if_match field(s): ${unknown.join(', ')}.`, { allowed: Object.keys(attrs).filter((k) => !M.SKIP_KEYS.has(k)) });
  return keys;
}
/** Permission paths of a field: a component's leaf paths (nested ones expanded), else the field itself. */
function leafPaths(strapi, path, a, depth = 0) {
  const comp = a && a.type === 'component' && strapi.components && strapi.components[a.component];
  if (!comp || depth > 8) return [path];
  return Object.entries(comp.attributes || {}).filter(([k, x]) => k !== 'id' && x.visible !== false)
    .flatMap(([k, x]) => leafPaths(strapi, `${path}.${k}`, x, depth + 1));
}
/** The if_match fields whose current value (the token's view, under the row lock) differs from the one sent. */
async function ifMatchChanged(strapi, pc, uid, raw, ifMatch) {
  const keys = Object.keys(ifMatch);
  const visible = await pc.sanitizeOutput(raw);
  const attrs = M.attrsOf(strapi, uid);
  // a field not wholly readable (every sub-field of a component) is refused, never compared: no oracle
  const readable = (f) => !pc.cannot.read(raw, f) || leafPaths(strapi, f, attrs[f]).every((p) => p !== f && !pc.cannot.read(raw, p));
  const hidden = keys.filter((f) => !readable(f) || (raw && f in raw && !(visible && f in visible)));
  if (hidden.length) throw new WsError({ code: 'forbidden', field: 'if_match', message: `This token cannot read field(s) ${hidden.join(', ')}, so if_match cannot name them. Nothing was written.` });
  const view = M.normalize(strapi, uid, visible);
  const form = (f, v) => {
    let x = M.semanticValue(strapi, attrs[f], v === undefined ? null : v);
    if (x == null && M.isListAttr(attrs[f])) x = [];
    return M.canonical(x);
  };
  return keys.filter((f) => form(f, view[f]) !== form(f, ifMatch[f]));
}

/**
 * publish: "if_clean": the patch also publishes, in the same transaction, only a draft that equalled its live version
 * before it (semantic form); otherwise it stays a draft (publish_skipped).
 */
function checkPublishArg(strapi, uid, a) {
  if (a.publish === undefined) return;
  if (a.publish !== 'if_clean') throw new WsError({ code: 'invalid', field: 'publish', message: 'publish takes only "if_clean" (ws_publish publishes a draft as it is). Nothing was written.' });
  if (!hasDP(strapi, uid)) throw new WsError({ code: 'invalid', field: 'publish', message: `${uid} has no draft & publish: leave out publish. Nothing was written.` });
}
/** 'clean' if the draft equalled the live version (before the patch), else the publish_skipped reason. */
async function cleanState(strapi, uid, documentId, locale, raw) {
  const live = await strapi.documents(uid).findOne({ documentId, ...(locale ? { locale } : {}), status: 'published', populate: M.populateFor(strapi, uid) });
  if (!live) return 'no_live_version';
  return M.semanticHash(strapi, uid, raw) === M.semanticHash(strapi, uid, live) ? 'clean' : 'draft_had_other_changes';
}

const stripMeta = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) if (k !== '_key') out[k] = v;
  return out;
};

/**
 * A relation or media value, at the top level or inside a component row (1.0 adds media and top-level fields).
 * Relations take documentIds: a string (or null) for a to-one relation, a list for a to-many relation.
 * Media take existing files: a file documentId (as ws_get shows it) or a numeric file id; one (or null) for a single
 * media field, a list for a multiple one. Uploading is not part of this: the files must exist.
 * Every reference is pushed to `refs` and checked by checkRefs inside the write's transaction.
 */
function checkRefValue(a, k, v, where, refs) {
  if (!a || (a.type !== 'relation' && a.type !== 'media')) return;
  if (a.type === 'relation') {
    const many = M.isToMany(a);
    const ok = many ? Array.isArray(v) && v.every((x) => typeof x === 'string' && x) : v === null || (typeof v === 'string' && v);
    if (!ok) {
      throw new WsError({ code: 'invalid', message: `${where}: ${k} is a ${a.relation} relation to ${a.target}; give ${many ? 'a list of documentIds ([] clears it)' : 'one documentId (or null to clear it)'}.` });
    }
    for (const id of many ? v : v ? [v] : []) if (refs) refs.push({ target: a.target, documentId: id, where: `${where}: ${k}` });
    return;
  }
  const isRef = (x) => (typeof x === 'string' && x) || (Number.isInteger(x) && x > 0);
  const ok = a.multiple ? Array.isArray(v) && v.every(isRef) : v === null || isRef(v);
  if (!ok) {
    throw new WsError({ code: 'invalid', message: `${where}: ${k} is a ${a.multiple ? 'multiple' : 'single'} media field; give ${a.multiple ? 'a list of file documentIds or ids ([] clears it)' : 'one file documentId or id (or null to clear it)'}. Files must already be in the media library.` });
  }
  for (const f of a.multiple ? v : v ? [v] : []) if (refs) refs.push({ media: true, file: f, allowedTypes: a.allowedTypes || null, where: `${where}: ${k}` });
}

/**
 * Check the fields of one component row. Relation fields take documentIds: a string (or null) for a to-one
 * relation, a list of strings for a to-many relation. Each documentId is pushed to `refs` and checked to exist
 * (checkRefs) before the write, so an unknown target is refused instead of being dropped.
 */
function checkComponentData(strapi, cuid, data, where, refs) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WsError({ code: 'invalid', message: `${where}: data must be an object` });
  const attrs = M.attrsOf(strapi, cuid);
  const unknown = Object.keys(data).filter((k) => k !== '_key' && !(k in attrs));
  if (unknown.length) throw new WsError({ code: 'invalid', message: `${where}: unknown field(s) ${unknown.join(', ')} for component ${cuid}`, allowed: Object.keys(attrs) });
  const bad = M.unsupportedNested(strapi, cuid);
  if (bad.length) throw new WsError({ code: 'unsupported', message: `${where}: component ${cuid} holds polymorphic relation fields (${bad.join(', ')}); row edits of such components are not supported yet` });
  for (const [k, v] of Object.entries(data)) checkRefValue(attrs[k], k, v, where, refs);
  // Components nested in this row (1.0, found in review): Strapi updates a component row by any `id` it is given, with
  // no check that the row belongs to this document, so a nested `id` could rewrite another document's (or the
  // published version's) row. Nested rows never carry ids from the client: a nested single component is merged into
  // the current one (its id kept by mergeRow), a nested repeatable list is written as new rows.
  for (const [k, v] of Object.entries(data)) {
    const a = attrs[k];
    if (!a || a.type !== 'component' || v == null) continue;
    if (a.repeatable && !Array.isArray(v)) throw new WsError({ code: 'invalid', message: `${where}: ${k} is a repeatable component; give a list of rows` });
    (a.repeatable ? v : [v]).forEach((r, i) => {
      const w = `${where}: ${k}${a.repeatable ? `[${i}]` : ''}`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new WsError({ code: 'invalid', message: `${w} must be an object` });
      const meta = ['id', '_key', '__component', 'documentId'].filter((x) => x in r);
      if (meta.length) {
        throw new WsError({ code: 'invalid', message: `${w}: ${meta.join(', ')} cannot be sent inside a component. A nested single component is merged into the current one; a nested list is written as given (new rows).` });
      }
      checkComponentData(strapi, a.component, r, w, refs);
    });
  }
}

/** Merge a patch into a component row. Nested single components merge recursively, so their rows (ids) are kept. */
function mergeRow(strapi, cuid, cur, patch) {
  const attrs = M.attrsOf(strapi, cuid);
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    const a = attrs[k];
    const nested = a && a.type === 'component' && !a.repeatable;
    out[k] = nested && v && typeof v === 'object' && cur && cur[k] && typeof cur[k] === 'object' ? mergeRow(strapi, a.component, cur[k], v) : v;
  }
  return out;
}

/**
 * Component sub-fields this patch actually changes, as permission paths ("items.qty", "credits.author").
 * sanitizeUpdateInput removes sub-fields the token may not update without saying so; the whole-field check below only
 * sees top-level keys. Before 0.2 such a sub-field change was dropped while the receipt said ok (found with a token that
 * may not update credits.author). Unchanged values of rows that are only re-sent are not counted: they are kept as they
 * are. Dynamic-zone permissions are per field, so zones are covered by the top-level check.
 */
/**
 * Permission paths of the changed values of one component row, added to `paths`. Nested components expand to their
 * leaf fields ("items.meta.note"): Strapi's field permissions list leaves, so "items.meta" alone is never granted.
 */
function addRowPaths(strapi, cuid, prefix, data, cur, paths, depth = 0) {
  const attrs = strapi.components[cuid]?.attributes || {};
  const same = (x, y) => M.canonical(x) === M.canonical(y);
  for (const [k, v] of Object.entries(data || {})) {
    if (k === '_key' || k === 'id' || k === '__component') continue;
    if (cur && same(v, cur[k])) continue;
    const at = attrs[k];
    if (at && at.type === 'component' && depth < 8) {
      // Strapi grants permissions on leaf paths only (items.meta.note), never on the component path (items.meta):
      // a nested component is checked through its leaves. An empty one (null, or [] for a list) on a new row, as
      // ws_get returns it, changes nothing; clearing one that has values changes every leaf it had (integration fix,
      // found by the bulk stream: `add` with meta: null was refused as forbidden: items.meta for a full-access token).
      const was = cur ? cur[k] : undefined;
      if (at.repeatable) {
        for (const r of Array.isArray(v) ? v : []) addRowPaths(strapi, at.component, `${prefix}.${k}`, r, undefined, paths, depth + 1);
        if (Array.isArray(was) && was.length) for (const r of was) addRowPaths(strapi, at.component, `${prefix}.${k}`, r, undefined, paths, depth + 1);
      } else if (v && typeof v === 'object') addRowPaths(strapi, at.component, `${prefix}.${k}`, v, was, paths, depth + 1);
      else if (was && typeof was === 'object') addRowPaths(strapi, at.component, `${prefix}.${k}`, was, undefined, paths, depth + 1);
      else if (v != null) paths.add(`${prefix}.${k}`); // not a component value: let the permission check refuse it
    } else paths.add(`${prefix}.${k}`);
  }
}

function changedSubPaths(strapi, attrs, a, doc) {
  const paths = new Set();
  // rows by identity ("<component>:<id>"); agents send keys with a content MAC, matched by their identity part here
  // (the key itself is checked by applyRowOps / listFromSet)
  const keyed = (f) => new Map((doc[f] || []).map((r, i) => [M.rowKey('repeatable', attrs[f], r, i), r]));
  const byKey = (f, key) => keyed(f).get(M.keyIdentity(key));
  const addRow = (f, data, cur) => addRowPaths(strapi, attrs[f].component, f, data, cur, paths);
  // Clearing a component, or dropping rows of a repeatable list, changes every leaf the old value had (second review:
  // a token allowed only seo.metaTitle could set seo to null and wipe seo.metaDescription).
  const dropped = (f, keep) => { for (const [k, r] of keyed(f)) if (!keep.has(k)) addRow(f, r, undefined); };
  for (const [f, v] of Object.entries(a.set || {})) {
    const at = attrs[f];
    if (!at || at.type !== 'component') continue;
    if (!at.repeatable) {
      if (v != null) addRow(f, v, doc[f]);
      else if (doc[f] != null) addRow(f, doc[f], undefined);
    } else {
      const m = keyed(f);
      const list = Array.isArray(v) ? v : [];
      for (const r of list) addRow(f, r, r && r._key ? m.get(M.keyIdentity(r._key)) : undefined);
      dropped(f, new Set(list.map((r) => r && r._key && M.keyIdentity(r._key)).filter(Boolean)));
    }
  }
  for (const f of a.unset || []) {
    const at = attrs[f];
    if (!at || at.type !== 'component' || doc[f] == null) continue;
    if (!at.repeatable) addRow(f, doc[f], undefined);
    else dropped(f, new Set());
  }
  for (const op of a.ops || []) {
    const at = attrs[op.field];
    if (!at || at.type !== 'component' || !at.repeatable || !op.data) continue;
    addRow(op.field, op.data, op.op === 'update' ? byKey(op.field, op.key) : undefined);
  }
  return [...paths];
}

/**
 * Sub-field paths a row-op result changes in a repeatable component field, from the final list itself (1.0): every
 * field of a new row, and the fields of an existing row whose value differs from the current one. Covers built-in and
 * module ops alike.
 */
function changedSubPathsOfWork(strapi, attrs, f, work, current) {
  const at = attrs[f];
  if (!at || at.type !== 'component' || !at.repeatable) return [];
  const cur = new Map((current || []).map((r, i) => [M.rowKey('repeatable', at, r, i), r]));
  const paths = new Set();
  for (const w of work || []) addRowPaths(strapi, at.component, f, w.row, w.isNew ? undefined : cur.get(M.keyIdentity(w.key)), paths);
  // removed rows (remove op): every leaf they had changes
  const kept = new Set((work || []).filter((w) => !w.isNew).map((w) => M.keyIdentity(w.key)));
  for (const [k, r] of cur) if (!kept.has(k)) addRowPaths(strapi, at.component, f, r, undefined, paths);
  return [...paths];
}

const FILE_UID = 'plugin::upload.file';
const mimeKind = (mime) => (/^image\//.test(mime) ? 'images' : /^video\//.test(mime) ? 'videos' : /^audio\//.test(mime) ? 'audios' : 'files');

/**
 * References the write ADDS (1.0, review): a relation documentId or media file already referenced somewhere in the
 * current draft is not re-checked, so re-sending an untouched row (whose image another user uploaded) still works and
 * a 200-row echo costs no lookups. New references are checked in one query per target type / id kind.
 */
function currentRefs(strapi, uid, doc) {
  const out = new Set();
  const walk = (attrs, v, depth) => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    for (const [k, x] of Object.entries(v)) {
      const a = attrs[k];
      if (!a || x == null) continue;
      if (a.type === 'relation' && a.target) for (const d of [].concat(x)) out.add(`${a.target}:${d}`);
      else if (a.type === 'media') for (const d of [].concat(x)) out.add(`file:${d}`);
      else if (a.type === 'component') for (const r of [].concat(x)) walk(M.attrsOf(strapi, a.component), r, depth + 1);
      else if (a.type === 'dynamiczone') for (const r of [].concat(x)) if (r && strapi.components[r.__component]) walk(M.attrsOf(strapi, r.__component), r, depth + 1);
    }
  };
  walk(M.attrsOf(strapi, uid), doc, 0);
  return out;
}

/**
 * New references must exist AND be readable by the token: a relation target through the content manager's permission
 * checker for its type, a file through the media library's own conditions (e.g. an Author may only read files they
 * uploaded: admin::is-creator), exactly as the upload plugin's MCP tools check it (compat/media.js). "Missing" and
 * "not readable" get the same answer, so the error is no oracle for which ids exist. Media files must also be of an
 * allowed type. Checked inside the write's transaction.
 */
async function checkRefs(strapi, refs, ctx, existing = new Set(), opts = {}) {
  const isNew = (r) => !existing.has(r.media ? `file:${r.file}` : `${r.target}:${r.documentId}`);
  const fresh = refs.filter(isNew);
  const media = refs.filter((r) => r.media);
  if (media.length) {
    // allowed types are checked on every media reference (a file may already sit in another field); existence and
    // read permission on the new ones
    if (media.some(isNew) && (!ctx || !ctx.userAbility || !ctx.userAbility.can('plugin::upload.read'))) {
      throw new WsError({ code: 'forbidden', message: `${media[0].where}: this token cannot read the media library, so it cannot attach files. Nothing was written.` });
    }
    const files = await MEDIA.readableFiles(strapi, ctx && ctx.userAbility, media.map((r) => r.file));
    for (const r of media) {
      const f = (isNew(r) ? files.readable : files.all).get(r.file);
      if (!f) throw new WsError({ code: 'invalid', message: `${r.where}: file ${r.file} is not in the media library or this token cannot read it. Nothing was written.` });
      if (r.allowedTypes && r.allowedTypes.length && !r.allowedTypes.includes(mimeKind(f.mime))) {
        throw new WsError({ code: 'invalid', message: `${r.where}: file ${r.file} is ${f.mime}; this field takes ${r.allowedTypes.join(', ')}. Nothing was written.` });
      }
    }
  }
  const byTarget = new Map();
  for (const r of fresh) if (!r.media) (byTarget.get(r.target) || byTarget.set(r.target, []).get(r.target)).push(r);
  for (const [target, list] of byTarget) {
    const ids = [...new Set(list.map((r) => r.documentId))];
    // with the creator fields, so a target the token may read only as its creator passes (item 10a)
    // the row the relation will point at (review L2): the draft (draft & publish targets) in the write's locale (localized
    // targets), not any locale or published copy of that documentId
    const where = { documentId: { $in: ids } };
    if (hasDP(strapi, target)) where.publishedAt = null;
    if (isLocalized(strapi, target) && opts.locale) where.locale = opts.locale;
    const rows = await strapi.db.query(target).findMany({ where, populate: M.permQueryPopulate(strapi, target) });
    const pcT = ctx && ctx.userAbility ? permissionChecker(strapi, ctx, target) : null;
    const readable = new Set(rows.filter((row) => pcT && !pcT.cannot.read(row)).map((row) => row.documentId));
    const bad = list.find((r) => !readable.has(r.documentId));
    if (bad) throw new WsError({ code: 'invalid', message: `${bad.where}: no ${target} with documentId ${bad.documentId} that this token can read. Nothing was written.` });
  }
}

/**
 * The error for a row key that names no entry of the working list (1.0 hardening item 16b):
 *   stale_row_key  the row is there (same "<component>:<id>"), but the key no longer matches it: someone edited that
 *                  row since it was read, the key comes from another database (an import, a restore, a copy to
 *                  staging), the id was reused (a sequence reset), or it is a 1.0.0-rc.2 key without a MAC.
 *   row_not_found  no such row any more (removed, or every row recreated).
 * Both require a re-read; neither hands out the row's current key (it would let the agent retry without reading).
 */
function keyError(work, key, field, where) {
  const id = M.keyIdentity(key);
  const there = id && !id.startsWith('#') && !id.startsWith('new:') && work.some((w) => !w.isNew && M.keyIdentity(w.key) === id);
  if (there) {
    return new WsError({
      code: 'stale_row_key', field, key, requires_reread: true, retryable: false,
      // the key itself is agent text: it stays in `key`, never in the message (phase 1 item 4, N20)
      message: `${where ? `${where}: ` : ''}The row key (\`key\`) of ${field} no longer matches that row: it was edited after you read it (or the key comes from an older read, `
        + 'another database or an earlier writesafe version). Nothing was written. Read the document again with ws_get, check the row, and use its new key.',
    });
  }
  // current_keys are row identities without the MAC (phase 2 A review, finding 1): a key with its MAC would let the agent
  // edit a row it never read; the identities only tell which rows are there.
  return new WsError({ code: 'row_not_found', field, key, message: `${where ? `${where}: ` : ''}Row ${key} is not in ${field} any more (another writer removed or replaced it). Read the document again for the current keys.`, current_keys: work.filter((w) => !w.isNew).map((w) => M.keyIdentity(w.key)) });
}

/** Resolve a position spec against the working list. */
function resolvePos(work, pos, field) {
  if (!pos || pos === 'end') return work.length;
  if (pos === 'start') return 0;
  if (typeof pos.index === 'number') return Math.max(0, Math.min(work.length, pos.index));
  // {} or {index: undefined} passed the schema (fourth review N24) and ended in "Row undefined": refuse it plainly.
  if (typeof pos !== 'object' || (typeof pos.before !== 'string' && typeof pos.after !== 'string')) {
    throw new WsError({ code: 'invalid', field, message: `${field}: position must be "start", "end", {before: key}, {after: key} or {index: n}.` });
  }
  const k = pos.before ?? pos.after;
  const i = work.findIndex((w) => w.key === k);
  if (i < 0) throw keyError(work, k, field);
  return pos.before !== undefined ? i : i + 1;
}

/**
 * Apply row ops to one list field. Returns { list, summary }.
 * list: payload rows (components keep their id; new rows carry none; dynamic-zone rows keep __component).
 */
function applyRowOps(strapi, uid, field, attr, kind, current, ops, refs, scope, keyRows, fx = null) {
  // Every key is the one ws_get showed for the CURRENT row (content-bound, 1.0 hardening item 16b), computed once before
  // the ops run: later ops of the same call name rows by the keys the agent read, not by keys after earlier ops.
  // keyRows: the same rows as read (raw), so a relation's linked locale is in the key (re-review N5); `current` holds
  // them normalized, as they are written back.
  const work = (current || []).map((row, i) => ({ key: M.rowHandle(strapi, kind, attr, (keyRows && keyRows[i]) || row, i, scope), row, isNew: false }));
  const summary = { added: [], removed: [], updated: [], moved: [] };
  let n = 0;
  // keys this request names (and so has read): only they get their new key in the reply (phase 2 A review, finding 1)
  const named = new Set();
  const find = (key) => {
    const i = work.findIndex((w) => w.key === key);
    if (i < 0) throw keyError(work, key, field);
    named.add(key);
    return i;
  };
  for (const [j, op] of ops.entries()) {
    const where = `ops[${j}] (${op.op} on ${field})`;
    if (RO.isRefOp(op)) {
      // 1.0 hardening item 20: a ref op inside one row (key + path) edits that row's nested relation or media list only
      if (!fx) throw new WsError({ code: 'invalid', message: `${where}: ref ops are not accepted here.` });
      if (kind === 'blocks') throw new WsError({ code: 'invalid', message: `${where}: ref ops apply to relations and media, not to blocks.` });
      const i = find(op.key);
      const cuid = kind === 'dynamiczone' ? work[i].row.__component : attr.component;
      const leaf = RO.pathAttr(strapi, cuid, op.path, where);
      const res = RO.applyRefInRow(strapi, cuid, work[i].row, leaf.path, [op], fx.idOf(leaf.kind));
      fx.status.set(op, res.statuses[0]);
      fx.check(leaf, op, where);
      if (res.changed) {
        work[i] = { ...work[i], row: res.row };
        if (!summary.updated.includes(op.key)) summary.updated.push(op.key);
      }
      continue;
    }
    if (op.op === 'add') {
      let row;
      if (kind === 'dynamiczone') {
        if (!attr.components.includes(op.component)) throw new WsError({ code: 'invalid', message: `${where}: component must be one of ${attr.components.join(', ')}` });
        checkComponentData(strapi, op.component, op.data, where, refs);
        row = { __component: op.component, ...stripMeta(op.data) };
      } else if (kind === 'repeatable') {
        checkComponentData(strapi, attr.component, op.data, where, refs);
        row = stripMeta(op.data);
      } else {
        if (!op.data || typeof op.data !== 'object' || !op.data.type) throw new WsError({ code: 'invalid', message: `${where}: a blocks node needs a type` });
        row = op.data;
      }
      const at = resolvePos(work, op.position, field);
      const key = `new:${n++}`;
      work.splice(at, 0, { key, row, isNew: true });
      summary.added.push(key);
    } else if (op.op === 'update') {
      const i = find(op.key);
      if (kind === 'blocks') {
        if (!op.data || typeof op.data !== 'object' || !op.data.type) throw new WsError({ code: 'invalid', message: `${where}: a blocks node needs a type (update replaces the node)` });
        work[i] = { ...work[i], row: op.data };
      } else {
        const cuid = kind === 'dynamiczone' ? work[i].row.__component : attr.component;
        checkComponentData(strapi, cuid, op.data, where, refs);
        // a nested list (relation, media, repeatable) replaced by this update needs a version (item 20, nested lists)
        if (fx) fx.nested.push(...RO.nestedListChanges(strapi, cuid, stripMeta(op.data), work[i].row, field));
        work[i] = { ...work[i], row: mergeRow(strapi, cuid, work[i].row, stripMeta(op.data)) };
      }
      summary.updated.push(op.key);
    } else if (op.op === 'remove') {
      const i = find(op.key);
      work.splice(i, 1);
      summary.removed.push(op.key);
    } else if (op.op === 'move') {
      const i = find(op.key);
      const [w] = work.splice(i, 1);
      work.splice(resolvePos(work, op.position, field), 0, w);
      summary.moved.push(op.key);
    } else {
      const ext = MOD.ops()[op.op];
      if (!ext) throw new WsError({ code: 'invalid', message: `${where}: op must be ${['add', 'update', 'remove', 'move', ...Object.keys(MOD.ops())].join(', ')}` });
      ext.apply({
        strapi, uid, field, attr, kind, work, op, index: j, where, refs, summary, WsError,
        find, resolvePos: (pos) => resolvePos(work, pos, field), newKey: () => `new:${n++}`,
        checkComponentData: (cuid, data) => checkComponentData(strapi, cuid, data, where, refs),
      });
    }
  }
  if (kind !== 'blocks') {
    // New rows never carry an id (an extension op such as copy may start from an existing row), and an existing row
    // may appear once: two entries with one id would make two places in the list share one database row.
    const seen = new Set();
    for (const w of work) {
      if (w.isNew) {
        const { id, ...rest } = w.row || {};
        w.row = rest;
        if (kind === 'dynamiczone' && !attr.components.includes(w.row.__component)) throw new WsError({ code: 'invalid', message: `${field}: new row has component ${w.row.__component}; allowed: ${attr.components.join(', ')}` });
      } else if (seen.has(w.key)) {
        throw new WsError({ code: 'invalid', field, key: w.key, message: `${field}: row ${w.key} appears twice after the ops` });
      } else seen.add(w.key);
    }
  }
  for (const op of ops) {
    const p = op && op.position;
    if (p && typeof p === 'object') for (const k of [p.before, p.after]) if (typeof k === 'string' && work.some((w) => w.key === k)) named.add(k);
  }
  return { list: work.map((w) => w.row), work, summary, named };
}

/** Map a `set` of a whole list: rows carrying _key keep their row (id); rows without are new. */
function listFromSet(strapi, field, attr, kind, current, value, refs, scope, keyRows) {
  if (!Array.isArray(value)) throw new WsError({ code: 'invalid', message: `set.${field} must be an array` });
  if (kind === 'blocks') return value;
  // the current rows by the keys ws_get shows (content-bound, 1.0 hardening item 16b)
  const curWork = (current || []).map((r, i) => ({ key: M.rowHandle(strapi, kind, attr, (keyRows && keyRows[i]) || r, i, scope), row: r, isNew: false }));
  const byKey = new Map(curWork.map((w) => [w.key, w.row]));
  const seenKeys = new Set();
  return value.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new WsError({ code: 'invalid', message: `set.${field}[${i}] must be an object` });
    const cuid = kind === 'dynamiczone' ? r.__component : attr.component;
    if (kind === 'dynamiczone' && !attr.components.includes(cuid)) throw new WsError({ code: 'invalid', message: `set.${field}[${i}].__component must be one of ${attr.components.join(', ')}` });
    checkComponentData(strapi, cuid, kind === 'dynamiczone' ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== '__component')) : r, `set.${field}[${i}]`, refs);
    if (r._key) {
      const cur = byKey.get(r._key);
      if (!cur) throw keyError(curWork, r._key, field, `set.${field}[${i}]`);
      // 1.0 key safety: a row keeps its identity only as the component it is. Sending a dynamic-zone row's _key with
      // another __component would carry the row's id over to a different component table, where that id is another
      // document's row. One key may also appear only once (two rows cannot share one database row).
      if (kind === 'dynamiczone' && r.__component !== cur.__component) {
        throw new WsError({ code: 'invalid', field, key: r._key, message: `set.${field}[${i}]: _key ${r._key} is a ${cur.__component} row; __component ${r.__component} does not match. Drop _key to add a new row.` });
      }
      if (seenKeys.has(r._key)) throw new WsError({ code: 'invalid', field, key: r._key, message: `set.${field}[${i}]: _key ${r._key} appears twice. Drop _key on the copy to add a new row.` });
      seenKeys.add(r._key);
      return mergeRow(strapi, cuid, cur, stripMeta(r));
    }
    return stripMeta(r);
  });
}

function mapStrapiError(e) {
  if (e instanceof WsError || e instanceof DryRun || e instanceof BatchAbort) return e;
  if (e instanceof strapiErrors.ValidationError || e?.name === 'ValidationError') {
    return new WsError({ code: 'invalid', message: e.message, details: e.details?.errors?.map((x) => ({ path: x.path, message: x.message })) });
  }
  if (e instanceof strapiErrors.ForbiddenError || e?.name === 'ForbiddenError') return new WsError({ code: 'forbidden', message: e.message || 'Forbidden' });
  if (e instanceof strapiErrors.NotFoundError || e?.name === 'NotFoundError') return new WsError({ code: 'not_found', message: e.message });
  if (e?.name === 'ApplicationError') return new WsError({ code: 'invalid', message: e.message });
  // The database's or driver's own text goes into `driver_error`, never into the message (phase 1 review, item 8): it
  // can quote values. The write may or may not have landed (a failure at COMMIT), so the caller re-reads first.
  const w = new WsError({ code: 'write_failed', message: 'The write failed in the database. It may or may not have been stored: read the document again before retrying. driver_error has the database\'s own text.', driver_error: String(e?.message || e).slice(0, 2000) });
  w.cause = e;
  return w;
}

/** One version-checked patch. Must run inside a transaction. */
async function applyPatch(strapi, ctx, a) {
  const { uid } = a;
  checkUid(strapi, uid);
  assertVersion(a.expected_version);
  checkPublishArg(strapi, uid, a);
  const matchKeys = ifMatchKeys(strapi, uid, a);
  const locale = await resolveLocale(strapi, uid, a.locale);
  const documentId = await resolveDocumentId(strapi, uid, a.documentId, locale);
  const raw = await lockAndRead(strapi, uid, documentId, locale);
  const doc = M.normalize(strapi, uid, raw); // relations as documentIds: hashed, shown and written back in this form
  const pc = permissionChecker(strapi, ctx, uid);
  if (pc.cannot.update(raw)) throw new WsError({ code: 'forbidden', message: `This token cannot update ${uid} ${documentId}.` });
  if (a.publish && pc.cannot.publish(raw)) {
    throw new WsError({ code: 'forbidden', message: `This token cannot publish ${uid} ${documentId}: leave out publish. Nothing was written.` });
  }

  const attrs = M.attrsOf(strapi, uid);
  const set = a.set || {};
  const unset = a.unset || [];
  const ops = a.ops || [];
  const touched = [...new Set([...Object.keys(set), ...unset, ...ops.map((o) => o.field)])];
  if (!touched.length) throw new WsError({ code: 'invalid', message: 'Nothing to change: give set, unset or ops.' });
  for (const f of touched) {
    if (!attrs[f] || M.SKIP_KEYS.has(f)) throw new WsError({ code: 'invalid', message: `Unknown or read-only field ${f}`, allowed: Object.keys(attrs).filter((k) => !M.SKIP_KEYS.has(k)) });
  }
  if (a.expected_version !== undefined && !M.versionMatches(strapi, uid, a.expected_version, raw)) {
    throw await conflict(strapi, pc, uid, raw, a.expected_version, touched);
  }
  // The owner's rule (1.0 hardening items 3 and 16c): `set` and `unset` need expected_version (or force); row `ops`
  // never do. A field set from a stale read overwrites a colleague's newer value; a list (dynamic zone, repeatable
  // component, blocks, to-many relation, multiple media) replaced whole also drops what they added (fourth review N3).
  // Row ops edit the CURRENT list by content-bound keys (item 16b), so they stay mergeable without a version.
  const fieldWrites = [...new Set([...Object.keys(set), ...unset])];
  // without expected_version, if_match must name every field set or unset (readability is checked first)
  const changedMatch = matchKeys ? await ifMatchChanged(strapi, pc, uid, raw, a.if_match) : [];
  if (fieldWrites.length && a.expected_version === undefined && !a.force && matchKeys) {
    const missing = fieldWrites.filter((f) => !matchKeys.includes(f));
    if (missing.length) {
      throw new WsError({
        code: 'precondition_required', field: missing[0], fields: missing,
        message: `Without expected_version, if_match needs an entry for every field set or unset; missing: ${missing.join(', ')}. Nothing was written.`,
      });
    }
  } else if (fieldWrites.length && a.expected_version === undefined && !a.force) {
    // the nested lists such a set or unset would replace or clear are named in the same refusal (stream F, item 20)
    const nestedOf = [];
    for (const [f, v] of Object.entries(set)) {
      if (!attrs[f] || attrs[f].type !== 'component' || attrs[f].repeatable) continue;
      if (v === null) { if (doc[f] != null && RO.hasNestedList(strapi, attrs[f].component)) nestedOf.push(f); } else nestedOf.push(...RO.nestedListChanges(strapi, attrs[f].component, stripMeta(v), doc[f], f));
    }
    throw preconditionFields(fieldWrites, attrs, nestedOf);
  }
  if (changedMatch.length) {
    throw await conflict(strapi, pc, uid, raw, a.expected_version, changedMatch, {
      message: 'A field named in if_match changed after you read it. Nothing was written.',
      fields_changed: changedMatch,
      retry: { hint: IF_MATCH_HINT, expected_version: versionOfRaw(strapi, uid, raw) },
    });
  }
  // Ref ops (1.0 hardening item 20): checked against the schema before anything else. Ops on a top-level relation or
  // media list or inside a single component are applied here; ops inside a row (key + path) go with the row ops.
  const refOps = ops.filter(RO.isRefOp);
  const refInfo = new Map(refOps.map((o) => [o, RO.refTarget(strapi, uid, o, `ops[${ops.indexOf(o)}] (${o.op} on ${o.field})`)]));
  const atField = (o) => refInfo.has(o) && (refInfo.get(o).container === null || refInfo.get(o).container === 'component');
  const rowOps = ops.filter((o) => !atField(o));
  // The token must be allowed to write the field (or the field inside the component) of every ref op, also when the op
  // turns out to change nothing: the answer must not depend on links it may not change.
  for (const o of refOps) {
    const t = refInfo.get(o);
    const p = t.container === null || t.container === 'dynamiczone' ? o.field : `${o.field}.${t.path.join('.')}`;
    if (pc.cannot.update(raw, p)) throw new WsError({ code: 'forbidden', message: `This token cannot write field(s): ${p}. Nothing was written.` });
  }
  const refStatus = new Map();
  const refChecks = [];
  // Media identity: a file is linked by documentId (as ws_get shows it) or numeric id. Both the refs and the files the
  // draft links now are resolved to one id, so "already linked" and "not linked" are decided by file, not by spelling.
  let fileIds = new Map();
  if (refOps.length) {
    const linked = [...currentRefs(strapi, uid, doc)].filter((k) => k.startsWith('file:')).map((k) => k.slice(5)).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    fileIds = (await MEDIA.readableFiles(strapi, ctx && ctx.userAbility, [...refOps.map((o) => o.ref), ...linked])).all;
  }
  const idOf = (k) => (k === 'media' ? (x) => (Number.isInteger(x) ? x : (fileIds.get(x) ? fileIds.get(x).id : x)) : (x) => x);
  // every ref of a ref op must exist and be readable (add and remove alike, so the answer is no oracle); media added
  // must be of an allowed type
  const refCheck = (leaf, o, where) => refChecks.push(leaf.kind === 'media'
    ? { media: true, file: o.ref, allowedTypes: o.op === 'add' ? leaf.attr.allowedTypes || null : null, where }
    : { target: leaf.attr.target, documentId: o.ref, where });
  const nested = []; // nested lists a set or an update op would replace whole (item 20): they need a version
  const fx = { status: refStatus, check: refCheck, idOf, nested };

  const data = {};
  const rowSummary = {};
  const refs = [];
  for (const [f, v] of Object.entries(set)) {
    const kind = M.fieldKind(attrs[f]);
    if (ops.some((o) => o.field === f)) throw new WsError({ code: 'invalid', message: `Field ${f} is in both set and ops; use one.` });
    if (M.isListKind(kind)) {
      data[f] = listFromSet(strapi, f, attrs[f], kind, doc[f], v, refs, M.keyScope(uid, documentId, raw.locale || null, f), raw[f]);
    } else if (kind === 'component') {
      if (v === null) {
        // clearing a component that holds lists drops them whole (review L1)
        if (doc[f] != null && RO.hasNestedList(strapi, attrs[f].component)) nested.push(f);
        data[f] = null;
      } else {
        checkComponentData(strapi, attrs[f].component, v, `set.${f}`, refs);
        nested.push(...RO.nestedListChanges(strapi, attrs[f].component, stripMeta(v), doc[f], f));
        data[f] = mergeRow(strapi, attrs[f].component, doc[f], stripMeta(v)); // merge: the row (and its id) is kept
      }
    } else if (kind === 'relation' || kind === 'media') {
      // 1.0: top-level relations (documentIds, replaced as a whole) and media (existing files) through set
      if (kind === 'relation' && !attrs[f].target) throw new WsError({ code: 'unsupported', message: `Field ${f} is a polymorphic relation; not supported.` });
      checkRefValue(attrs[f], f, v, `set.${f}`, refs);
      data[f] = v;
    } else {
      data[f] = v;
    }
  }
  for (const f of unset) {
    if (f in data) throw new WsError({ code: 'invalid', message: `Field ${f} is in both set and unset.` });
    const at = attrs[f];
    // unset of a list is set: [] (needs a version, review L1); so is unset of a component holding lists
    if (M.isListAttr(at) || (at.type === 'component' && !at.repeatable && doc[f] != null && RO.hasNestedList(strapi, at.component))) nested.push(f);
    data[f] = M.isListKind(M.fieldKind(at)) || (at.type === 'relation' && M.isToMany(at)) || (at.type === 'media' && at.multiple) ? [] : null;
  }
  // [bulk stream hook] module row ops may prepare asynchronously before the (synchronous) row-op pass, e.g. `copy`
  // reads its source rows with the caller's permissions (server/modules/copy).
  const extOps = MOD.ops();
  for (const o of ops) if (extOps[o.op] && extOps[o.op].prepare) await extOps[o.op].prepare({ strapi, ctx, uid, documentId, locale: locale || null, raw, doc, op: o, pc, WsError });
  // ref ops on a top-level to-many relation / multiple media field, or inside a single component (path)
  for (const f of [...new Set(ops.filter(atField).map((o) => o.field))]) {
    if (f in data) throw new WsError({ code: 'invalid', message: `Field ${f} is in both unset and ops.` });
    const fops = ops.filter((o) => atField(o) && o.field === f);
    if (M.fieldKind(attrs[f]) === 'component') {
      let row = doc[f] == null ? null : doc[f];
      // the baseline: the current component with the touched lists as they read (a missing component or list as empty),
      // so ops that change nothing write nothing, also on a document without the component (review M4)
      let base = row;
      for (const o of fops) {
        const t = refInfo.get(o);
        base = RO.applyRefInRow(strapi, attrs[f].component, base, t.path, [], idOf(t.kind)).row;
        const res = RO.applyRefInRow(strapi, attrs[f].component, row, t.path, [o], idOf(t.kind));
        row = res.row;
        refStatus.set(o, res.statuses[0]);
        refCheck(t, o, `ops[${ops.indexOf(o)}] (${o.op} on ${f}.${t.path.join('.')})`);
      }
      if (M.canonical(row) !== M.canonical(base)) data[f] = row;
    } else if (refInfo.get(fops[0]).kind === 'relation') {
      // a relation: connect/disconnect of only the changed links (review M5), never the whole list
      const t = refInfo.get(fops[0]);
      const res = RO.relationOps(doc[f] || [], fops, isLocalized(strapi, t.attr.target) ? (locale || null) : null);
      fops.forEach((o, i) => { refStatus.set(o, res.statuses[i]); refCheck(t, o, `ops[${ops.indexOf(o)}] (${o.op} on ${f})`); });
      if (res.payload) data[f] = res.payload;
    } else {
      // multiple media: no connect form for files; the list computed from the current one under the row lock
      const t = refInfo.get(fops[0]);
      const res = RO.applyRefList(doc[f] || [], fops, idOf(t.kind));
      fops.forEach((o, i) => { refStatus.set(o, res.statuses[i]); refCheck(t, o, `ops[${ops.indexOf(o)}] (${o.op} on ${f})`); });
      if (res.changed) data[f] = res.list;
    }
  }
  const opFields = [...new Set(rowOps.map((o) => o.field))];
  const works = {};
  const named = {};
  for (const f of opFields) {
    const kind = M.fieldKind(attrs[f]);
    if (!M.isListKind(kind)) throw new WsError({ code: 'invalid', message: `ops only apply to dynamic zones, repeatable components and blocks fields (and, as ref ops, to to-many relations and multiple media); ${f} is ${kind}` });
    if (f in data) throw new WsError({ code: 'invalid', message: `Field ${f} is in both unset and ops.` });
    const fops = rowOps.filter((o) => o.field === f);
    const r = applyRowOps(strapi, uid, f, attrs[f], kind, doc[f], fops, refs, M.keyScope(uid, documentId, raw.locale || null, f), raw[f], fx);
    // a field touched only by ref ops that changed nothing is not written
    if (fops.every(RO.isRefOp) && M.canonical(r.list) === M.canonical(doc[f] || [])) continue;
    data[f] = r.list;
    works[f] = r.work;
    named[f] = r.named;
    rowSummary[f] = r.summary;
  }
  // a nested list inside a field if_match names is covered (the whole field was compared)
  const nestedOpen = [...new Set(nested)].filter((p) => !(matchKeys && matchKeys.includes(p.split('.')[0])));
  if (nestedOpen.length && a.expected_version === undefined && !a.force) throw preconditionFields([], attrs, nestedOpen);
  if (refChecks.length) await checkRefs(strapi, refChecks, ctx, new Set(), { locale });
  const refsView = refOps.length ? refOps.map((o) => ({
    op: o.op, field: o.field, ...(o.key !== undefined ? { key: o.key } : {}), ...(o.path != null ? { path: RO.segsOf(o.path).join('.') } : {}), ref: o.ref, status: refStatus.get(o),
  })) : null;
  if (!Object.keys(data).length) {
    // only ref ops, and every one changed nothing: nothing is written (no new version, no receipt)
    const v = versionOfRaw(strapi, uid, raw);
    return {
      ok: true, unchanged: true, documentId, locale: raw.locale || null, previous_version: v, version: v, changed: [], refs: refsView,
      ...(a.publish ? { published: false, publish_skipped: 'nothing_changed' } : {}),
    };
  }
  // if_clean: draft vs live before this patch, under the draft's row lock
  const clean = a.publish ? await cleanState(strapi, uid, documentId, locale, raw) : null;

  const subPaths = new Set(changedSubPaths(strapi, attrs, { set: a.set, unset: a.unset }, doc));
  for (const f of opFields) if (works[f]) for (const p of changedSubPathsOfWork(strapi, attrs, f, works[f], doc[f])) subPaths.add(p);
  const deniedSub = [...subPaths].filter((path) => pc.cannot.update(raw, path));
  if (deniedSub.length) throw new WsError({ code: 'forbidden', message: `This token cannot write field(s): ${deniedSub.join(', ')}. Nothing was written.` });
  await checkRefs(strapi, refs, ctx, currentRefs(strapi, uid, doc), { locale });
  const sanitized = await pc.sanitizeUpdateInput(raw)(data);
  const dropped = Object.keys(data).filter((k) => !(k in (sanitized || {})));
  if (dropped.length) throw new WsError({ code: 'forbidden', message: `This token cannot write field(s): ${dropped.join(', ')}. Nothing was written.` });
  const payload = setCreatorFields({ user: ctx.user, isEdition: true })(sanitized);
  const info = {
    tool: a._tool || 'ws_patch', action: 'patch', uid, documentId, locale: locale || null, args: a, dryRun: Boolean(a.dry_run),
    data: payload, sanitize: (d) => pc.sanitizeOutput(d), raw: { before: doc },
  };
  await MOD.beforeWrite(ctx, info);

  let updatedRaw;
  try {
    // The version was checked above under the row lock. When the running Strapi has its own baseVersion check
    // (strapi/strapi#27506), the same updatedAt is passed through so both checks agree (compat/base-version.js).
    updatedRaw = await BV.update(strapi, uid, {
      documentId, ...(locale ? { locale } : {}), data: await MEDIA.toFileIds(strapi, uid, payload), populate: M.populateFor(strapi, uid),
    }, { baseVersion: M.isoOf(raw.updatedAt), draftAndPublish: hasDP(strapi, uid) });
  } catch (e) {
    if (!(e instanceof BV.BaseVersionConflict)) throw e;
    const fresh = await lockAndRead(strapi, uid, documentId, locale);
    if (versionOfRaw(strapi, uid, fresh) !== versionOfRaw(strapi, uid, raw)) {
      throw await conflict(strapi, pc, uid, fresh, a.expected_version ?? versionOfRaw(strapi, uid, raw), touched, { detected_by: 'strapi_base_version' });
    }
    // The draft is exactly what was verified under this write's own lock, so Strapi's check disagrees with the
    // plugin's reading of updatedAt (precision or format), not with another writer. Reporting a conflict would send
    // the agent into a retry loop (current_version would equal expected_version). Turn the passthrough off and write.
    BV.disable(`Strapi's baseVersion check refused a version the plugin had just verified under its lock (${e.details?.expected ?? '?'} vs ${e.details?.current ?? '?'})`);
    strapi.log.warn(`[writesafe] ${BV.state.reason}; baseVersion passthrough turned off`);
    updatedRaw = await BV.update(strapi, uid, {
      documentId, ...(locale ? { locale } : {}), data: await MEDIA.toFileIds(strapi, uid, payload), populate: M.populateFor(strapi, uid),
    }, { draftAndPublish: false });
  }
  const updated = M.normalize(strapi, uid, updatedRaw);
  // The new row keys (1.0 hardening item 16b): keys are content-bound, so a row this write changed has a new key, and
  // new rows get theirs from their final positions. The reply returns new keys ONLY for rows this request added or
  // named by key (`added`, `rekeyed` {old key: new key}); never a list of every key (phase 2 A review, finding 1: a
  // `keys_after` list handed out fresh keys of rows a colleague changed, so the agent could overwrite them unread).
  const sc = (f) => M.keyScope(uid, documentId, raw.locale || null, f);
  for (const f of opFields.filter((x) => works[x])) {
    const kind = M.fieldKind(attrs[f]);
    const after = M.rowHandles(strapi, kind, attrs[f], updatedRaw[f], sc(f));
    const map = {};
    const rekeyed = {};
    works[f].forEach((w, i) => {
      if (w.isNew) map[w.key] = after[i];
      else if (named[f].has(w.key) && after[i] !== undefined && after[i] !== w.key) rekeyed[w.key] = after[i];
    });
    rowSummary[f].added = rowSummary[f].added.map((k) => map[k] || k);
    if (Object.keys(rekeyed).length) rowSummary[f].rekeyed = rekeyed;
  }
  for (const f of Object.keys(set)) {
    const kind = M.fieldKind(attrs[f]);
    if (M.isListKind(kind)) {
      const before = M.rowHandles(strapi, kind, attrs[f], raw[f], sc(f));
      const after = M.rowHandles(strapi, kind, attrs[f], updatedRaw[f], sc(f));
      const ids = (l) => new Set(l.map(M.keyIdentity));
      const bi = ids(before);
      const ai = ids(after);
      // every row of a whole-list set came from the request: kept rows by their `_key`, new rows without one
      const sent = new Map((Array.isArray(set[f]) ? set[f] : []).filter((r) => r && r._key).map((r) => [M.keyIdentity(r._key), r._key]));
      const rekeyed = {};
      for (const k of after) { const old = sent.get(M.keyIdentity(k)); if (old && old !== k) rekeyed[old] = k; }
      rowSummary[f] = {
        replaced: true, kept: after.filter((k) => bi.has(M.keyIdentity(k))).length,
        removed: before.filter((k) => !ai.has(M.keyIdentity(k))).map(M.keyIdentity), added: after.filter((k) => !bi.has(M.keyIdentity(k))),
        ...(Object.keys(rekeyed).length ? { rekeyed } : {}),
      };
    }
  }
  const receipt = {
    ok: true, documentId, locale: updated.locale || null,
    previous_version: versionOfRaw(strapi, uid, raw), version: versionOfRaw(strapi, uid, updatedRaw),
    changed: touched.filter((f) => f in data),
  };
  if (Object.keys(rowSummary).length) receipt.rows = rowSummary;
  if (refsView) receipt.refs = refsView;
  if (MOD.hasAfterWrite()) {
    // Modules get the token's view of the draft (hidden fields removed): what they return is shown to the caller in
    // receipt.modules and replayed on retries. The full drafts are in info.raw for data a module keeps to itself.
    info.raw.after = updated;
    info.versions = { before: receipt.previous_version, after: receipt.version };
    const view = async (r) => M.normalize(strapi, uid, await pc.sanitizeOutput(r));
    const moduleData = await MOD.afterWrite(ctx, info, await view(raw), await view(updatedRaw));
    if (moduleData) receipt.modules = moduleData;
  }
  // a clean draft the patch left as it was (same version) is already live
  let pub = clean === 'clean' && receipt.version === receipt.previous_version ? 'nothing_changed' : clean;
  if (pub === 'clean') {
    // Strapi's publish validation (required, unique, ...), read-only: a draft it would refuse stays a draft, written
    try {
      await PREVIEW.validatePublish(strapi, uid, documentId, locale || raw.locale || null, updatedRaw);
    } catch (e) {
      if (!(e instanceof strapiErrors.ValidationError || e?.name === 'ValidationError')) throw e;
      pub = 'publish_invalid';
      const errs = (e.details && Array.isArray(e.details.errors)) ? e.details.errors : [];
      receipt.publish_invalid_paths = [...new Set(errs.map((x) => (Array.isArray(x.path) ? x.path.join('.') : String(x.path || ''))).filter(Boolean))];
    }
  }
  if (pub !== null && a.dry_run) {
    // a dry run never calls Strapi's publish
    receipt.would_publish = pub === 'clean';
    if (pub !== 'clean') receipt.publish_skipped = pub;
  } else if (pub === 'clean') {
    // publish exactly the version just written, in this transaction
    const pinfo = {
      tool: a._tool || 'ws_patch', action: 'publish', uid, documentId, locale: locale || null, args: a, dryRun: false,
      sanitize: (d) => pc.sanitizeOutput(d), raw: { before: updated, after: updated }, versions: { before: receipt.version, after: receipt.version },
    };
    await MOD.beforeWrite(ctx, pinfo);
    await strapi.documents(uid).publish({ documentId, ...(locale ? { locale } : {}) });
    receipt.published = true;
    receipt.published_version = receipt.version;
    receipt.live_version = await liveVersionOf(strapi, uid, documentId, locale);
    if (MOD.hasAfterWrite()) {
      const pview = M.normalize(strapi, uid, await pc.sanitizeOutput(updatedRaw));
      const pdata = await MOD.afterWrite(ctx, pinfo, pview, pview);
      if (pdata) receipt.modules = { ...(receipt.modules || {}), ...pdata };
    }
  } else if (pub !== null) {
    receipt.published = false;
    receipt.publish_skipped = pub;
  }
  if (a.dry_run) {
    // 1.0 stretch (c): what the write would change, field by field (the token's view; rows matched by key)
    const view = async (r) => M.presentDoc(strapi, uid, await pc.sanitizeOutput(r), undefined, { documentId, locale: raw.locale || null, full: r }).data;
    receipt.diff = D.diffViews(D.kindsOf(strapi, uid), await view(raw), await view(updatedRaw), { fields: touched, matchRows: 'key' });
  }
  if (a.return === 'full') receipt.document = M.presentDoc(strapi, uid, await pc.sanitizeOutput(updatedRaw), undefined, { documentId, locale: locale || null, full: updatedRaw }).data;
  return receipt;
}

/** Version-checked publish of the current draft. Must run inside a transaction. */
/** The version of a document's live (published) row, or null when it has none. */
async function liveVersionOf(strapi, uid, documentId, locale) {
  const live = await strapi.documents(uid).findOne({ documentId, ...(locale ? { locale } : {}), status: 'published', populate: M.populateFor(strapi, uid) });
  return live ? versionOfRaw(strapi, uid, live) : null;
}

async function applyPublish(strapi, ctx, a) {
  const { uid } = a;
  checkUid(strapi, uid);
  if (!hasDP(strapi, uid)) throw new WsError({ code: 'invalid', message: `${uid} has no draft & publish` });
  assertVersion(a.expected_version);
  // The version is enforced here, not only in ws_publish's schema (1.0 hardening item 2): a ws_batch publish item
  // without one published whatever the draft held. ws_batch fills it in only after an earlier item of the same batch
  // patched the document under a version check (applyBatch).
  if (a.expected_version === undefined) {
    throw new WsError({ code: 'precondition_required', message: 'Publishing needs expected_version: read the draft with ws_get, have that version reviewed, and publish it with its version. Nothing was published.' });
  }
  const locale = await resolveLocale(strapi, uid, a.locale);
  const documentId = await resolveDocumentId(strapi, uid, a.documentId, locale);
  const raw = await lockAndRead(strapi, uid, documentId, locale);
  const doc = M.normalize(strapi, uid, raw);
  const pc = permissionChecker(strapi, ctx, uid);
  if (pc.cannot.publish(raw)) throw new WsError({ code: 'forbidden', message: `This token cannot publish ${uid} ${documentId}.` });
  if (!M.versionMatches(strapi, uid, a.expected_version, raw)) {
    throw await conflict(strapi, pc, uid, raw, a.expected_version, undefined, { message: 'The draft changed after you reviewed it. Nothing was published.' }, 'publish');
  }
  const info = {
    tool: a._tool || 'ws_publish', action: 'publish', uid, documentId, locale: locale || null, args: a, dryRun: Boolean(a.dry_run),
    sanitize: (d) => pc.sanitizeOutput(d), raw: { before: doc, after: doc },
    versions: { before: versionOfRaw(strapi, uid, raw), after: versionOfRaw(strapi, uid, raw) },
  };
  await MOD.beforeWrite(ctx, info);
  const goingLive = a.dry_run ? await liveDiff(strapi, pc, uid, documentId, locale, raw) : null; // before publishing
  // A dry run never calls Strapi's publish (phase 2 item 10, N7): its middlewares and lifecycle hooks would run.
  // preview.js runs the validation Strapi's publish runs instead, read-only.
  const check = a.dry_run ? await PREVIEW.validatePublish(strapi, uid, documentId, locale || doc.locale || null, raw) : null;
  if (!a.dry_run) await strapi.documents(uid).publish({ documentId, ...(locale ? { locale } : {}) });
  const out = { ok: true, action: 'publish', documentId, locale: doc.locale || null, published_version: versionOfRaw(strapi, uid, raw) };
  // The version of the live row this publish produced, read back in the transaction: a replay compares the live row
  // with it (MWS-RES-1). It can differ from published_version, e.g. a relation to a target that is only a draft.
  if (!a.dry_run) out.live_version = await liveVersionOf(strapi, uid, documentId, locale);
  if (check) {
    out.preview = true;
    if (check.note) out.preview_note = check.note;
  }
  if (goingLive) {
    out.diff = goingLive.diff;
    out.live_existed = goingLive.exists;
    if (goingLive.note) out.diff_note = goingLive.note;
  }
  if (MOD.hasAfterWrite()) {
    const view = M.normalize(strapi, uid, await pc.sanitizeOutput(raw));
    const moduleData = await MOD.afterWrite(ctx, info, view, view);
    if (moduleData) out.modules = moduleData;
  }
  return out;
}

/**
 * Keys are scoped to the token, the tool and (for single-document tools) the target document and locale.
 * Why: in the native-agent runs, agents in separate sessions chose the same readable key ("garden-open-day-hero...")
 * for different documents and were refused with idempotency_key_reused (3 of 5 runs). A key reused on another
 * document is never a retry of the same change, so it must not collide.
 * 0.2:
 * - Scoped by token, not only by the token's owner. Two agents with two tokens of one admin user shared one key space
 *   in 0.1.1, so the second agent's write was answered with the first agent's receipt and not made.
 *   Strapi passes only the owner's id to tool handlers, so the token is identified by a hash of the Bearer header.
 * - Stored as a sha256 (64 hex). The readable form could pass 255 characters (a 200-character key on a localized type),
 *   and Postgres then refused every write with that key ("value too long for type character varying(255)").
 */
const scopedKey = (ctx, extra, tool, args) => {
  const who = tokenScope(ctx, extra);
  const target = tool === 'ws_batch' ? '' : `${args.uid}:${args.documentId || ''}:${args.locale || ''}`;
  return M.sha(`${who}|${tool}|${target}|${args.idempotency_key}`);
};

/**
 * The per-token scope of idempotency keys and jobs: the user id plus a hash of the request's Authorization header.
 * Without the header there is no per-token identity, and two tokens of one user would share keys and jobs (they could
 * be answered with each other's receipts or resume each other's jobs), so keys and jobs are refused instead
 * (1.0 hardening item 7; rc.2 fell back to the user id with a warning).
 */
function tokenScope(ctx, extra) {
  const auth = MCP.authHeader(null, extra);
  if (!auth) {
    throw new WsError({ code: 'unsupported', message: 'idempotency_key and jobs need a per-token identity, and this request carries no Authorization header that the plugin can see. Leave idempotency_key out (or report this: the Strapi version may pass request headers differently). Nothing was written.' });
  }
  return `${ctx.user?.id ?? 'anon'}:${M.sha(auth).slice(0, 16)}`;
}

/**
 * Keys and replays need the receipts table's unique index (1.0 hardening item 7): without it two concurrent retries
 * with one key can both write. ensureReceiptIndex records whether the index exists; until it does, keys are refused.
 */
const KEYS = { indexed: null, reason: null };
function requireUniqueIndex() {
  if (KEYS.indexed === true) return;
  throw new WsError({ code: 'unsupported', message: `idempotency_key and jobs are unavailable: the plugin could not ensure the unique index on its receipts table (${KEYS.reason || 'not checked yet'}). Leave idempotency_key out; an admin should check the server log. Nothing was written.` });
}

/**
 * The arguments with documentId and locale resolved (single type's document, default locale), so one document has one
 * idempotency scope and one request hash however it is addressed (1.0 hardening item 9; fourth review N25: naming the
 * default locale on the first call and omitting it on the retry wrote twice). Resolution failures are left to the
 * write itself, which reports them.
 */
async function resolvedArgs(strapi, tool, args) {
  if (!args || !args.uid || tool === 'ws_batch' || !writableUids(strapi).includes(args.uid)) return args;
  const out = { ...args };
  try {
    if (!args.all_locales && isLocalized(strapi, args.uid)) out.locale = await resolveLocale(strapi, args.uid, args.locale);
    if (isSingle(strapi, args.uid)) out.documentId = await resolveDocumentId(strapi, args.uid, args.documentId, out.locale);
  } catch {
    return args;
  }
  return out;
}

/**
 * `targets` column of a receipt row: "|<uid>~<documentId>~<locale>|...|", every document/locale the write touched
 * (the same format the history module writes, so ws_history and modules filter one column with $contains). With a
 * result, the resolved documentId and locale are used (a single type's id, the default locale), so one document has one
 * target however it was addressed; a batch lists its items. null when the write names no document (module tools such
 * as ws_undo: the history module fills the column for them).
 * 1.0.0-rc.2 replaces rc.1's single-target `target` column (see the plugin README, Upgrading).
 */
const targetsOf = (list) => (list.length ? `|${[...new Set(list.map((t) => `${t.uid}~${t.documentId || ''}~${t.locale || ''}`))].join('|')}|` : null);
const receiptTargets = (tool, args, result) => {
  if (tool === 'ws_batch') {
    const items = Array.isArray(args.items) ? args.items : [];
    const done = result && Array.isArray(result.items) ? result.items : [];
    return targetsOf(items.map((it, i) => (it && it.uid ? { uid: it.uid, documentId: (done[i] && done[i].documentId) || it.documentId, locale: (done[i] && done[i].locale) || it.locale } : null)).filter(Boolean));
  }
  if (!args.uid) return null;
  return targetsOf([{ uid: args.uid, documentId: (result && result.documentId) || args.documentId, locale: (result && result.locale) || args.locale }]);
};

function requestHash(tool, args) {
  const a = { ...args };
  delete a.idempotency_key;
  return M.sha(M.canonical({ tool, a }));
}

/**
 * Run fn in a transaction with optional idempotency and dry run.
 * fn returns the success payload; WsError/BatchAbort propagate as errors (and roll back).
 */
/**
 * A unique-index violation (Postgres 23505, MySQL ER_DUP_ENTRY, SQLite SQLITE_CONSTRAINT_UNIQUE). Other constraint
 * failures (not-null, foreign key, check) are real write errors, never a race of two identical requests (phase 2 A
 * review, finding 3: a bare SQLITE_CONSTRAINT matched them, and the agent was told to retry forever).
 */
const isUniqueViolation = (e) => {
  const m = [e?.code, e?.message, e?.cause?.code, e?.cause?.message, e?.payload?.driver_error].filter(Boolean).join(' ');
  return /\b23505\b|SQLITE_CONSTRAINT_UNIQUE|ER_DUP_ENTRY|UNIQUE constraint failed|duplicate key value|Duplicate entry/i.test(m);
};

/**
 * The stored reply of an earlier identical request, or null.
 * Implicit claims (item 16d) answer retries for retention.implicitClaimMinutes only (re-review N1: a 72-hour claim
 * turned a deliberate re-run, e.g. a delete a human had undone, into a silent replay): an older claim is released here
 * (its row deleted, or turned into a plain history row) and the request runs as new.
 */
async function storedOutcome(strapi, key, rh, args, implicit = false) {
  const q = strapi.db.query(RECEIPT_UID);
  const prior = await q.findOne({ where: { key } });
  if (!prior || !prior.receipt) return null;
  if (implicit) {
    const RET = require('./retention');
    const mins = RET.opts().implicitClaimMinutes;
    const at = prior.createdAt ? new Date(prior.createdAt).getTime() : NaN;
    if (mins > 0 && Number.isFinite(at) && Date.now() - at > mins * 60000) {
      if (prior.receiptId) await q.update({ where: { id: prior.id }, data: { key: `h:${prior.receiptId}`, requestHash: null, receipt: RET.stripReceipt(prior.receipt) } });
      else await q.delete({ where: { id: prior.id } });
      return null;
    }
  }
  if (prior.requestHash !== rh) {
    if (implicit) {
      // cannot happen unless two requests share a sha256: the implicit key is derived from the request hash itself
      throw new WsError({ code: 'implicit_key_conflict', requires_reread: true, message: 'An earlier request with another content is recorded under this request\'s implicit retry record. Nothing was written. Read the document again and resend, or send an idempotency_key.' });
    }
    throw new WsError({ code: 'idempotency_key_reused', message: 'This idempotency_key was already used for a different request. Use a new key for a new change.', idempotency_key: args.idempotency_key });
  }
  return { ...prior.receipt, replayed: true };
}

/**
 * A replayed reply says what it is and how to apply the change again on purpose (re-review N1): `current_version` is
 * the target's version NOW (null when it is gone; `current_versions` per item for a batch), and a hint. Read inside
 * the transaction.
 */
async function annotateReplay(strapi, tool, args, replay, implicit) {
  const cur = async (a, status = 'draft') => {
    try {
      if (!a || !a.uid || !writableUids(strapi).includes(a.uid)) return null;
      const locale = await resolveLocale(strapi, a.uid, a.locale);
      const documentId = await resolveDocumentId(strapi, a.uid, a.documentId, locale);
      const raw = await strapi.documents(a.uid).findOne({ documentId, ...(locale ? { locale } : {}), ...(hasDP(strapi, a.uid) ? { status } : {}), populate: M.populateFor(strapi, a.uid) });
      return raw ? versionOfRaw(strapi, a.uid, raw) : null;
    } catch {
      return null;
    }
  };
  const out = { ...replay };
  if (tool === 'ws_batch' && Array.isArray(args.items)) {
    // one entry per item, in item order (the items themselves stay as they were answered)
    out.current_versions = await Promise.all(args.items.map((it) => cur(it)));
  } else {
    out.current_version = await cur(args);
  }
  // An implicit record matches on the request alone. Since v3 tokens a draft that went A -> B -> A reads with a new
  // token, but some requests stay byte-identical after a change: an if_match precondition is a value, publish state is
  // not part of the draft's token (the same ws_publish after an unpublish), and a late retry. Answering one with the
  // stored success would report a change that is not in effect (MWS-RES-1). Replay only while the target still holds
  // what the first write produced; otherwise refuse, saying nothing was written.
  if (implicit) {
    const now = { current_version: out.current_version, current_versions: out.current_versions };
    // a publish produced a live version, not a draft version: compare the live one
    if (tool === 'ws_publish' || replay.published === true) now.live_version = await cur(args, 'published');
    if (tool === 'ws_batch' && Array.isArray(args.items)) {
      now.live_versions = await Promise.all(args.items.map((it) => (it && it.action === 'publish' ? cur(it, 'published') : null)));
    }
    // a delete produced "gone": every locale it deleted must still be gone
    if (tool === 'ws_delete') {
      const pv = replay.previous_version;
      const locs = pv && typeof pv === 'object' && !Array.isArray(pv) ? Object.keys(pv) : null;
      now.existing = (locs ? await Promise.all(locs.map((l) => cur({ ...args, locale: l }))) : [out.current_version]).filter(Boolean);
    }
    const sup = supersededSince(tool, args, replay, now);
    if (sup) throw supersededError(replay, sup, out);
  }
  out.hint = implicit
    ? 'Replayed: this is the reply of the identical request you sent before. It was applied once; nothing was written now. '
      + 'current_version is the version now. To apply this change again on purpose, read the document again (ws_get) and send the request with an idempotency_key.'
    : 'Replayed: this idempotency_key already answered this request; nothing was written now. current_version is the version now. '
      + 'To make another change, use a new idempotency_key.';
  return out;
}

/**
 * Whether the target of a replayed implicit record no longer holds what the first write produced (MWS-RES-1), or null.
 * - ws_patch, ws_localize (and any reply with `version`): the draft must still have that version; a ws_patch that
 *   published (publish: "if_clean") also needs its live row unchanged.
 * - ws_publish: the live row must still have `live_version`, the version read back after the publish (older replies:
 *   `published_version`). The draft version, which a publish leaves unchanged, says nothing here.
 * - ws_delete: every deleted locale must still be gone (`now.existing` lists the versions found).
 * - ws_batch, per item: a patch item is judged by the last version the batch left on its document (a later patch item
 *   of the same document carries on from it, item 16c), a publish item by its live version.
 * Replies that state nothing comparable are never superseded. `now` holds what annotateReplay read inside the write's
 * transaction: current_version(s) (drafts), live_version(s), existing.
 */
function supersededSince(tool, args, replay, now) {
  const isStr = (v) => typeof v === 'string' && v !== '';
  if (!replay || typeof replay !== 'object') return null;
  if (tool === 'ws_delete') {
    return Array.isArray(now.existing) && now.existing.length ? { kind: 'delete', produced: null, current: now.existing[0] } : null;
  }
  // a publish produced a live row: live_version (read back after the publish), or published_version in replies stored
  // before live_version was recorded
  const liveOf = (r) => (isStr(r.live_version) ? r.live_version : r.published_version);
  if (tool === 'ws_publish') {
    const produced = liveOf(replay);
    return isStr(produced) && now.live_version !== produced ? { kind: 'publish', produced, current: now.live_version ?? null } : null;
  }
  if (tool === 'ws_batch') {
    if (!Array.isArray(replay.items) || !Array.isArray(now.current_versions)) return null;
    const src = Array.isArray(args && args.items) ? args.items : [];
    const cv = now.current_versions;
    const items = [];
    replay.items.forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      if (src[i] && src[i].action === 'publish') {
        const lv = Array.isArray(now.live_versions) ? now.live_versions[i] ?? null : null;
        const produced = liveOf(it);
        if (isStr(produced) && lv !== produced) items.push({ index: i, ref: it.ref ?? String(i), kind: 'publish', produced, current: lv });
        return;
      }
      if (!isStr(it.version)) return;
      // Versions bind uid, documentId and locale, so items whose documents read with the same version share one.
      let last = it.version;
      if (isStr(cv[i])) {
        for (let j = i + 1; j < replay.items.length; j++) {
          const later = replay.items[j];
          if (cv[j] === cv[i] && !(src[j] && src[j].action === 'publish') && later && isStr(later.version)) last = later.version;
        }
      }
      if (cv[i] !== last) items.push({ index: i, ref: it.ref ?? String(i), kind: 'patch', produced: last, current: cv[i] ?? null });
    });
    return items.length ? { kind: 'batch', items } : null;
  }
  if (isStr(replay.version) && now.current_version !== replay.version) {
    return { kind: 'patch', produced: replay.version, current: now.current_version ?? null };
  }
  // a ws_patch with publish: "if_clean" that published: its live row must still be what it published
  if (replay.published === true && isStr(liveOf(replay)) && now.live_version !== liveOf(replay)) {
    return { kind: 'publish', produced: liveOf(replay), current: now.live_version ?? null };
  }
  return null;
}

/** The replay_superseded refusal (MWS-RES-1): nothing was written now, and the earlier success may no longer hold. */
function supersededError(replay, sup, out) {
  const receipt = replay.receipt_id ? ` (receipt ${replay.receipt_id})` : '';
  const what = {
    delete: 'the document it deleted exists again',
    publish: 'the live version is no longer the one it published',
    patch: 'the document no longer has the version that write produced',
    batch: `item(s) ${sup.items ? sup.items.map((x) => x.ref).join(', ') : ''} no longer hold what that write produced`,
  }[sup.kind];
  return new WsError({
    code: 'replay_superseded',
    requires_reread: true,
    message: `This identical request was applied before${receipt}, but the content has changed since: ${what}, so that change may no longer be in effect. `
      + 'Nothing was written now. Read the document again (ws_get) and check whether your change is still there. If someone undid or replaced it on '
      + 'purpose, leave it. If the change is still wanted, send it again with an idempotency_key.',
    receipt_id: replay.receipt_id || null,
    ...(sup.kind === 'batch'
      ? { superseded_items: sup.items, current_versions: out.current_versions }
      : { produced_version: sup.produced, current_version: sup.current }),
  });
}

/**
 * Implicit idempotency (1.0 hardening item 16d; Design B of the fourth review): a version-checked write applies once.
 *
 * Every write that carries a version (expected_version, a ws_delete version map, expected_source_version, or a
 * ws_batch item's expected_version) and no idempotency_key is claimed like a keyed write, under a key derived from the
 * token, the tool, the target and the hash of the WHOLE request, versions included (the request hash is bound to the
 * version): "v:<sha256>". The claim is looked up first, inside the write's transaction and before anything else runs
 * (phase 2 A review, finding 2): the same request sent again is answered with the first reply (replayed: true), so it
 * applies once even when its version check would still pass (a publish does not move the draft version; a batch's
 * version may not move; a colleague's undo can bring the document back to the named version). The reply is given only
 * while what that write produced is still in effect; otherwise the request is refused with replay_superseded and
 * nothing is written (annotateReplay, MWS-RES-1). A concurrent duplicate waits on the claim's unique index, then gets the reply. Any other request with the
 * same old version has another request hash, finds nothing, and keeps its version_conflict.
 * The stored reply is stripped of documents (retention.stripReceipt: no `document`, `recreate` or `diff`); records
 * live as long as idempotency keys (retention.keyHours, 72 h). Writes without a version keep needing idempotency_key.
 * The scope is the token: two agents sharing one token share these records (an identical request from the second is
 * answered with the first one's reply), as they share idempotency keys.
 */
function versionsIn(tool, args) {
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v) out.push(v); else if (v && typeof v === 'object' && !Array.isArray(v)) for (const x of Object.values(v)) if (typeof x === 'string' && x) out.push(x); };
  // if_match is a precondition like a version
  const match = (m) => { if (m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length) out.push(`if_match:${M.canonical(m)}`); };
  add(args && args.expected_version);
  add(args && args.expected_source_version);
  match(args && args.if_match);
  if (tool === 'ws_batch' && Array.isArray(args && args.items)) for (const it of args.items) { add(it && it.expected_version); match(it && it.if_match); }
  return out;
}
async function implicitKey(strapi, ctx, extra, tool, args, scoped) {
  if (args.idempotency_key || args.dry_run || !versionsIn(tool, args).length || KEYS.indexed !== true) return null;
  let who;
  try { who = tokenScope(ctx, extra); } catch { return null; } // no per-token identity: no implicit record
  const target = tool === 'ws_batch' ? '' : `${scoped.uid}:${scoped.documentId || ''}:${scoped.locale || ''}`;
  return `v:${M.sha(`implicit|${who}|${tool}|${target}|${requestHash(tool, scoped)}`)}`;
}

/**
 * Run fn in a transaction with optional idempotency and dry run.
 * Idempotency: the key is CLAIMED first (insert into a table with a unique index on key), in the same transaction as
 * the write. A concurrent duplicate blocks on that index until the first commits, then fails the insert and is
 * answered with the stored receipt (replayed: true). If the first rolled back, the duplicate proceeds normally.
 * Only successful writes are stored, so a refused or failed request can be retried with the same key.
 */
async function runWrite(strapi, ctx, tool, args, fn, extra) {
  let key = null;
  let rh = requestHash(tool, args);
  await EPOCH.refresh(strapi); // row keys are checked against the database's current epoch (item 16b)
  if (args.idempotency_key && !args.dry_run) {
    requireUniqueIndex();
    const scoped = await resolvedArgs(strapi, tool, args);
    key = scopedKey(ctx, extra, tool, scoped);
    rh = requestHash(tool, scoped);
  }
  // implicit idempotency (item 16d): a versioned write without a key is claimed under its implicit key
  const implicit = !key && !args.idempotency_key && !args.dry_run && versionsIn(tool, args).length > 0;
  if (implicit) {
    // the request hash of the RESOLVED request (re-review N2): a retry that names the default locale, or leaves out a
    // single type's documentId, is the same request
    const scoped = await resolvedArgs(strapi, tool, args);
    key = await implicitKey(strapi, ctx, extra, tool, args, scoped);
    if (key) rh = requestHash(tool, scoped);
  }
  const claim = { key, implicit: implicit && Boolean(key) };
  const pre = await prelockTargets(strapi, tool, args);
  const started = Date.now();
  let lockWaits = 0;
  for (let attempt = 1; ; attempt += 1) {
    const watch = {};
    try {
      return await attemptCtx.run(watch, () => runOnce(strapi, tool, args, fn, claim.key, rh, ctx, extra, pre, claim.implicit));
    } catch (e) {
      // A deadlock or lock timeout rolled the whole transaction back: nothing was written, so the write (version check
      // included) is simply run again, within the budget (retryDecision).
      const d = retryDecision({ e, watch, attempt, lockWaits, elapsedMs: Date.now() - started });
      if (d.retry) {
        if (d.kind === 'lock_wait') lockWaits += 1;
        strapi.log.info(`[writesafe] ${tool}: ${d.code || 'lock error'} on attempt ${attempt}; retrying`);
        await new Promise((r) => setTimeout(r, d.delayMs));
        continue;
      }
      if (d.kind && (!(e instanceof WsError) || e.payload.code === 'write_failed' || e.retryAttempt)) {
        throw new WsError({ code: 'busy', message: `The database aborted the write ${attempt} times because of concurrent writes (${d.code || 'deadlock'}). Nothing was written. Retry the same request.` });
      }
      if (e instanceof WsError && e.payload.code === 'write_failed') strapi.log.warn(`[writesafe] ${tool} write_failed: ${(e.cause || e).stack || e}`);
      throw e;
    }
  }
}

/**
 * Retry a failed attempt only when its FINAL error (cause chain) is retryable, or is writesafe's own stale signal; on
 * MySQL also a database error after a deadlock (Strapi hides it behind its failed restore). 8 attempts, lock wait
 * timeouts at most twice, RETRY_BUDGET_MS per call (docs/locking.md).
 */
const RETRY_BUDGET_MS = 25000;
const LOCK_WAIT = /ER_LOCK_WAIT_TIMEOUT|\b1205\b|\b55P03\b|lock_not_available|could not obtain lock|lock timeout/i;
const DEADLOCK = /ER_LOCK_DEADLOCK|\b40P01\b|deadlock/i;
function errorText(e) {
  const out = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i += 1) {
    out.push(`${x.code || ''} ${x.errno || ''} ${x.message || ''} ${x.payload?.driver_error || ''} ${x.failed?.error?.driver_error || ''}`);
  }
  return out.join(' | ');
}
const isDbError = (e) => { for (let x = e, i = 0; x && i < 6; x = x.cause, i += 1) if (x.sqlMessage || x.errno || /^[0-9A-Z]{5}$/.test(String(x.code || '')) || /^(ER_|SQLITE_)/.test(String(x.code || ''))) return true; return false; };
function retryDecision({ e, watch, attempt, lockWaits, elapsedMs }) {
  if (e instanceof DryRun) return { retry: false };
  const text = errorText(e);
  const seen = (watch && watch.errors) || [];
  let code = null;
  let kind = null;
  let own = false;
  for (let x = e, i = 0; x && i < 6; x = x.cause, i += 1) if (x.retryAttempt) own = true;
  if (own && watch && watch.retryable && watch.retryable.own) { kind = 'stale'; code = watch.retryable.code; }
  else if (DB.RETRYABLE.test(text)) { kind = LOCK_WAIT.test(text) && !DEADLOCK.test(text) ? 'lock_wait' : 'deadlock'; code = (text.match(DB.RETRYABLE) || [])[0]; }
  else if (isDbError(e) && seen.some((x) => DEADLOCK.test(`${x.code} ${x.message}`))) { kind = 'deadlock'; code = 'ER_LOCK_DEADLOCK'; }
  if (!kind) return { retry: false };
  const delayMs = retryDelay(attempt);
  const retry = attempt < MAX_ATTEMPTS && !(kind === 'lock_wait' && lockWaits >= 2) && elapsedMs + delayMs <= RETRY_BUDGET_MS;
  return { retry, kind, code, delayMs };
}

/** Lock before the first read (item 16, N10: MySQL's snapshot); resolved before the transaction (docs/locking.md). */
const PRELOCK_TOOLS = new Set(['ws_patch', 'ws_publish', 'ws_batch', 'ws_delete', 'ws_localize']);
// May create a row of a custom-ordered type: its order lock first (ws_undo takes it itself).
const ORDER_FIRST_TOOLS = new Set(['ws_localize', 'ws_create']);
async function prelockTargets(strapi, tool, args) {
  if (!args || DB.isSqlite(strapi)) return [];
  const out = PRELOCK_TOOLS.has(tool) ? await documentTargets(strapi, Array.isArray(args.items) ? args.items : [args]) : [];
  if (typeof args.uid === 'string' && CO.enabled(strapi, args.uid) && ORDER_FIRST_TOOLS.has(tool)) out.orderUids = [args.uid];
  return out;
}

async function runOnce(strapi, tool, args, fn, key, rh, ctx, extra, pre, implicit = false) {
  try {
    return await strapi.db.transaction(async () => {
      if (pre && pre.orderUids) for (const u of [...pre.orderUids].sort()) await CO.lockOrder(strapi, u);
      if (pre && pre.length) await DB.lockDocuments(strapi, pre);
      if (key) {
        const replay = await storedOutcome(strapi, key, rh, args, implicit);
        if (replay) return annotateReplay(strapi, tool, args, replay, implicit);
        await strapi.db.query(RECEIPT_UID).create({ data: { key, requestHash: rh, tool, receipt: null, targets: receiptTargets(tool, args) } });
      }
      let result;
      try {
        // [l10n/history] hook: modules wrap the write (history stores a receipt row with before-images for every write).
        result = await MOD.aroundWrite({ strapi, ctx, extra, tool, args, key }, fn);
      } catch (e) {
        throw mapStrapiError(e);
      }
      if (args.dry_run) throw new DryRun(result);
      if (key) {
        if (!implicit) result = { ...result, idempotency_key: args.idempotency_key };
        // The stored reply carries the modules' afterWrite data (result.modules, items[].modules) for replays.
        // moduleData belongs to modules that keep their own record in this row (history); targets too when a module
        // filled them in this transaction (it then put receipt_id in the reply). An implicit record (item 16d) keeps
        // the reply without documents (phase 2 A review, finding 6).
        const t = result.receipt_id ? undefined : receiptTargets(tool, args, result);
        const stored = implicit ? require('./retention').stripReceipt(result) : result;
        await strapi.db.query(RECEIPT_UID).update({ where: { key }, data: { receipt: stored, ...(t !== undefined ? { targets: t } : {}) } });
      }
      return result;
    });
  } catch (e) {
    if (e instanceof DryRun) return dryRunView(e.result);
    if (key && isUniqueViolation(e)) {
      // A race of two identical requests only if the claim row is there now (the other one committed it); any other
      // unique violation (a field of the content) is the write's own error (phase 2 A review, finding 3).
      const prior = await strapi.db.query(RECEIPT_UID).findOne({ where: { key } }).catch(() => null);
      if (prior) {
        const replay = await storedOutcome(strapi, key, rh, args, implicit);
        if (replay) return annotateReplay(strapi, tool, args, replay, implicit);
        throw new WsError({ code: 'in_progress', message: `Another identical request${implicit ? '' : ' (same idempotency_key)'} is still running. Retry the same request in a moment.`, ...(implicit ? {} : { idempotency_key: args.idempotency_key }) });
      }
    }
    throw mapStrapiError(e);
  }
}

/**
 * Deadlocks and lock timeouts are recorded per write attempt (compat/db.js explains why the thrown error itself
 * cannot be trusted on MySQL); runWrite re-runs an attempt that saw one.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const attemptCtx = new AsyncLocalStorage();

/**
 * The caller of the running tool call (phase 1 review, 10a). Every plugin tool handler runs inside withCaller
 * (tools.js), so reads deep in the engine and the modules can load what the caller's permission conditions reference
 * (M.populateFor, M.permQueryPopulate) without passing ctx through every function.
 */
const callerCtx = new AsyncLocalStorage();
const withCaller = (ctx, fn) => callerCtx.run({ ctx }, fn);
const CM_ACTIONS = ['read', 'create', 'update', 'delete', 'publish'].map((a) => `plugin::content-manager.explorer.${a}`);
const condCache = new WeakMap(); // per CASL ability object (one per request): uid -> populate
M.setConditionPopulate((strapi, uid, form) => {
  const st = callerCtx.getStore();
  const ability = st && st.ctx && st.ctx.userAbility;
  if (!ability || typeof ability.rulesFor !== 'function') return {};
  let per = condCache.get(ability);
  if (!per) { per = new Map(); condCache.set(ability, per); }
  const ck = `${uid}|${form}`;
  if (per.has(ck)) return per.get(ck);
  const paths = [];
  for (const action of CM_ACTIONS) {
    let rules = [];
    try { rules = ability.rulesFor(action, uid) || []; } catch { rules = []; }
    for (const r of rules) if (r && r.conditions) M.conditionPaths(r.conditions, [], paths);
  }
  const pop = M.populateForPaths(strapi, uid, paths, form);
  per.set(ck, pop);
  return pop;
});
// 8 attempts, 25 ms doubling to 800 ms, x0.5-1.5 jitter (rc.2's 4 short ones ran out under load).
const MAX_ATTEMPTS = 8;
const retryDelay = (attempt) => Math.min(800, 25 * 2 ** (attempt - 1)) * (0.5 + Math.random());
const watchQueryErrors = (strapi) => DB.watchQueryErrors(strapi, () => attemptCtx.getStore());

const ensureReceiptIndex = async (strapi) => {
  const r = await DB.ensureUniqueIndex(strapi, RECEIPT_UID, 'key');
  KEYS.indexed = r.ok;
  KEYS.reason = r.ok ? null : r.reason;
  if (!r.ok) strapi.log.error(`[writesafe] receipts unique index missing (${r.reason}): idempotency_key and jobs are refused until it exists`);
  await DB.ensureIndex(strapi, RECEIPT_UID, 'receiptId');
  // Retention deletes by age (1.0 hardening item 5): index createdAt so the prune does not scan the table.
  await DB.ensureIndex(strapi, RECEIPT_UID, 'createdAt');
};

function dryRunView(r) {
  const strip = (x) => {
    const o = { ...x, dry_run: true, written: false };
    if ('version' in o) o.version = null;
    return o;
  };
  if (Array.isArray(r.items)) return { ...r, dry_run: true, committed: false, items: r.items.map((i) => ({ ...strip(i), status: 'valid' })) };
  return strip(r);
}

/** Lock every document a batch touches before any item runs, in the one lock order. Returns the keys. */
async function lockBatchRows(strapi, items) {
  const targets = await documentTargets(strapi, items);
  await DB.lockDocuments(strapi, targets);
  return targets.map((t) => [t.uid, t.documentId].join('\u0000')).sort();
}

/** {uid, documentId} of the items that resolve (the others report their own error). */
async function documentTargets(strapi, items) {
  const out = [];
  for (const it of items || []) {
    try {
      if (!it || typeof it !== 'object') continue;
      checkUid(strapi, it.uid);
      out.push({ uid: it.uid, documentId: await resolveDocumentId(strapi, it.uid, it.documentId) });
    } catch {
      // reported by the item itself
    }
  }
  return out;
}

/** Key of a batch item's resolved target (uid, documentId, locale), or null when it cannot be resolved here. */
async function batchTarget(strapi, it) {
  try {
    checkUid(strapi, it.uid);
    const locale = await resolveLocale(strapi, it.uid, it.locale);
    const documentId = await resolveDocumentId(strapi, it.uid, it.documentId, locale);
    return [it.uid, documentId, locale || ''].join('\u0000');
  } catch {
    return null; // the item reports its own error when it runs
  }
}

/** Fields that only a patch item takes (1.0 hardening item 2; fourth review N5: a publish item ignored them). */
const PATCH_ONLY = ['set', 'unset', 'ops', 'force', 'if_match'];

async function applyBatch(strapi, ctx, a) {
  const items = a.items || [];
  const done = [];
  await lockBatchRows(strapi, items);
  // Documents an earlier item of this batch patched under a version check, with the version that item (or a later
  // patch of the same document in this batch) left: a publish item, or a later patch item, without expected_version
  // continues from exactly that. A patch moves the version, so the version the agent read before the batch cannot be
  // sent with a later item of the same document.
  const checked = new Map();
  for (const [i, it] of items.entries()) {
    const ref = it.ref ?? String(i);
    try {
      const item = { ...it, _tool: 'ws_batch', dry_run: a.dry_run };
      let r;
      if (it.publish !== undefined) {
        throw new WsError({ code: 'invalid', field: 'publish', message: 'ws_batch items take no publish argument: add a publish item after the patch item. Nothing was written.' });
      }
      if (it.action === 'publish') {
        const extra = PATCH_ONLY.filter((k) => it[k] !== undefined);
        if (extra.length) {
          throw new WsError({ code: 'invalid', message: `A publish item takes no ${extra.join(', ')}: put the change in a patch item before it (same document), then publish. Nothing was written.` });
        }
        if (it.expected_version === undefined) {
          const t = await batchTarget(strapi, it);
          if (t && checked.has(t)) item.expected_version = checked.get(t);
          else {
            throw new WsError({ code: 'precondition_required', message: 'A publish item needs expected_version (the reviewed version from ws_get), unless an earlier item of this batch patches the same document with expected_version. Nothing was written.' });
          }
        }
        r = await applyPublish(strapi, ctx, item);
      } else {
        // A later patch of a document an earlier item already patched under a version check continues from the version
        // that item left (1.0 hardening item 16c): the agent cannot know it in advance, and the chain stays checked.
        if (it.expected_version === undefined && !it.force) {
          const t0 = await batchTarget(strapi, it);
          if (t0 && checked.has(t0)) item.expected_version = checked.get(t0);
        }
        r = await applyPatch(strapi, ctx, item);
        const t = [it.uid, r.documentId, r.locale || ''].join('\u0000');
        if (item.expected_version !== undefined || checked.has(t)) checked.set(t, r.version);
      }
      done.push({ ref, status: 'ok', ...r });
    } catch (e) {
      const err = mapStrapiError(e);
      const abort = new BatchAbort(done, { ref, status: 'failed', error: err.payload }, i, items.length);
      abort.cause = e; // runWrite reads the cause chain to decide on a retry
      throw abort;
    }
  }
  return { ok: true, mode: 'all_or_nothing', committed: true, items: done };
}

function batchAbortView(e, items, dryRun) {
  return {
    ok: false, mode: 'all_or_nothing', committed: false, dry_run: Boolean(dryRun), failed_index: e.index,
    message: `Item ${e.index} failed, so the whole batch was rolled back. Nothing was written. Fix or drop that item and resend the batch (a new idempotency_key is not needed: failed batches are not stored).`,
    items: items.map((it, i) => {
      const ref = it.ref ?? String(i);
      if (i < e.index) return { ref, status: 'rolled_back', uid: it.uid, documentId: it.documentId ?? null };
      if (i === e.index) return e.failed;
      return { ref, status: 'not_attempted', uid: it.uid, documentId: it.documentId ?? null };
    }),
  };
}

/**
 * Draft vs live (1.0 stretch d): how the published version differs from the draft, field by field (the token's
 * view). Rows are matched by content, because draft and published rows are different database rows.
 * `diff` reads as "publishing would change live from before to after".
 */
async function liveDiff(strapi, pc, uid, documentId, locale, draftRaw, fields) {
  if (!hasDP(strapi, uid)) return { exists: null, diff: null, note: `${uid} has no draft & publish` };
  const live = await strapi.documents(uid).findOne({ documentId, ...(locale ? { locale } : {}), status: 'published', populate: M.populateFor(strapi, uid) });
  // sanitizeOutput filters fields, not the entity's conditions: check the live version itself is readable (review)
  if (live && pc.cannot.read(live)) return { exists: true, diff: null, note: 'the published version is not readable with this token' };
  const at = { documentId, locale: draftRaw.locale || null };
  // keys from the full rows, as a write computes them (phase 2 A review, finding 8)
  const view = async (r) => (r ? M.presentDoc(strapi, uid, await pc.sanitizeOutput(r), fields, { ...at, full: r }).data : {});
  const draftView = await view(draftRaw);
  const liveView = await view(live);
  return {
    exists: Boolean(live),
    published_at: live ? M.isoOf(live.publishedAt) : null,
    diff: D.diffViews(D.kindsOf(strapi, uid), liveView, draftView, { fields: fields || [...new Set([...Object.keys(liveView), ...Object.keys(draftView)])], matchRows: 'content' }),
  };
}

async function getDoc(strapi, ctx, a) {
  const uid = a.uid;
  checkUid(strapi, uid);
  await EPOCH.refresh(strapi);
  const pc = permissionChecker(strapi, ctx, uid);
  if (pc.cannot.read()) throw new WsError({ code: 'forbidden', message: `This token cannot read ${uid}.` });
  const locale = await resolveLocale(strapi, uid, a.locale);
  const documentId = await resolveDocumentId(strapi, uid, a.documentId, locale);
  const doc = await strapi.documents(uid).findOne({
    documentId, ...(locale ? { locale } : {}), ...(hasDP(strapi, uid) ? { status: 'draft' } : {}),
    populate: M.populateFor(strapi, uid),
  });
  if (!doc) throw new WsError({ code: 'not_found', message: `No ${uid} draft with documentId ${documentId}${locale ? ` in locale ${locale}` : ''}.`, documentId, locale: locale || null });
  if (pc.cannot.read(doc)) throw new WsError({ code: 'forbidden', message: `This token cannot read ${uid} ${documentId}.` });
  const version = versionOfRaw(strapi, uid, doc);
  const safe = await pc.sanitizeOutput(doc);
  const { data, rows } = M.presentDoc(strapi, uid, safe, a.fields, { documentId: doc.documentId, locale: doc.locale || null, full: doc });
  const out = { documentId: doc.documentId, locale: doc.locale || null, version, updatedAt: M.isoOf(doc.updatedAt), data, rows };
  if (a.compare === 'published') out.published = await liveDiff(strapi, pc, uid, documentId, locale, doc, a.fields);
  return out;
}

module.exports = {
  retryDelay, MAX_ATTEMPTS, retryDecision, RETRY_BUDGET_MS, prelockTargets,
  // [bulk stream] also used by server/modules/{bulk,create,delete,replace,copy}
  isLocalized, isSingle, checkRefs, checkRefValue, checkComponentData, requestHash, RECEIPT_UID, DryRun,
  MEDIA, lockAndRead, conflict, assertVersion, RETRY_HINTS, resolveLocale, resolveDocumentId, permissionChecker, checkUid, hasDP, versionOfRaw, MOD,
  keyError, EPOCH, checkPublishArg,
  versionsIn, implicitKey, supersededSince, supersededError, annotateReplay, applyRowOps, preconditionFields, isUniqueViolation, liveDiff, uncoveredUids,
  lockBatchRows, ensureReceiptIndex, watchQueryErrors, withCaller, tokenScope, requireUniqueIndex, KEYS, resolvedArgs, resolvePos, WsError, BatchAbort, applyPatch, applyPublish, applyBatch, runWrite, batchAbortView, getDoc, writableUids, mapStrapiError, RETRY_HINT,
};
// [bulk, 1.0 hardening item 22] the running write attempt's watch (deadlock / lock timeout seen), so a per-item
// savepoint in a bulk chunk never swallows an error that rolled the whole transaction back.
module.exports.attemptState = () => attemptCtx.getStore();
