'use strict';

/**
 * The stable API boundary.
 *
 * Everything the plugin needs from Strapi that is NOT a documented public API lives in this folder, one adapter per
 * dependency, and is listed in VERSION_TABLE with the Strapi versions it was tested on and a probe that checks, on the
 * running Strapi, that the internal still has the shape the adapter expects.
 *
 * Public APIs the rest of the plugin uses directly (not listed here): strapi.ai.mcp.registerTool, strapi.documents()
 * (findOne, update, publish), strapi.db.transaction, strapi.db.query(uid), strapi.contentTypes, strapi.components,
 * strapi.config, strapi.log, and from @strapi/utils: z, errors, setCreatorFields.
 *
 * `scripts/compat_check.mjs` (repo root) boots the app, runs every probe and prints the table, exiting non-zero when
 * a probe fails. Run it in CI after bumping Strapi: a failing row names the adapter to fix.
 */

/**
 * Strapi versions each internal was tested on (exact versions; every functional suite, every module on, on SQLite,
 * Postgres 16 and MySQL 8.4): the CI matrix (ci/strapi-versions.json), 1.0.0-rc.2.
 */
const TESTED = ['5.47.1', '5.48.1', '5.49.0', '5.50.2', '5.51.2', '5.52.3', '5.53.0', '5.54.0', '5.55.1', '5.56.0', '5.57.0', '5.58.0', '5.59.0', '5.60.0', '5.61.1', '5.62.0'];

const VERSION_TABLE = [
  {
    feature: 'mcp.intercept_builtin_tools',
    adapter: 'compat/mcp.js',
    uses: 'content-manager registers create_/update_/write_/delete_/publish_<type> by calling strapi.ai.mcp.registerTool() in its bootstrap, after every plugin register() and before the MCP provider calls strapi.ai.mcp.start(); definitions carry telemetry {source, name} and auth.policies[].subject = uid',
    fallback: 'guard/hide fail closed: a registerTool wrap that does not hold stops Strapi at startup; when no content-manager tool came through (or one with an unknown operation), the MCP server is not started. keep/guide: a warning',
    tested: TESTED,
  },
  {
    feature: 'mcp.server_instructions',
    adapter: 'compat/mcp.js',
    uses: '@strapi/core builds `new McpServer(info, options)` from @modelcontextprotocol/server per request (property lookup at call time); McpServer passes options.instructions to the initialize reply (Server._oninitialize, observed per reply)',
    fallback: 'no server instructions; tool descriptions still steer. The probe is ok only after an initialize reply carried them (compat_check answers one in process; CI checks the real reply per mode, tests/test_mcp_probe.py)',
    tested: TESTED,
  },
  {
    feature: 'mcp.request_auth_header',
    adapter: 'compat/mcp.js',
    uses: 'tool handlers get extra.requestInfo.headers.authorization (Strapi createMcpCapabilityHandlerContext)',
    fallback: 'idempotency keys are scoped per token owner only (two tokens of one admin user share keys); a warning is logged once',
    tested: TESTED,
  },
  {
    feature: 'cm.permission_checker',
    adapter: 'compat/content-manager.js',
    uses: "strapi.plugin('content-manager').service('permission-checker').create({userAbility, model}) with can/cannot, sanitizeOutput, sanitizeUpdateInput",
    fallback: 'none: the plugin refuses to register its tools (no permission checks = no writes)',
    tested: TESTED,
  },
  {
    feature: 'i18n.locales_service',
    adapter: 'compat/content-manager.js',
    uses: "strapi.plugin('i18n').service('locales').find() / getDefaultLocale()",
    fallback: 'locales are not validated up front; Strapi refuses unknown ones itself',
    tested: TESTED,
  },
  {
    feature: 'db.row_lock',
    adapter: 'compat/db.js',
    uses: 'queryBuilder().orderBy().forUpdate(); the transactor from strapi.db.transaction',
    fallback: 'none on Postgres/MySQL: writes are refused at startup check; SQLite does not need it',
    tested: TESTED,
  },
  {
    feature: 'db.document_service_lock',
    adapter: 'compat/document-lock.js',
    uses: 'strapi.documents.use() from register(), around the repository and its own transaction',
    fallback: 'not installed: other Document Service writers can deadlock with writesafe',
    tested: TESTED,
  },
  {
    feature: 'db.query_error_events',
    adapter: 'compat/db.js',
    uses: "strapi.db.connection is the knex instance and emits 'query-error'",
    fallback: 'deadlocks hidden behind another error are not retried (MySQL); they surface as write_failed',
    tested: TESTED,
  },
  {
    feature: 'db.receipt_unique_index',
    adapter: 'compat/db.js',
    uses: 'strapi.db.metadata.get(uid).tableName and knex.schema.alterTable',
    fallback: 'concurrent duplicate retries with one idempotency_key may both write; a warning is logged',
    tested: TESTED,
  },
  {
    feature: 'upload.file_permission',
    adapter: 'compat/media.js',
    uses: "strapi.service('admin::permission').createPermissionsManager({ability, action, model}) and toSubject(file with createdBy.roles), as @strapi/upload's MCP tools do",
    fallback: 'media references are refused (fail closed)',
    tested: TESTED,
  },
  {
    feature: 'documents.publish_preview',
    adapter: 'preview.js',
    uses: "strapi.entityValidator.validateEntityCreation(contentType, data, { isDraft: false, locale }, entity): the validation Strapi's publish runs, called read-only by the ws_publish dry run",
    fallback: 'the publish dry run checks versions and permissions only and says so (preview_note)',
    tested: TESTED,
  },
  {
    feature: 'admin.token_ability',
    adapter: 'compat/admin-token.js',
    uses: "strapi.admin.services['api-token-admin'].getById / hash and strapi.admin.services.permission.engine.generateTokenAbility(adminPermissions, owner), as Strapi's MCP authentication (authenticateAdminToken) does",
    fallback: "the job runner does not start (runnerActive stays false, the jobs page says so, approved jobs run when the agent resumes them); approval requests need the token lookup too (api-token-admin.hash, else the admin.apiToken.salt HMAC) and are refused as unsupported without it",
    tested: ['5.47.1', '5.51.2', '5.62.0'],
  },
  {
    feature: 'admin.token_restriction',
    adapter: 'compat/admin-tokens.js',
    uses: "strapi.get('auth').authenticate is called per request by every admin route (compose-endpoint) and records the strategy in ctx.state.auth; Strapi's admin-token strategy is named 'admin-token'; the MCP endpoint authenticates tokens itself",
    fallback: "with adminTokens 'mcp-only' Strapi does not start (fail closed); with 'any' nothing is wrapped",
    tested: ['5.47.1', '5.51.2', '5.62.0'],
  },
  {
    feature: 'admin.session_strategy',
    adapter: 'server/approval/admin-api.js',
    uses: "admin routes authenticate with the 'admin' strategy (panel session) or 'admin-token' (API token); ctx.state.auth.strategy.name tells them apart",
    fallback: 'none: approvals and job control are refused unless the strategy is the panel session (fail closed)',
    tested: ['5.47.1', '5.51.2', '5.62.0'],
  },
  {
    feature: 'admin.stale_form_guard',
    adapter: 'compat/stale-form.js, admin/form-base.mjs',
    uses: "strapi.requestContext.get() inside a Document Service middleware (method, path, ctx.state.user of the Content Manager request); the Content Manager's entry URLs (findOne, update, publish, discard, unpublish) and the admin's global fetch (getFetchClient); an http-errors HttpError thrown from the middleware answers 409",
    fallback: "staleFormGuard: false gives Strapi's behaviour; a Save without the admin's base header is refused (409) once the entry has journal entries",
    tested: ['5.62.0'],
  },
  {
    feature: 'documents.base_version',
    adapter: 'compat/base-version.js',
    uses: 'strapi.documents(uid).update({ baseVersion }) and errors.ConflictError (strapi/strapi#27506, not released)',
    fallback: "not present in 5.62.0: the plugin's own check (always on) is the only one",
    tested: [],
  },
  // Internals the rc.2 table did not list (fourth review N26; phase 4): rows in internals-table.js, probes in internals.js.
  ...require('./internals-table')(TESTED),
];

const status = {};
/** Record a probe or runtime observation for one feature. */
function note(feature, ok, detail) {
  status[feature] = { ok, detail, at: new Date().toISOString() };
}

const strapiVersion = (strapi) => (strapi && strapi.config && strapi.config.get('info.strapi')) || null;

/** The version table joined with what the probes found on this Strapi. */
function report(strapi) {
  const v = strapiVersion(strapi);
  return {
    strapi: v,
    tested_version: Boolean(v && TESTED.includes(v)),
    features: VERSION_TABLE.map((row) => ({
      feature: row.feature,
      adapter: row.adapter,
      ok: status[row.feature] ? status[row.feature].ok : null,
      detail: status[row.feature] ? status[row.feature].detail : 'not probed',
      tested_on: row.tested,
      ...(row.probe ? { probe: row.probe } : {}),
    })),
  };
}

module.exports = { VERSION_TABLE, TESTED, note, report, status, strapiVersion };
