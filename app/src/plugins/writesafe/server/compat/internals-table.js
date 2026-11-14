'use strict';

/**
 * Compat rows for the Strapi internals the 1.0.0-rc.2 table did not list (fourth review N26; 1.0 hardening, phase 4).
 * Data only (compat/index.js appends these rows to VERSION_TABLE; the probes are in compat/internals.js).
 *
 * `probe` says where each one is checked:
 *   boot          at every startup (cheap shape checks, no writes)
 *   compat_check  by scripts/compat_check.mjs (deep checks that write inside rolled-back transactions; run them on a
 *                 test database, as CI does, never on production)
 *   runtime       noted by the first tool call that uses it
 *   test          by the named functional test (`test`)
 * `tested` lists the Strapi versions whose functional suites exercised the internal (TESTED: the CI matrix).
 */
module.exports = (TESTED) => [
  {
    feature: 'mcp.register_timing',
    adapter: 'compat/internals.js',
    uses: 'strapi.ai.mcp.registerTool() accepts definitions during plugin register(), before the MCP server starts (it throws once the server runs); every ws_* tool is registered there',
    fallback: 'none: Strapi stops at startup with the error (no ws_* tool would exist)',
    probe: ['boot'],
    tested: TESTED,
  },
  {
    feature: 'mcp.handler_context',
    adapter: 'compat/internals.js',
    uses: 'createHandler(strapi, context) gets context = { userAbility, user } for each request; userAbility is a CASL ability with can, cannot and rulesFor',
    fallback: 'without userAbility every ws_* call fails (permission checks fail closed); without rulesFor, relations named by permission conditions are not loaded, so those conditions deny',
    probe: ['runtime'],
    tested: TESTED,
  },
  {
    feature: 'cm.permission_checker_queries',
    adapter: 'compat/content-manager.js',
    uses: "permission-checker instances also expose validateQuery, sanitizeQuery, sanitizedQuery[action], sanitizeCreateInput, can/cannot with a field argument and (optional) requiresEntity: ws_bulk, ws_replace and ws_find filters, ws_create, ws_undo's recreate",
    fallback: 'ws_bulk, ws_replace, ws_find and ws_create fail with an error; nothing runs unchecked',
    probe: ['boot', 'compat_check'],
    tested: TESTED,
  },
  {
    feature: 'admin.ability_rules',
    adapter: 'compat/internals.js',
    uses: "strapi.service('admin::permission').engine.generateUserAbility(user) builds the CASL ability; rulesFor(action, uid) returns rules with their conditions (Strapi's Author role: admin::is-creator), read for the condition populates (engine.js)",
    fallback: 'conditions on relations are evaluated without their data, so they deny (fail closed)',
    probe: ['compat_check'],
    tested: TESTED,
  },
  {
    feature: 'admin.api_token_lookup',
    adapter: 'modules/history/capture.js',
    uses: "admin::api-token rows hold accessKey = HMAC-SHA512(access key, admin.apiToken.salt), as strapi.service('admin::api-token').hash() computes it; receipts name the token (id and name) from that lookup",
    fallback: "receipts name the token by a hash of the request's Authorization header (h:<12 hex>) instead of its id and name",
    probe: ['boot'],
    tested: TESTED,
  },
  {
    feature: 'admin.permissions_manager_queries',
    adapter: 'compat/media.js',
    uses: 'createPermissionsManager({ability, action, model}) instances expose isAllowed, addPermissionsQueryTo and toSubject (ws_media_find, ws_media_import dedup, ws_history on media receipts)',
    fallback: 'media lookups fail closed: nothing is readable',
    probe: ['compat_check'],
    tested: TESTED,
  },
  {
    feature: 'upload.services',
    adapter: 'modules/media/index.js',
    uses: "strapi.plugin('upload').service('upload').findPage and .upload, service('folder').create, service('file').signFileUrls",
    fallback: 'ws_media_import and ws_media_find fail with an error; ws_history leaves media receipts out',
    probe: ['boot', 'test'],
    test: 'tests/test_media.py',
    tested: TESTED,
  },
  {
    feature: 'documents.create_with_document_id',
    adapter: 'modules/_lib/write.js',
    uses: 'strapi.documents(uid).create({ data: { documentId } }) keeps the documentId given in data (Strapi\'s own clone relies on it): ws_undo of a ws_delete brings the document back under its id',
    fallback: 'none: the undo would recreate the document under a new documentId (compat_check fails first)',
    probe: ['compat_check', 'test'],
    test: 'tests/test_l10n_history.py',
    tested: TESTED,
  },
  {
    feature: 'db.transaction_context',
    adapter: 'engine.js',
    uses: 'strapi.db.query() and strapi.documents() calls made inside strapi.db.transaction(cb) join that transaction, and a throw rolls every one of them back (writes, receipts, dry runs, batches)',
    fallback: 'none: writes would not be atomic (compat_check fails first)',
    probe: ['compat_check'],
    tested: TESTED,
  },
  {
    feature: 'db.draft_rows',
    adapter: 'engine.js',
    uses: 'a draft & publish document is one draft row (publishedAt null) per locale plus one published row after publishing; rows carry documentId and locale columns, which the row locks and draft reads query directly',
    fallback: 'none: row locks and draft reads would miss rows (compat_check fails first)',
    probe: ['boot', 'compat_check'],
    tested: TESTED,
  },
  {
    feature: 'documents.row_shapes',
    adapter: 'model.js',
    uses: 'Document Service reads return component rows with a numeric id, dynamic-zone rows with __component, and relations populated with fields [documentId] as objects carrying documentId; versions and row keys are built from them',
    fallback: 'none: row keys and versions would be wrong (compat_check fails first)',
    probe: ['compat_check'],
    tested: TESTED,
  },
  {
    feature: 'documents.middleware_api',
    adapter: 'compat/document-lock.js',
    uses: 'strapi.documents.use(middleware) runs middleware(context, next) on every Document Service call with context { action, uid (or contentType.uid), params }; the Document Service lock (row db.document_service_lock, 1.0 hardening item 11) picks the write actions and the document to lock from action, uid and params.documentId (and params.locale)',
    fallback: 'with another context shape the lock finds no document and lets the write through unlocked (counted as skipped): admin Saves and agent writes can deadlock again on Postgres and MySQL; compat_check fails first',
    probe: ['boot', 'compat_check'],
    tested: TESTED,
  },
  {
    feature: 'schema.attribute_shapes',
    adapter: 'model.js',
    uses: 'content-type and component schemas: attribute types the plugin knows (scalars, json, blocks, media with multiple, relation with relation and target, component with component and repeatable, dynamiczone with components), options.draftAndPublish, pluginOptions.i18n.localized',
    fallback: 'an attribute of an unknown type would be handled as a scalar (replaced whole); the probe names it',
    probe: ['boot'],
    tested: TESTED,
  },
  {
    feature: 'db.receipt_columns',
    adapter: 'compat/db.js',
    uses: 'strapi.db.metadata.get(receipt uid) gives tableName and attributes[name].columnName (the receiptId and createdAt indexes)',
    fallback: 'those indexes are not created: ws_history and the retention prune scan the table',
    probe: ['boot'],
    tested: TESTED,
  },
  {
    feature: 'server.listening_event',
    adapter: 'strapi-server.js',
    uses: "strapi.server.httpServer emits 'listening' after every plugin's bootstrap (content-manager's MCP tools are registered by then)",
    fallback: "the startup summary is logged on the next tick, possibly before content-manager's tools are seen",
    probe: ['boot'],
    tested: TESTED,
  },
  {
    feature: 'transfer.import',
    adapter: '(none: behaviour of strapi export / strapi import)',
    uses: '`strapi export` and `strapi import --only content` carry the receipts table with the content and recreate component rows with new ids',
    fallback: 'documented boundary: row keys and versions read before an import are refused after it; an idempotency key stored after the export is gone',
    probe: ['test'],
    test: 'tests/test_import.py',
    tested: ['5.62.0'],
  },
];
