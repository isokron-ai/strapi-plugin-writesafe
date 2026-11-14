'use strict';

/**
 * TEST ONLY (enabled by WRITESAFE_TEST_PROBE=true in config/plugins.js; never in a real app).
 * Content API routes, so they need a full-access API token, and the app listens on 127.0.0.1 only.
 *   POST /api/probe/document-update {uid, documentId, locale?, data}       -> strapi.documents(uid).update (another plugin)
 *   POST /api/probe/raw-update {uid, documentId, locale?, set, keepUpdatedAt?} -> knex update of the draft row's columns
 *   POST /api/probe/raw-component {component, id, set}                       -> knex update of one component row
 *   POST /api/probe/raw-max-id {component}                                   -> highest id in a component table
 *   POST /api/probe/lock-stats {}                                            -> writesafe's lock counters (document-lock.js, db.js)
 *   POST /api/probe/recorder {reset?}                                        -> Document Service middleware calls and
 *                                                                              db lifecycle events seen (writesafe phase 2 C)
 *   POST /api/probe/fail-next {uid, action?}                                 -> the next db lifecycle `action` (default beforeCreate) of uid throws
 *   POST /api/probe/lifecycle-counts {documentIds}                           -> db lifecycle events per page (bulk savepoints)
 *   POST /api/probe/features {}                                               -> {savepoint}: does this Strapi have db.savepoint
 *   POST /api/probe/memory                                                   -> process.memoryUsage() (heap, RSS)
 *   POST /api/probe/bulk-config {timeBudgetMs?}                              -> set writesafe's bulk.timeBudgetMs in the running
 *                                                                              app (null: back to the config file's value);
 *                                                                              returns the value before. 1 ms makes every
 *                                                                              ws_bulk / ws_replace call without max_chunks
 *                                                                              run exactly one chunk (the time-budget path)
 * Column names are checked against Strapi's metadata; only api:: content types and known components are touched.
 * PROBE_LOCK_COVERAGE=true: a lifecycle subscriber on every component model counts component-row writes that run
 * inside a transaction holding a writesafe lock (the Document Service lock or the engine's) and those that do not.
 * Off by default: a component subscriber makes Strapi rewrite unchanged component rows, which changes what the
 * stress jobs measure (deadlock spike, t8).
 */
const path = require('path');
/** writesafe's own module instance: the source folder (this repo's app) or the installed package (CI's packed copy). */
function wsModule(rel) {
  const tries = [path.join(__dirname, '..', 'writesafe', rel)];
  try { tries.push(path.join(path.dirname(require.resolve('strapi-plugin-writesafe-mcp/package.json')), rel)); } catch { /* not installed */ }
  for (const t of tries) { try { return require(t); } catch { /* next */ } }
  return null;
}
const coverage = { inLockedTrx: 0, inOtherTrx: 0, noTrx: 0 };
const meta = (strapi, uid) => strapi.db.metadata.get(uid);
const columnsOf = (strapi, uid, set) => {
  const m = meta(strapi, uid);
  const out = {};
  for (const [attr, v] of Object.entries(set || {})) {
    const a = m.attributes[attr];
    if (!a || !a.columnName) throw new Error(`unknown column attribute ${attr}`);
    out[a.columnName] = v;
  }
  return out;
};

/**
 * Recorder (writesafe hardening phase 2, stream C, item 10): every Document Service middleware call and every database
 * lifecycle event on api:: types, so a test can prove that a ws_publish / ws_delete dry run never reaches Strapi's
 * publish or delete (no middleware, no lifecycle). fail-next (item 14): make the next database create of one model
 * throw, to test the media module's cleanup after a failed index insert.
 */
const recorded = [];
const failNext = new Map(); // uid -> action
const record = (e) => { recorded.push({ ...e, at: Date.now() }); if (recorded.length > 5000) recorded.splice(0, recorded.length - 5000); };
function installRecorder(strapi) {
  strapi.documents.use(async (ctx, next) => {
    if (String(ctx.uid || '').startsWith('api::')) {
      record({ kind: 'middleware', action: ctx.action, uid: ctx.uid, documentId: (ctx.params && ctx.params.documentId) || null, locale: (ctx.params && ctx.params.locale) || null });
    }
    return next();
  });
}
// Content types only (api:: and the media import index), never components: a component subscriber makes Strapi rewrite
// unchanged component rows (see PROBE_LOCK_COVERAGE above), which would change what the other suites measure.
const LC_ACTIONS = ['beforeCreate', 'afterCreate', 'beforeCreateMany', 'afterCreateMany', 'beforeUpdate', 'afterUpdate',
  'beforeUpdateMany', 'afterUpdateMany', 'beforeDelete', 'afterDelete', 'beforeDeleteMany', 'afterDeleteMany'];
function installLifecycles(strapi) {
  const models = [...Object.keys(strapi.contentTypes).filter((u) => u.startsWith('api::')), 'plugin::writesafe.media-import'];
  const handler = (event) => {
    const uid = event.model && event.model.uid;
    if (!uid) return;
    const want = failNext.get(uid);
    if (want && event.action === want) {
      failNext.delete(uid);
      throw new Error(`[probe] fail-next: ${want} of ${uid} refused (test)`);
    }
    if (String(uid).startsWith('api::')) record({ kind: 'lifecycle', action: event.action, uid });
  };
  strapi.db.lifecycles.subscribe({ models, ...Object.fromEntries(LC_ACTIONS.map((a) => [a, handler])) });
}

const controller = ({ strapi }) => ({
  async recorder(ctx) {
    const { reset } = ctx.request.body || {};
    ctx.body = { ok: true, entries: recorded.slice() };
    if (reset) recorded.length = 0;
  },
  async failNext(ctx) {
    const { uid, action } = ctx.request.body || {};
    if (!strapi.contentTypes[uid]) return ctx.badRequest('unknown uid');
    failNext.set(uid, action || 'beforeCreate');
    ctx.body = { ok: true };
  },
  async documentUpdate(ctx) {
    const { uid, documentId, locale, data } = ctx.request.body || {};
    if (!uid?.startsWith('api::')) return ctx.badRequest('api:: uid only');
    const doc = await strapi.documents(uid).update({ documentId, ...(locale ? { locale } : {}), data });
    ctx.body = { ok: true, updatedAt: doc?.updatedAt ?? null };
  },
  async rawUpdate(ctx) {
    const { uid, documentId, locale, set, keepUpdatedAt } = ctx.request.body || {};
    if (!uid?.startsWith('api::')) return ctx.badRequest('api:: uid only');
    const m = meta(strapi, uid);
    const cols = columnsOf(strapi, uid, set);
    if (!keepUpdatedAt) cols.updated_at = new Date();
    const q = strapi.db.connection(m.tableName).where({ document_id: documentId });
    if (locale) q.andWhere({ locale });
    if (m.attributes.publishedAt) q.whereNull('published_at');
    const n = await q.update(cols);
    ctx.body = { ok: true, rows: n };
  },
  async rawComponent(ctx) {
    const { component, id, set } = ctx.request.body || {};
    if (!strapi.components[component]) return ctx.badRequest('unknown component');
    const m = meta(strapi, component);
    const n = await strapi.db.connection(m.tableName).where({ id }).update(columnsOf(strapi, component, set));
    ctx.body = { ok: true, rows: n };
  },
  async lockStats(ctx) {
    const DL = wsModule('server/compat/document-lock.js');
    const DB = wsModule('server/compat/db.js');
    if (!DL || !DB) return ctx.badRequest('writesafe modules not found');
    ctx.body = { ok: true, client: DB.clientOf(strapi), state: DL.state, middleware: { ...DL.stats, recent: DL.stats.recent.slice(-100) }, engine: DB.stats, coverage };
  },
  async baseVersionCalls(ctx) {
    ctx.body = { ok: true, stub: process.env.PROBE_BASEVERSION_STUB === 'true', calls: bvCalls.slice(-50) };
  },
  // writesafe hardening item 22 (bulk savepoints): how often Strapi's db lifecycles ran for these pages
  async lifecycleCounts(ctx) {
    const { documentIds } = ctx.request.body || {};
    ctx.body = { ok: true, counts: Object.fromEntries((documentIds || []).map((d) => [d, lifecycleCounts.get(d) || 0])) };
  },
  // A ws_bulk / ws_replace call runs chunks until the job is done, bulk.timeBudgetMs is used (read per call) or
  // max_chunks chunks ran, and always at least one, so tests set 1 ms to exercise the time-budget path (one chunk per
  // call without max_chunks), and restore the value after.
  async bulkConfig(ctx) {
    const body = ctx.request.body || {};
    const { timeBudgetMs } = body;
    if (timeBudgetMs !== undefined && timeBudgetMs !== null && !(Number.isSafeInteger(timeBudgetMs) && timeBudgetMs >= 1)) return ctx.badRequest('timeBudgetMs: an integer >= 1, or null');
    const cfg = strapi.config.get('plugin::writesafe');
    if (!cfg.bulk) cfg.bulk = {};
    const before = cfg.bulk.timeBudgetMs ?? null;
    if ('timeBudgetMs' in body) {
      // null: delete the key (a key holding undefined would override the plugin's default in its settings spread)
      if (timeBudgetMs === null) delete cfg.bulk.timeBudgetMs;
      else cfg.bulk.timeBudgetMs = timeBudgetMs;
    }
    ctx.body = { ok: true, before, timeBudgetMs: cfg.bulk.timeBudgetMs ?? null };
  },
  async features(ctx) {
    ctx.body = { ok: true, savepoint: typeof strapi.db.savepoint === 'function' };
  },
  // stream F review M7: heap and RSS of this process. {reset: true} starts an in-process sampler (every 20 ms, so it
  // also runs while a long write holds the database); every call returns the current values and the peaks since.
  async memory(ctx) {
    const m = process.memoryUsage();
    if ((ctx.request.body || {}).reset) {
      if (memPeak.timer) clearInterval(memPeak.timer);
      Object.assign(memPeak, { heapUsed: m.heapUsed, rss: m.rss, samples: 0 });
      memPeak.timer = setInterval(() => {
        const x = process.memoryUsage();
        memPeak.samples += 1;
        if (x.heapUsed > memPeak.heapUsed) memPeak.heapUsed = x.heapUsed;
        if (x.rss > memPeak.rss) memPeak.rss = x.rss;
      }, 20);
      if (memPeak.timer.unref) memPeak.timer.unref();
    }
    ctx.body = { ok: true, heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, peakHeapUsed: memPeak.heapUsed, peakRss: memPeak.rss, samples: memPeak.samples };
  },
  async rawMaxId(ctx) {
    const { component } = ctx.request.body || {};
    if (!strapi.components[component]) return ctx.badRequest('unknown component');
    const r = await strapi.db.connection(meta(strapi, component).tableName).max({ m: 'id' }).first();
    ctx.body = { ok: true, max: Number(r.m) };
  },
});

/**
 * PROBE_BASEVERSION_STUB=true: a Document Service middleware that makes this Strapi 5.62.0 behave like
 * strapi/strapi#27506 for `baseVersion` on update (format check, compare with the draft row's updatedAt, ConflictError),
 * so writesafe's compat/base-version.js detects it and passes its version through. A draft whose note is
 * "__stub_conflict__" always conflicts (to test the error mapping). Calls are recorded for /api/probe/base-version-calls.
 */
const bvCalls = [];
// documentId -> number of afterCreate/afterUpdate db lifecycle events of api::page.page (rolled-back attempts included)
const lifecycleCounts = new Map();
const memPeak = { heapUsed: 0, rss: 0, samples: 0, timer: null };
class ConflictError extends require('@strapi/utils').errors.ApplicationError {
  constructor(message, details) { super(message, details); this.name = 'ConflictError'; }
}
function installBaseVersionStub(strapi) {
  const { errors } = require('@strapi/utils');
  // #27506 adds ConflictError to @strapi/utils; so does the stub (writesafe only probes when it exists).
  if (typeof errors.ConflictError !== 'function') errors.ConflictError = ConflictError;
  strapi.documents.use(async (ctx, next) => {
    if (ctx.action !== 'update' || !ctx.params || !('baseVersion' in ctx.params)) return next();
    const { baseVersion } = ctx.params;
    delete ctx.params.baseVersion;
    const dp = Boolean(strapi.contentTypes[ctx.uid]?.options?.draftAndPublish);
    if (!dp) return next();
    const d = typeof baseVersion === 'string' && baseVersion ? new Date(baseVersion) : undefined;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString() !== baseVersion) throw new errors.ValidationError('baseVersion must be a valid ISO timestamp');
    const row = await strapi.db.query(ctx.uid).findOne({ select: ['updatedAt', 'note'], where: { documentId: ctx.params.documentId, ...(ctx.params.locale ? { locale: ctx.params.locale } : {}), publishedAt: null } });
    const current = row ? new Date(row.updatedAt).toISOString() : null;
    bvCalls.push({ uid: ctx.uid, documentId: ctx.params.documentId, baseVersion, current });
    if (row?.note === '__stub_conflict__') {
      // emulate a writer that got past the plugin's lock: change the row inside this transaction, then refuse
      // db.query joins the running transaction (a raw knex call would wait on SQLite's single writer)
      await strapi.db.query(ctx.uid).updateMany({ where: { documentId: ctx.params.documentId, publishedAt: null }, data: { summary: 'slipped-in', updatedAt: new Date(Date.now() + 1000) } });
      throw new (errors.ConflictError)('The document has changed since it was loaded', { expected: baseVersion, current: 'later' });
    }
    if (current !== baseVersion || row?.note === '__stub_disagree__') throw new (errors.ConflictError)('The document has changed since it was loaded', { expected: baseVersion, current });
    return next();
  });
}

function installLockCoverage(strapi) {
  const DL = wsModule('server/compat/document-lock.js');
  const DB = wsModule('server/compat/db.js');
  const hit = async (event) => {
    if (!strapi.components[event.model?.uid]) return;
    if (!(typeof strapi.db.inTransaction === 'function' ? strapi.db.inTransaction() : true)) { coverage.noTrx += 1; return; }
    // joins the running transaction (no new one is opened: inTransaction() is true)
    const trx = await strapi.db.transaction(({ trx: t }) => t);
    if (trx && ((DL && DL.lockedTrx.has(trx)) || (DB && DB.heldCount(trx) > 0))) coverage.inLockedTrx += 1;
    else coverage.inOtherTrx += 1;
  };
  strapi.db.lifecycles.subscribe({ beforeCreate: hit, beforeUpdate: hit, beforeDelete: hit, beforeDeleteMany: hit });
}

module.exports = {
  register({ strapi }) {
    if (process.env.NODE_ENV === 'production') throw new Error('[probe] TEST ONLY plugin refuses to run with NODE_ENV=production');
    if (process.env.PROBE_BASEVERSION_STUB === 'true') installBaseVersionStub(strapi);
    installRecorder(strapi);
  },
  // A permission condition on a related document's field (writesafe hardening 10a: conditions that reference more than
  // createdBy). Pages whose reviewer is named "Cond Reviewer". Name: plugin::probe.reviewer-is-cond.
  async bootstrap({ strapi }) {
    if (process.env.PROBE_LOCK_COVERAGE === 'true') installLockCoverage(strapi);
    installLifecycles(strapi);
    const count = (event) => {
      const r = event && event.result;
      const id = r && !Array.isArray(r) ? r.documentId : null;
      if (id) lifecycleCounts.set(id, (lifecycleCounts.get(id) || 0) + 1);
    };
    strapi.db.lifecycles.subscribe({ models: ['api::page.page'], afterCreate: count, afterUpdate: count });
    await strapi.service('admin::permission').conditionProvider.register({
      displayName: 'Reviewer is Cond Reviewer (test)', name: 'reviewer-is-cond', plugin: 'probe',
      handler: () => ({ 'reviewer.name': { $eq: 'Cond Reviewer' } }),
    });
  },
  controllers: { probe: controller },
  routes: {
    'content-api': {
      type: 'content-api',
      routes: [
        { method: 'POST', path: '/document-update', handler: 'probe.documentUpdate', config: { policies: [] } },
        { method: 'POST', path: '/raw-update', handler: 'probe.rawUpdate', config: { policies: [] } },
        { method: 'POST', path: '/raw-component', handler: 'probe.rawComponent', config: { policies: [] } },
        { method: 'POST', path: '/raw-max-id', handler: 'probe.rawMaxId', config: { policies: [] } },
        { method: 'POST', path: '/base-version-calls', handler: 'probe.baseVersionCalls', config: { policies: [] } },
        { method: 'POST', path: '/lock-stats', handler: 'probe.lockStats', config: { policies: [] } },
        { method: 'POST', path: '/recorder', handler: 'probe.recorder', config: { policies: [] } },
        { method: 'POST', path: '/fail-next', handler: 'probe.failNext', config: { policies: [] } },
        { method: 'POST', path: '/lifecycle-counts', handler: 'probe.lifecycleCounts', config: { policies: [] } },
        { method: 'POST', path: '/features', handler: 'probe.features', config: { policies: [] } },
        { method: 'POST', path: '/memory', handler: 'probe.memory', config: { policies: [] } },
        { method: 'POST', path: '/bulk-config', handler: 'probe.bulkConfig', config: { policies: [] } },
      ],
    },
  },
};
