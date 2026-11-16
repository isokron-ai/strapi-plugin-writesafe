'use strict';

const tools = require('./server/tools');
const CFG = require('./server/config');
const compat = require('./server/compat');
const compatMcp = require('./server/compat/mcp');
const compatDb = require('./server/compat/db');
const compatCm = require('./server/compat/content-manager');
const baseVersion = require('./server/compat/base-version');
const guidance = require('./server/guidance');
const adminApi = require('./server/approval/admin-api');

const receipt = {
  schema: {
    kind: 'collectionType',
    collectionName: 'writesafe_receipts',
    info: { singularName: 'receipt', pluralName: 'receipts', displayName: 'Write-safe receipt' },
    options: { draftAndPublish: false },
    pluginOptions: { 'content-manager': { visible: false }, 'content-type-builder': { visible: false } },
    attributes: {
      // One row per idempotent write (the core) and, with the history module on, one row per write. Schema of 1.0:
      key: { type: 'string', required: true, unique: true }, // sha256 of the scoped idempotency key, or "h:<receiptId>"
      requestHash: { type: 'string' },                         // idempotent rows: the request, to refuse a reused key
      tool: { type: 'string' },
      receipt: { type: 'json' },                               // the reply, replayed on a retry with the same key
      targets: { type: 'text' },                               // "|<uid>~<documentId>~<locale>|...|": what the write touched
      receiptId: { type: 'string' },                           // public id of a recorded write (history module), else null
      tokenId: { type: 'string' },                             // who wrote (history module): admin token id
      agent: { type: 'string' },                               // optional agent label (history module)
      moduleData: { type: 'json' },                            // modules' own records, by module name: { history: {...} }
      // Upgrading: 0.2.0 rows have only key/requestHash/tool/receipt and keep working (idempotency is by key); they are
      // not listed by ws_history. 1.0.0-rc.1's `target` column is replaced by `targets`; Strapi drops it on first start
      // (nothing read it). See the plugin README, Upgrading.
    },
  },
};

let intercepted = [];

module.exports = {
  config: { default: CFG.defaults, validator: CFG.validator },
  // Modules' own content types (e.g. the media import index) are declared for every module, on or off: content types
  // are static, and a module's table simply stays empty while it is off (server/modules/index.js, contentTypes).
  contentTypes: { receipt, ...require('./server/modules').contentTypes(), ...require('./server/approval/content-types') },
  // Approvals of bulk jobs and job control for the admin panel's Write-safe jobs page (server/approval/admin-api.js).
  // + the Settings page API (server/settings): effective config, runtime tightenings
  routes: { ...adminApi.routes, settings: require('./server/settings').routes },
  controllers: { ...adminApi.controllers, settings: require('./server/settings').controller },
  policies: adminApi.policies,
  register({ strapi }) {
    const cfg = CFG.get(strapi);
    // first: the Document Service lock wraps every later middleware (docs/locking.md)
    require('./server/compat/document-lock').install(strapi, cfg.documentServiceLock, cfg.staleFormGuard);
    // [stream G re-review A1] where admin API tokens are accepted; 'mcp-only' that cannot be installed stops Strapi
    require('./server/compat/admin-tokens').install(strapi, cfg.adminTokens);
    // Version hashes are keyed with a secret the app already has (APP_KEYS), so a token cannot test guesses for
    // fields it cannot read against the version token. Without app keys a random per-process key is used.
    const keys = strapi.config.get('server.app.keys');
    if (Array.isArray(keys) && keys.length) require('./server/model').setVersionKey(keys.join(','));
    else strapi.log.warn('[writesafe] no server.app.keys: version tokens use a per-process key and change on restart');

    if (!compatCm.probe(strapi)) {
      strapi.log.error('[writesafe] content-manager permission checker not found: write-safe tools NOT registered (see compat report)');
      return;
    }
    const covered = () => require('./server/engine').writableUids(strapi);
    // Tool collision (config.builtinUpdates): content-manager registers update_/write_/publish_<type> in its bootstrap,
    // after this register(), so its definitions pass through the rewrite.
    // guard/hide fail closed (phase 2 item 13): a wrap that does not hold stops Strapi here; a content-manager whose tools
    // never came through keeps the MCP server from starting (failClosedStart).
    const modulesOn = () => require('./server/modules').enabled();
    intercepted = compatMcp.interceptBuiltinTools(strapi, covered, guidance.rewriteFor(strapi, cfg.builtinUpdates, modulesOn), cfg.builtinUpdates);
    compatMcp.failClosedStart(strapi, intercepted, cfg.builtinUpdates, covered);
    // Built from the mode and the enabled modules (1.0 hardening item 4); modules are loaded by tools.register below,
    // before the first MCP server (and so the first call of this getter) is built.
    if (cfg.serverInstructions) compatMcp.installServerInstructions(strapi, () => guidance.instructions(covered(), cfg.builtinUpdates, require('./server/modules').enabled(), require('./server/engine').uncoveredUids(strapi), { allowForce: cfg.allowForce, adminTokens: cfg.adminTokens }));
    tools.register(strapi);
  },
  async bootstrap({ strapi }) {
    const cfg = CFG.get(strapi);
    const engine = require('./server/engine');
    compatDb.probe(strapi);
    require('./server/compat/media').probe(strapi);
    require('./server/preview').probe(strapi);
    require('./server/compat/internals').probe(strapi); // internals the rc.2 table did not list (N26; shape checks only)
    await engine.ensureReceiptIndex(strapi);
    // Row key epoch (1.0 hardening item 16b): its own table, outside what `strapi export` / `import` carries.
    await require('./server/epoch').init(strapi);
    // The revision counter and the stale admin form guard's journal (compat/stale-form.js): with the Document Service lock
    if (cfg.documentServiceLock) await require('./server/compat/stale-form').ensureTables(strapi);
    // Receipts retention (1.0 hardening item 5): keys, jobs and stale claims; runs once now, then on a timer.
    require('./server/retention').start(strapi, cfg.retention);
    engine.watchQueryErrors(strapi);
    await baseVersion.detect(strapi, cfg.baseVersion);
    // Approvals, the admin job page and the runner (1.0 hardening, Phase 4 stream G). The RBAC action is registered
    // always (the page is there either way); the gate only when the bulk engine runs; the runner only when enabled.
    await adminApi.registerActions(strapi);
    await require('./server/settings').bootstrap(strapi); // settings page permissions; runtime overrides loaded first
    const control = require('./server/approval/control');
    await control.init(strapi);
    require('./server/approval/gate').install(strapi);
    control.startRunner(strapi);
    // content-manager's bootstrap (which registers its MCP tools) runs after this one; report once all have run.
    const summary = () => {
      compatMcp.confirmIntercept(strapi, intercepted, cfg.builtinUpdates);
      const r = compat.report(strapi);
      const bad = r.features.filter((f) => f.ok === false).map((f) => f.feature);
      strapi.log.info(`[writesafe] 1.0 on Strapi ${r.strapi}${r.tested_version ? '' : ' (UNTESTED version)'}; builtinUpdates=${cfg.builtinUpdates}; `
        + `built-in tools matched: ${intercepted.map((t) => `${t.name}:${t.result}`).join(', ') || 'none'}; baseVersion: ${baseVersion.state.supported ? 'passed through' : 'own check only'}`
        + `${bad.length ? `; compat problems: ${bad.join(', ')}` : ''}`);
    };
    const http = strapi.server && strapi.server.httpServer;
    if (http && typeof http.once === 'function') http.once('listening', summary);
    else setTimeout(summary, 0);
  },
  async destroy() {
    // A stopping replica releases its job leases, so another one takes the jobs over at once.
    await require('./server/approval/control').stopRunner();
    require('./server/settings').stop();
  },
};
