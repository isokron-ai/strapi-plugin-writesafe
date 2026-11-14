module.exports = ({ env }) => ({
  // GraphQL: enabled so the version-token boundary tests can write through it (tests/test_plugin.py t_boundary_*).
  graphql: { enabled: env.bool('GRAPHQL_ENABLED', true) },
  // TEST ONLY: writes through other paths (another plugin's Document Service call, raw knex). Off unless asked for.
  probe: { enabled: env.bool('WRITESAFE_TEST_PROBE', false), resolve: './src/plugins/probe' },
  writesafe: {
    // WRITESAFE_ENABLED=false gives the baseline build (built-in MCP tools only).
    enabled: env.bool('WRITESAFE_ENABLED', true),
    resolve: './src/plugins/writesafe',
    config: {
      // keep | guide | guard | hide: what happens to update_/write_/publish_<type> (see the plugin README, Config).
      builtinUpdates: env('WRITESAFE_BUILTIN_UPDATES', 'guard'),
      serverInstructions: env.bool('WRITESAFE_SERVER_INSTRUCTIONS', true),
      baseVersion: env('WRITESAFE_BASE_VERSION', 'auto'),
      // any | mcp-only: where admin API tokens are accepted (stream G re-review A1); tests set mcp-only in one phase
      adminTokens: env('WRITESAFE_ADMIN_TOKENS', 'any'),
      lenientArgs: env.bool('WRITESAFE_LENIENT_ARGS', true),
      // Document Service lock (1.0 hardening item 11): WRITESAFE_DOCUMENT_SERVICE_LOCK=false turns it off.
      documentServiceLock: env.bool('WRITESAFE_DOCUMENT_SERVICE_LOCK', true),
      // force (skip the version check) for agents: unset = the plugin's default (off in guard and hide, on in keep/guide)
      allowForce: process.env.WRITESAFE_ALLOW_FORCE ? env.bool('WRITESAFE_ALLOW_FORCE') : undefined,
      // Feature modules (server/modules/<name>): WRITESAFE_MODULES=bulk,localize,media turns them on; a leading "-" turns
      // one off (history is on by default since the 1.0 hardening, phase 4): WRITESAFE_MODULES=-history
      modules: Object.fromEntries(env.array('WRITESAFE_MODULES', []).filter(Boolean)
        .map((m) => (m.startsWith('-') ? [m.slice(1), false] : [m, true]))),
      // [media] media module options (server/modules/media, docs/tools-media.md). The allowlist is empty (deny all) unless
      // WRITESAFE_MEDIA_ALLOW lists hosts or URL prefixes, comma-separated. The SSRF guard has no config switch.
      media: {
        allow: env.array('WRITESAFE_MEDIA_ALLOW', []),
        maxBytes: env.int('WRITESAFE_MEDIA_MAX_BYTES', 10 * 1024 * 1024),
        maxPixels: env.int('WRITESAFE_MEDIA_MAX_PIXELS', 40000000),
        timeoutMs: env.int('WRITESAFE_MEDIA_TIMEOUT_MS', 20000),
        ...(process.env.WRITESAFE_MEDIA_TYPES ? { allowedTypes: env.array('WRITESAFE_MEDIA_TYPES') } : {}),
      },
      // bulk/replace jobs (server/modules/_bulk): a chunk's transaction stops taking documents after chunkTimeMs (default 1000)
      bulk: {
        ...(process.env.WRITESAFE_BULK_CHUNK_TIME_MS ? { chunkTimeMs: env.int('WRITESAFE_BULK_CHUNK_TIME_MS') } : {}),
        // stream F: the per-job document ceiling (default 5,000)
        ...(process.env.WRITESAFE_BULK_MAX_DOCUMENTS ? { maxDocuments: env.int('WRITESAFE_BULK_MAX_DOCUMENTS') } : {}),
        // [stream G] tests also pass other bulk settings as JSON (WRITESAFE_BULK_JSON, e.g. a short planTtlSeconds)
        ...(process.env.WRITESAFE_BULK_JSON ? JSON.parse(process.env.WRITESAFE_BULK_JSON) : {}),
      },
      // receipts retention (server/retention.js): idempotency keys, bulk jobs, stale claims
      retention: {
        keyHours: env.int('WRITESAFE_RETENTION_KEY_HOURS', 72),
        jobHours: env.float('WRITESAFE_RETENTION_JOB_HOURS', 72), // float: the stream G retention test uses 0.001
        claimMinutes: env.int('WRITESAFE_RETENTION_CLAIM_MINUTES', 60),
        implicitClaimMinutes: env.int('WRITESAFE_RETENTION_IMPLICIT_CLAIM_MINUTES', 10),
        // paused jobs and approved jobs already under way (stream G re-review A3); float for the retention test
        longHorizonDays: env.float('WRITESAFE_RETENTION_LONG_DAYS', 30),
        pruneEverySeconds: env.int('WRITESAFE_RETENTION_PRUNE_EVERY_SECONDS', 3600),
      },
      // [stream G] bulk-job approvals and the in-Strapi runner (plugin README, Approvals). Tests set them as JSON;
      // unset, the plugin defaults apply (approvals on, runner off).
      ...(process.env.WRITESAFE_APPROVALS_JSON ? { approvals: JSON.parse(process.env.WRITESAFE_APPROVALS_JSON) } : {}),
      ...(process.env.WRITESAFE_RUNNER_JSON ? { runner: JSON.parse(process.env.WRITESAFE_RUNNER_JSON) } : {}),
      // [l10n/history] history module options (server/modules/history): retention and before-image size cap.
      history: {
        retentionDays: env.int('WRITESAFE_HISTORY_RETENTION_DAYS', 30),
        maxBeforeBytes: env.int('WRITESAFE_HISTORY_MAX_BEFORE_BYTES', 262144),
        // stream F: the before-image budget of one job (ws_bulk, ws_replace, an undo job), shown in their dry runs
        maxJobBeforeBytes: env.int('WRITESAFE_HISTORY_MAX_JOB_BEFORE_BYTES', 1073741824),
        pruneEverySeconds: env.int('WRITESAFE_HISTORY_PRUNE_EVERY_SECONDS', 3600),
        undo: env.bool('WRITESAFE_HISTORY_UNDO', true),
      },
    },
  },
});
