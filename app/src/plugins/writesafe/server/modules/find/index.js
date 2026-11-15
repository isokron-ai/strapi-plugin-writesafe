'use strict';

/**
 * Module `find` (1.0 hardening, phase 4; fourth review Design H, an external reviewer's `ws_list`): ws_find, a light
 * read-only query.
 *
 * Every agent job used to start with Strapi's built-in list_<type>, which returns whole documents and no version token
 * (an external reviewer's mock agent run needed list_topic to find category ids). ws_find returns, per matching draft,
 * its documentId, locale, `version` (the ws_get token, computed from the full draft through the engine's helper),
 * updatedAt, whether a published version exists, and a few scalar fields.
 *
 * Permissions: the Content Manager permission checker of the caller. The type needs read permission; filters are
 * checked like ws_bulk's (../_lib/filters.js: a filter on a field the token cannot read is refused, never dropped) and
 * the read conditions are added (e.g. "own entries only"); each draft is checked again (cannot.read(entity)) and its
 * values pass through sanitizeOutput, with the creator fields and the relations the conditions name loaded
 * (M.populateFor, phase 1 item 10a). A named field the token cannot read is refused up front.
 *
 * On by default (server/modules/index.js DEFAULT_ON): it writes nothing and stores nothing. `modules: { find: false }`
 * turns it off.
 */
const M = require('../../model');
const FL = require('../_lib/filters');
const G = require('../../guidance');

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_FIELDS = 10;
const MAX_TEXT = 200;
// Attribute types a match may show: short, flat values. Lists, components, blocks, relations, media and JSON: ws_get.
const SCALAR_TYPES = new Set(['string', 'text', 'richtext', 'email', 'uid', 'enumeration', 'integer', 'biginteger', 'float', 'decimal',
  'boolean', 'date', 'time', 'datetime', 'timestamp']);
const TITLE_LIKE = ['title', 'name', 'label', 'heading', 'headline', 'question', 'slug'];
const SORT_SYSTEM = ['updatedAt', 'createdAt'];

const truncate = (v) => (typeof v === 'string' && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v);

/** Fields a match may show: scalar attributes, not private, not system keys. */
function showable(strapi, uid) {
  return Object.entries(M.attrsOf(strapi, uid))
    .filter(([k, a]) => !M.SKIP_KEYS.has(k) && SCALAR_TYPES.has(a.type) && a.private !== true && a.type !== 'password')
    .map(([k]) => k);
}

/** The summary fields: the named ones (checked), else the first title-like readable field, else the first readable string. */
function summaryFields(strapi, E, pc, uid, named) {
  const ok = showable(strapi, uid);
  const attrs = M.attrsOf(strapi, uid);
  // what a refusal lists: only fields this token can read (ws_schema shows no others either)
  const allowed = () => ok.filter((f) => pc.can.read(undefined, f));
  if (named && named.length) {
    const bad = named.filter((f) => !ok.includes(f));
    if (bad.length) {
      throw new E.WsError({
        code: 'invalid',
        message: `fields: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not a scalar field of ${uid}. ws_find shows short scalar values only; read lists, components, blocks, relations and media with ws_get.`,
        allowed: allowed(),
      });
    }
    const hidden = named.filter((f) => !pc.can.read(undefined, f));
    if (hidden.length) throw new E.WsError({ code: 'forbidden', message: `This token cannot read field(s): ${hidden.join(', ')}.` });
    return [...new Set(named)];
  }
  const readable = ok.filter((f) => pc.can.read(undefined, f));
  const title = TITLE_LIKE.find((f) => readable.includes(f));
  if (title) return [title];
  const str = readable.find((f) => ['string', 'uid', 'email', 'enumeration'].includes(attrs[f].type));
  return str ? [str] : [];
}

/** "field" or "field:asc|desc", on a showable field the token may sort by, or updatedAt/createdAt. */
async function sortOf(strapi, E, pc, uid, sort) {
  if (!sort) return ['id:asc'];
  const [field, dir = 'asc'] = sort.split(':');
  if (!SORT_SYSTEM.includes(field) && !showable(strapi, uid).includes(field)) {
    const allowed = [...SORT_SYSTEM, ...showable(strapi, uid).filter((f) => pc.can.read(undefined, f))];
    throw new E.WsError({ code: 'invalid', message: `sort: ${field} is not a scalar field of ${uid} (or updatedAt, createdAt).`, allowed });
  }
  const s = `${field}:${dir}`;
  try {
    await pc.validateQuery({ sort: s });
  } catch (e) {
    throw new E.WsError({ code: 'invalid', message: `sort: ${e.message}` });
  }
  const safe = await pc.sanitizeQuery({ sort: s });
  if (M.canonical(safe.sort ?? null) !== M.canonical(s)) throw new E.WsError({ code: 'invalid', message: `sort: this token may not sort by ${field}.` });
  return [s, 'id:asc']; // id breaks ties, so pages do not overlap
}

async function find(strapi, E, ctx, a) {
  const { uid } = a;
  E.checkUid(strapi, uid);
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.read()) throw new E.WsError({ code: 'forbidden', message: `This token cannot read ${uid}.` });
  const locale = await E.resolveLocale(strapi, uid, a.locale);
  const fields = summaryFields(strapi, E, pc, uid, a.fields);
  const sort = await sortOf(strapi, E, pc, uid, a.sort);
  const filters = await FL.withConditions(pc, 'read', await FL.checkFilters(pc, a.filters));
  const dp = E.hasDP(strapi, uid);
  const base = { filters, ...(locale ? { locale } : {}), ...(dp ? { status: 'draft' } : {}) };
  const limit = Math.min(Math.max(a.limit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const start = a.cursor ? Number(String(a.cursor).slice(1)) : 0;

  const total = await strapi.documents(uid).count(base);
  const rows = await strapi.documents(uid).findMany({ ...base, sort, start, limit, populate: M.populateFor(strapi, uid) });
  const visible = rows.filter((r) => !pc.cannot.read(r));
  let live = new Set();
  if (dp && visible.length) {
    const ids = visible.map((r) => r.documentId);
    const pub = await strapi.documents(uid).findMany({
      filters: { documentId: { $in: ids } }, ...(locale ? { locale } : {}), status: 'published', fields: ['documentId'], limit: ids.length,
    });
    live = new Set(pub.map((p) => p.documentId));
  }
  const matches = [];
  for (const raw of visible) {
    const safe = (await pc.sanitizeOutput(raw)) || {};
    const data = {};
    for (const f of fields) if (f in safe) data[f] = truncate(safe[f]);
    const m = { documentId: raw.documentId, locale: raw.locale || null, version: E.versionOfRaw(strapi, uid, raw), updatedAt: M.isoOf(raw.updatedAt) };
    if (dp) m.published = live.has(raw.documentId);
    m.data = data;
    matches.push(m);
  }
  const out = { uid, locale: locale || null, total, matches };
  if (rows.length !== visible.length) out.not_readable = rows.length - visible.length;
  if (start + rows.length < total && rows.length === limit) out.next_cursor = `o${start + rows.length}`;
  return out;
}

module.exports = {
  name: 'find',
  tools(strapi, api) {
    const { z, lenient: L } = api;
    const E = api.engine;
    return [{
      name: 'ws_find',
      title: 'Write-safe: find documents',
      description: 'Find drafts by filter (read-only). Per match: documentId, locale, `version`, updatedAt, `published` (a published version exists) '
        + 'and a few short fields in `data` (`fields`; default the title-like field). Use it to look documents up instead of list_<type>. '
        + 'filters use Strapi filter syntax, e.g. {"title": {"$containsi": "sale"}}; a filter or field this token cannot read is refused. '
        + `Paged: limit (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) and next_cursor. \`version\` is the same token ws_get returns and covers fields not `
        + 'shown here: read a document with ws_get before you change, publish or delete it. '
        + `${G.RULE_DATA}`,
      auth: api.policies('plugin::content-manager.explorer.read'),
      resolveInputSchema: () => z.object({
        uid: api.uidSchema(),
        filters: L.obj(z.object({}).catchall(z.any())).optional().describe('Strapi filters, e.g. {"title": {"$containsi": "sale"}} or {"category": {"documentId": {"$eq": "…"}}}. Omit for every draft.'),
        locale: api.localeSchema,
        fields: L.arr(z.array(z.string()).min(1).max(MAX_FIELDS)).optional().describe('Scalar fields to show per match (text cut at 200 characters). Default: the title-like field.'),
        sort: z.string().regex(/^[A-Za-z0-9_]+(:(asc|desc))?$/).optional().describe('One field, e.g. "updatedAt:desc". Default: creation order.'),
        limit: L.int(z.number().int().min(1).max(MAX_LIMIT)).optional().describe(`Matches per page (default ${DEFAULT_LIMIT}).`),
        cursor: z.string().regex(/^o\d{1,9}$/).optional().describe('next_cursor from the previous page.'),
      }).strict(),
      resolveOutputSchema: () => z.object({}).passthrough(),
      createHandler: (s, context) => async ({ args }) => {
        try { return api.ok(await find(strapi, E, context, args)); } catch (e) { return api.fail(api.errorOf(e)); }
      },
    }];
  },
  _internal: { showable, summaryFields, SCALAR_TYPES, MAX_LIMIT },
};
