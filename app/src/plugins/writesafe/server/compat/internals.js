'use strict';

/**
 * Probes for the Strapi internals the rc.2 compat table did not list (fourth review N26; 1.0 hardening, phase 4). The
 * rows are in internals-table.js. Three kinds:
 *
 *   probe(strapi)        at every startup (bootstrap): shape checks only, no I/O beyond reading metadata.
 *   noteRegister(...)    from tools.register; noteContext(context) from the first tool call.
 *   deepProbes(strapi)   from scripts/compat_check.mjs: behaviour checks that write inside transactions which are always
 *                        rolled back (a probe document, a probe admin user). They run the Document Service middleware
 *                        chain, whose side effects a rollback cannot undo, so they run on a test database (CI), never at
 *                        startup.
 *
 * Every result goes to compat/index.js note(); a false row makes scripts/compat_check.mjs exit 1, which fails CI on a
 * tested Strapi version.
 */
const crypto = require('crypto');
const C = require('./index');

const RECEIPT_UID = 'plugin::writesafe.receipt';
const KNOWN_TYPES = new Set(['string', 'text', 'richtext', 'email', 'password', 'uid', 'enumeration', 'integer', 'biginteger', 'float',
  'decimal', 'date', 'time', 'datetime', 'timestamp', 'boolean', 'json', 'blocks', 'media', 'relation', 'component', 'dynamiczone']);
const STUB_ABILITY = { can: () => false, cannot: () => true, rulesFor: () => [], relevantRuleFor: () => null, possibleRulesFor: () => [], rules: [] };

const covered = (strapi) => Object.values(strapi.contentTypes || {})
  .filter((ct) => ct && ct.uid && ct.uid.startsWith('api::') && (ct.kind === 'collectionType' || ct.kind === 'singleType'));
const fn = (o, k) => Boolean(o) && typeof o[k] === 'function';
const safely = (feature, f) => {
  try { f(); } catch (e) { C.note(feature, false, `probe threw: ${e.message}`); }
};

// ---------------------------------------------------------------- boot probes

function probeAttributeShapes(strapi) {
  const problems = [];
  const check = (owner, name, a) => {
    if (!a || !KNOWN_TYPES.has(a.type)) { problems.push(`${owner}.${name}: type ${a && a.type}`); return; }
    if (a.type === 'relation' && !(typeof a.relation === 'string' && (a.target || /^morph/i.test(a.relation)))) problems.push(`${owner}.${name}: relation without relation/target`);
    if (a.type === 'component' && !(strapi.components || {})[a.component]) problems.push(`${owner}.${name}: component ${a.component} not registered`);
    if (a.type === 'dynamiczone' && !(Array.isArray(a.components) && a.components.every((c) => (strapi.components || {})[c]))) problems.push(`${owner}.${name}: dynamic zone components`);
    if (a.type === 'media' && a.multiple !== undefined && typeof a.multiple !== 'boolean') problems.push(`${owner}.${name}: media.multiple`);
  };
  for (const ct of covered(strapi)) {
    for (const [k, a] of Object.entries(ct.attributes || {})) check(ct.uid, k, a);
    const loc = ct.pluginOptions?.i18n?.localized;
    if (loc !== undefined && typeof loc !== 'boolean') problems.push(`${ct.uid}: pluginOptions.i18n.localized`);
  }
  for (const [cuid, comp] of Object.entries(strapi.components || {})) for (const [k, a] of Object.entries(comp.attributes || {})) check(cuid, k, a);
  C.note('schema.attribute_shapes', !problems.length, problems.length ? `unknown shapes: ${problems.slice(0, 8).join('; ')}` : `${covered(strapi).length} content types and their components`);
}

function probeDraftRows(strapi) {
  const problems = [];
  for (const ct of covered(strapi)) {
    const meta = strapi.db?.metadata?.get(ct.uid);
    const at = (meta && meta.attributes) || {};
    if (!meta || !meta.tableName) { problems.push(`${ct.uid}: no table metadata`); continue; }
    if (!at.documentId) problems.push(`${ct.uid}: no documentId column`);
    if (ct.options?.draftAndPublish && !at.publishedAt) problems.push(`${ct.uid}: no publishedAt column`);
    if (ct.pluginOptions?.i18n?.localized === true && !at.locale) problems.push(`${ct.uid}: no locale column`);
  }
  C.note('db.draft_rows', !problems.length, problems.length ? problems.slice(0, 8).join('; ') : 'documentId, publishedAt and locale columns present');
}

function probeReceiptColumns(strapi) {
  const meta = strapi.db?.metadata?.get(RECEIPT_UID);
  const ok = Boolean(meta && meta.tableName && meta.attributes && meta.attributes.receiptId);
  C.note('db.receipt_columns', ok, ok ? `${meta.tableName}: receiptId -> ${meta.attributes.receiptId.columnName || 'receiptId'}` : 'receipt metadata (tableName, attributes.receiptId) missing');
}

function probeApiToken(strapi) {
  const ct = strapi.contentTypes?.['admin::api-token'];
  if (!ct || !ct.attributes?.accessKey || !ct.attributes?.name) { C.note('admin.api_token_lookup', false, 'admin::api-token has no accessKey/name attributes'); return; }
  const salt = strapi.config?.get('admin.apiToken.salt');
  if (!salt) { C.note('admin.api_token_lookup', false, 'admin.apiToken.salt is not set'); return; }
  let svc;
  try { svc = strapi.service('admin::api-token'); } catch { svc = undefined; }
  if (!fn(svc, 'hash')) { C.note('admin.api_token_lookup', true, 'attributes and salt present (hash() not exposed to compare)'); return; }
  const k = 'writesafe-compat-probe';
  const same = svc.hash(k) === crypto.createHmac('sha512', salt).update(k).digest('hex');
  C.note('admin.api_token_lookup', same, same ? 'HMAC-SHA512 with admin.apiToken.salt, as Strapi hashes access keys' : 'Strapi hashes access keys differently: receipts fall back to header hashes');
}

function probeUpload(strapi) {
  let up; let folder; let file;
  try { const p = strapi.plugin('upload'); up = p && p.service('upload'); folder = p && p.service('folder'); file = p && p.service('file'); } catch { /* reported below */ }
  const missing = [[up, 'upload.findPage', 'findPage'], [up, 'upload.upload', 'upload'], [folder, 'folder.create', 'create'], [file, 'file.signFileUrls', 'signFileUrls']]
    .filter(([o, , k]) => !fn(o, k)).map(([, n]) => n);
  C.note('upload.services', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : 'findPage, upload, folder.create, signFileUrls present');
}

function probePermissionCheckerShape(strapi) {
  const ct = covered(strapi)[0];
  let svc;
  try { svc = strapi.plugin('content-manager')?.service('permission-checker'); } catch { svc = undefined; }
  if (!ct || !fn(svc, 'create')) { C.note('cm.permission_checker_queries', false, 'permission-checker service (or a content type to probe with) missing'); return; }
  const pc = svc.create({ userAbility: STUB_ABILITY, model: ct.uid });
  const missing = ['validateQuery', 'sanitizeQuery', 'sanitizeCreateInput', 'sanitizeOutput', 'sanitizeUpdateInput'].filter((k) => !fn(pc, k));
  if (!pc.sanitizedQuery || !['read', 'update', 'publish'].every((a) => fn(pc.sanitizedQuery, a))) missing.push('sanitizedQuery.read/update/publish');
  if (!pc.can || !pc.cannot || !fn(pc.cannot, 'read') || !fn(pc.can, 'read')) missing.push('can/cannot');
  C.note('cm.permission_checker_queries', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : 'methods present (behaviour: compat_check)');
}

/** Startup: shape checks only. Never throws. */
function probe(strapi) {
  safely('schema.attribute_shapes', () => probeAttributeShapes(strapi));
  safely('db.draft_rows', () => probeDraftRows(strapi));
  safely('db.receipt_columns', () => probeReceiptColumns(strapi));
  safely('admin.api_token_lookup', () => probeApiToken(strapi));
  safely('upload.services', () => probeUpload(strapi));
  safely('cm.permission_checker_queries', () => probePermissionCheckerShape(strapi));
  safely('documents.middleware_api', () => C.note('documents.middleware_api', fn(strapi.documents, 'use'), fn(strapi.documents, 'use') ? 'strapi.documents.use present' : 'strapi.documents.use missing'));
  safely('server.listening_event', () => {
    const ok = fn(strapi.server?.httpServer, 'once');
    C.note('server.listening_event', ok, ok ? 'httpServer.once present' : 'strapi.server.httpServer.once missing');
  });
}

// ---------------------------------------------------------------- register time and runtime

/** tools.register: every ws_* tool registered during register(), before the MCP server started. */
function noteRegister(strapi, count) {
  const running = fn(strapi.ai?.mcp, 'isRunning') ? strapi.ai.mcp.isRunning() : null;
  C.note('mcp.register_timing', running !== true, running === true
    ? 'the MCP server was already running when the plugin registered its tools'
    : `${count} ws_* tools registered before the MCP server started${running === null ? ' (isRunning not exposed)' : ''}`);
}

let contextNoted = false;
/** The first tool call: the handler context carries a CASL ability (can, cannot, rulesFor) and the token's user. */
function noteContext(context) {
  if (contextNoted) return;
  contextNoted = true;
  const ab = context && context.userAbility;
  const missing = [];
  if (!fn(ab, 'can') || !fn(ab, 'cannot')) missing.push('userAbility.can/cannot');
  if (!fn(ab, 'rulesFor')) missing.push('userAbility.rulesFor');
  if (!context || !context.user) missing.push('user');
  C.note('mcp.handler_context', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : 'userAbility (can, cannot, rulesFor) and user present');
}
const resetContextNote = () => { contextNoted = false; };

// ---------------------------------------------------------------- deep probes (scripts/compat_check.mjs)

class Rollback extends Error {}
/** Runs fn inside a transaction that is always rolled back; returns what fn returned. */
async function rolledBack(strapi, f) {
  let out;
  try {
    await strapi.db.transaction(async () => { out = await f(); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}
const probeId = () => `wsprobe${crypto.randomBytes(9).toString('hex')}`.slice(0, 24);
/** Values for the required scalar attributes of a model (components validate them even on drafts). */
function filler(strapi, attrs) {
  const out = {};
  for (const [k, a] of Object.entries(attrs || {})) {
    if (!a || !a.required) continue;
    if (['string', 'text', 'richtext', 'uid', 'email'].includes(a.type)) out[k] = a.type === 'email' ? `${probeId()}@compat-probe.invalid` : `compat-probe-${probeId()}`;
    else if (['integer', 'biginteger', 'float', 'decimal'].includes(a.type)) out[k] = a.min !== undefined ? a.min : 0;
    else if (a.type === 'boolean') out[k] = false;
    else if (a.type === 'enumeration' && Array.isArray(a.enum) && a.enum.length) out[k] = a.enum[0];
    else if (a.type === 'component' && !a.repeatable) out[k] = filler(strapi, strapi.components[a.component]?.attributes);
  }
  return out;
}

async function deepTransaction(strapi) {
  const key = `compat-probe:${crypto.randomBytes(8).toString('hex')}`;
  const inside = await rolledBack(strapi, async () => {
    await strapi.db.query(RECEIPT_UID).create({ data: { key, tool: 'compat_probe', requestHash: '' } });
    return Boolean(await strapi.db.query(RECEIPT_UID).findOne({ where: { key } }));
  });
  const after = await strapi.db.query(RECEIPT_UID).findOne({ where: { key } });
  if (after) await strapi.db.query(RECEIPT_UID).delete({ where: { key } });
  C.note('db.transaction_context', inside && !after, inside && !after ? 'a query inside the transaction saw its own row; the rollback removed it'
    : `inside the transaction: ${inside ? 'seen' : 'NOT seen'}; after the rollback: ${after ? 'STILL THERE' : 'gone'}`);
}

/** A draft & publish api:: collection type to write a probe document into, with its list fields. */
function probeType(strapi) {
  const cts = covered(strapi).filter((ct) => ct.kind === 'collectionType' && ct.options?.draftAndPublish);
  const score = (ct) => Object.entries(ct.attributes || {}).filter(([k, a]) => a.type === 'component' || a.type === 'dynamiczone'
    || (a.type === 'relation' && !['localizations', 'createdBy', 'updatedBy'].includes(k) && String(a.target || '').startsWith('api::'))).length;
  return cts.sort((a, b) => score(b) - score(a))[0];
}

async function deepDocuments(strapi) {
  const M = require('../model');
  const ct = probeType(strapi);
  if (!ct) {
    for (const f of ['documents.create_with_document_id', 'documents.row_shapes']) C.note(f, null, 'no draft & publish collection type to probe with');
    return;
  }
  const uid = ct.uid;
  const attrs = ct.attributes;
  const rep = Object.entries(attrs).find(([, a]) => a.type === 'component' && a.repeatable);
  const dz = Object.entries(attrs).find(([, a]) => a.type === 'dynamiczone' && a.components.length);
  // a top-level relation to an api:: collection type (the target is created in the same rolled-back transaction)
  const rel = Object.entries(attrs).find(([k, a]) => !M.SKIP_KEYS.has(k) && a.type === 'relation' && String(a.target || '').startsWith('api::')
    && strapi.contentTypes[a.target]?.kind === 'collectionType');
  const localized = ct.pluginOptions?.i18n?.localized === true;
  const r = await rolledBack(strapi, async () => {
    const out = { notes: [] };
    const documentId = probeId();
    const data = { ...filler(strapi, attrs), documentId };
    if (rep) data[rep[0]] = [filler(strapi, strapi.components[rep[1].component]?.attributes)];
    if (dz) data[dz[0]] = [{ __component: dz[1].components[0], ...filler(strapi, strapi.components[dz[1].components[0]]?.attributes) }];
    let target;
    if (rel) {
      target = await strapi.documents(rel[1].target).create({ data: filler(strapi, strapi.contentTypes[rel[1].target].attributes) });
      data[rel[0]] = /ToMany$/.test(rel[1].relation) ? [target.documentId] : target.documentId;
    }
    const created = await strapi.documents(uid).create({ data, populate: M.populateFor(strapi, uid) });
    out.sameId = created && created.documentId === documentId;
    const rows = await strapi.db.query(uid).findMany({ where: { documentId }, select: ['id', 'publishedAt', ...(localized ? ['locale'] : [])] });
    out.draftRows = rows.length === 1 && rows[0].publishedAt == null;
    await strapi.documents(uid).publish({ documentId, ...(localized && created.locale ? { locale: created.locale } : {}) });
    const rows2 = await strapi.db.query(uid).findMany({ where: { documentId }, select: ['id', 'publishedAt'] });
    out.publishedRows = rows2.length === 2 && rows2.filter((x) => x.publishedAt == null).length === 1;
    const draft = await strapi.documents(uid).findOne({ documentId, status: 'draft', populate: M.populateFor(strapi, uid) });
    if (rep) out.rowId = Array.isArray(draft[rep[0]]) && draft[rep[0]].length === 1 && Number.isInteger(draft[rep[0]][0].id);
    if (dz) out.dzRow = Array.isArray(draft[dz[0]]) && draft[dz[0]].length === 1 && draft[dz[0]][0].__component === dz[1].components[0] && Number.isInteger(draft[dz[0]][0].id);
    if (rel) {
      const v = draft[rel[0]];
      const one = Array.isArray(v) ? v[0] : v;
      out.relShape = Boolean(one && one.documentId === target.documentId);
      if (!out.relShape) out.relSeen = { field: rel[0], target: rel[1].target, value: JSON.stringify(v ?? null).slice(0, 200) };
    }
    out.version = M.isVersionToken(M.versionOf(strapi, uid, draft));
    return out;
  });
  C.note('documents.create_with_document_id', r.sameId, r.sameId ? `${uid}: the documentId given in data was kept` : `${uid}: create() replaced the documentId given in data`);
  const draftOk = r.draftRows && r.publishedRows;
  C.note('db.draft_rows', draftOk, draftOk ? `${uid}: one draft row (publishedAt null), plus one published row after publish` : `${uid}: draft rows ${r.draftRows ? 'ok' : 'NOT one row with publishedAt null'}; after publish ${r.publishedRows ? 'ok' : 'NOT draft + published'}`);
  const shapes = [['component row id', r.rowId], ['dynamic-zone row __component and id', r.dzRow], ['relation as {documentId}', r.relShape], ['version token', r.version]];
  const bad = shapes.filter(([, v]) => v === false).map(([n]) => n);
  const seen = shapes.filter(([, v]) => v === true).map(([n]) => n);
  C.note('documents.row_shapes', !bad.length, bad.length ? `${uid}: unexpected ${bad.join(', ')}${r.relSeen ? ` (${JSON.stringify(r.relSeen)})` : ''}` : `${uid}: ${seen.join(', ')}`);
}

/**
 * The context shape the Document Service lock reads (compat/document-lock.js): ctx.action, ctx.uid (or
 * ctx.contentType.uid) and ctx.params.documentId. Checked with a read (findOne of an id that cannot exist): nothing is
 * written, and the lock itself only acts on write actions.
 */
async function deepMiddleware(strapi) {
  if (!fn(strapi.documents, 'use')) { C.note('documents.middleware_api', false, 'strapi.documents.use missing'); return; }
  const ct = covered(strapi)[0];
  if (!ct) { C.note('documents.middleware_api', null, 'no content type to probe with'); return; }
  const probeDoc = '__writesafe_compat_probe__';
  let armed = true;
  let seen = null;
  strapi.documents.use(async (context, next) => {
    if (armed && !seen && context) {
      seen = { uid: context.uid || context.contentType?.uid, action: context.action, documentId: context.params && context.params.documentId };
    }
    return next();
  });
  try { await strapi.documents(ct.uid).findOne({ documentId: probeDoc, fields: ['documentId'] }); } finally { armed = false; }
  const ok = Boolean(seen && seen.uid === ct.uid && seen.action === 'findOne' && seen.documentId === probeDoc);
  C.note('documents.middleware_api', ok, ok ? 'middleware(context, next) saw { uid, action, params.documentId } (what the Document Service lock reads)'
    : `middleware saw ${JSON.stringify(seen)}: the Document Service lock would pass writes through unlocked`);
}

/** Permission-checker queries, the CASL rules and the permissions manager, with the ability of a probe Author user. */
async function deepPermissions(strapi) {
  const CM = require('./content-manager');
  const ct = covered(strapi)[0];
  if (!ct) return;
  const uid = ct.uid;
  const scalar = Object.entries(ct.attributes || {}).find(([k, a]) => ['string', 'text', 'uid', 'email'].includes(a.type) && !a.private && !['createdBy', 'updatedBy'].includes(k));
  const r = await rolledBack(strapi, async () => {
    const out = {};
    const roleOf = (code) => strapi.db.query('admin::role').findOne({ where: { code } });
    // Strapi's Author role (conditions), else Editor; never the super admin. The user is inactive and rolled back.
    const role = await roleOf('strapi-author') || await roleOf('strapi-editor');
    if (!role) return null;
    const user = await strapi.db.query('admin::user').create({ data: { email: `${probeId()}@compat-probe.invalid`, firstname: 'compat', lastname: 'probe', isActive: false, roles: [role.id] } });
    const engine = strapi.service('admin::permission').engine;
    const ability = await engine.generateUserAbility(user);
    out.role = role.code;
    // admin.ability_rules
    const rules = fn(ability, 'rulesFor') ? ability.rulesFor('plugin::content-manager.explorer.read', uid) : null;
    out.rules = Array.isArray(rules) ? rules.length : null;
    out.conditionRules = Array.isArray(rules) ? rules.filter((x) => x && x.conditions).length : 0;
    // cm.permission_checker_queries
    const pc = CM.permissionChecker(strapi, { userAbility: ability }, uid);
    // what _lib/filters.js relies on: an unknown field is refused by validateQuery or removed by sanitizeQuery (then refused)
    const unknown = { filters: { __writesafe_no_such_field__: { $eq: 1 } } };
    let refusedUnknown = false;
    try { await pc.validateQuery(unknown); } catch { refusedUnknown = true; }
    if (!refusedUnknown) refusedUnknown = JSON.stringify((await pc.sanitizeQuery(unknown)).filters || {}) !== JSON.stringify(unknown.filters) ? 'sanitizeQuery' : false;
    else refusedUnknown = 'validateQuery';
    // Strapi 5.62's checker passes an unknown key through; the Document Service then refuses it ("Invalid key"), so a
    // typo in ws_bulk/ws_find filters fails (invalid) instead of matching every document. That refusal is checked too.
    if (!refusedUnknown) {
      try { await strapi.documents(uid).count(unknown); } catch (e) { refusedUnknown = /invalid key/i.test(e.message || '') ? 'Document Service' : false; }
    }
    out.refusedUnknown = refusedUnknown;
    if (scalar) {
      const q = { filters: { [scalar[0]]: { $eq: 'compat-probe' } } };
      await pc.validateQuery(q);
      out.keptReadable = JSON.stringify((await pc.sanitizeQuery(q)).filters) === JSON.stringify(q.filters);
    }
    const cond = await pc.sanitizedQuery.read({});
    out.conditionFilters = Boolean(cond && typeof cond === 'object');
    out.condHasCreator = JSON.stringify((cond && cond.filters) || {}).includes('createdBy');
    out.createInput = typeof (await pc.sanitizeCreateInput({})) === 'object';
    // admin.permissions_manager_queries
    const pm = strapi.service('admin::permission').createPermissionsManager({ ability, action: 'plugin::upload.read', model: 'plugin::upload.file' });
    out.pmShape = typeof pm.isAllowed === 'boolean' && fn(pm, 'addPermissionsQueryTo') && fn(pm, 'toSubject');
    if (out.pmShape) {
      const q = await pm.addPermissionsQueryTo({ filters: { id: 0 }, page: 1, pageSize: 1 });
      out.pmQuery = Boolean(q && typeof q === 'object' && q.filters);
    }
    return out;
  });
  if (!r) {
    for (const f of ['admin.ability_rules', 'cm.permission_checker_queries', 'admin.permissions_manager_queries']) C.note(f, null, 'no Author or Editor role to probe with');
    return;
  }
  const isAuthor = r.role === 'strapi-author';
  const rulesOk = r.rules > 0 && (!isAuthor || r.conditionRules > 0);
  C.note('admin.ability_rules', rulesOk, `${r.role}: ${r.rules} read rule(s) for ${uid}, ${r.conditionRules} with conditions`);
  const pcOk = r.refusedUnknown && r.keptReadable !== false && r.conditionFilters && r.createInput && (!isAuthor || !r.conditionRules || r.condHasCreator);
  C.note('cm.permission_checker_queries', pcOk, `an unknown filter field is refused by: ${r.refusedUnknown || 'NOTHING (a typo would match every document)'}; sanitizeQuery keeps a readable filter: ${r.keptReadable ?? 'n/a'}; `
    + `sanitizedQuery.read gives the conditions${isAuthor ? ` (createdBy: ${r.condHasCreator})` : ''}: ${r.conditionFilters}; sanitizeCreateInput: ${r.createInput}`);
  C.note('admin.permissions_manager_queries', Boolean(r.pmShape && r.pmQuery), `isAllowed, addPermissionsQueryTo, toSubject: ${r.pmShape}; query built: ${r.pmQuery ?? false}`);
}

const DEEP_WRITERS = ['documents.create_with_document_id', 'db.draft_rows', 'documents.row_shapes', 'admin.ability_rules', 'cm.permission_checker_queries', 'admin.permissions_manager_queries'];

/**
 * Every deep probe; each failure is noted, never thrown. Refused with NODE_ENV=production (they write, even though
 * every write is rolled back) and skipped with COMPAT_DEEP=0. The probes that write a document or a user run only after
 * db.transaction_context showed that a rollback really removes what was written (review: otherwise they would commit).
 */
async function deepProbes(strapi, env = process.env) {
  if (env.COMPAT_DEEP === '0' || env.NODE_ENV === 'production') {
    const why = env.COMPAT_DEEP === '0' ? 'COMPAT_DEEP=0' : 'NODE_ENV=production (deep probes write inside rolled-back transactions; run them on a test database)';
    for (const f of ['db.transaction_context', 'documents.middleware_api', ...DEEP_WRITERS]) if (!C.status[f] || C.status[f].ok !== false) C.note(f, C.status[f] ? C.status[f].ok : null, `${C.status[f] ? `${C.status[f].detail}; ` : ''}deep probe skipped: ${why}`);
    return;
  }
  try { await deepTransaction(strapi); } catch (e) { C.note('db.transaction_context', false, `deep probe threw: ${e.message}`); }
  const rollbackWorks = C.status['db.transaction_context'] && C.status['db.transaction_context'].ok === true;
  for (const [feature, f, writes] of [['documents.create_with_document_id', deepDocuments, true], ['documents.middleware_api', deepMiddleware, false],
    ['cm.permission_checker_queries', deepPermissions, true]]) {
    if (writes && !rollbackWorks) { C.note(feature, false, 'not run: db.transaction_context failed, so its writes would not be rolled back'); continue; }
    try { await f(strapi); } catch (e) { C.note(feature, false, `deep probe threw: ${e.message}`); }
  }
}

module.exports = { probe, noteRegister, noteContext, resetContextNote, deepProbes, KNOWN_TYPES };
