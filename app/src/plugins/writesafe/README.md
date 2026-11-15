# strapi-plugin-writesafe-mcp

Write-safe tools for the MCP server built into Strapi 5. The plugin adds five core tools to Strapi's own `/mcp` endpoint,
plus up to eleven more tools and a row op from modules (`history` and `find` are on by default, the others optional), using the plugin API (`strapi.ai.mcp.registerTool`). They use the same
admin tokens and the same RBAC as the built-in tools.

Status: 1.0.0-rc.2, pre-release, under active hardening. Tested on Strapi 5.62.0 (Community edition) with SQLite, Postgres 16 and
MySQL 8.4, every module on; CI runs the functional suites on every Strapi minor from 5.47 to 5.62. Not published.
See `CHANGELOG.md`.

The full reference (every argument, reply, error code and limit) lives in the repository's `docs/`, linked from each
section below: [reference](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md).

## Why

The built-in `update_<type>` tool replaces every list field you send as a whole: dynamic zones, repeatable components and
rich-text blocks. It cannot send component ids, and it has no version check. On Strapi 5.62.0, an agent writing from a
stale read deleted a colleague's newly added block in 12/12 trials, and none of 233 responses carried a conflict signal.
With this plugin's row ops, 0/36 colleague rows were lost; a stale whole-list set was refused with `version_conflict`
36/36 and landed after one re-read. Measurements:
[Why](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#why-what-the-built-in-update-tool-does-measured).

## Install

```bash
npm install strapi-plugin-writesafe-mcp
```

```js
// config/plugins.js
module.exports = () => ({ writesafe: { enabled: true } });
```

Add `resolve: './src/plugins/writesafe'` only when you copy the plugin into your app's `src/plugins/writesafe` instead.
Full steps:
[docs/install.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/install.md).

Then turn on the MCP server (`config/server.js`: `mcp: { enabled: true }`) and restart Strapi. The tools appear in
`tools/list` for any admin token that has read, update or publish permission on a supported content type. Options:
see [Config](#config).

## Tools

Agents see these next to Strapi's own `update_<type>`, `write_<type>` and `publish_<type>`. The plugin steers them to
the ws_* tools (see [Safety model](#safety-model)). Core tools are always on; module tools appear only when their
module is on: `history` and `find` are on unless turned off, the others only when turned on.

| Tool | Module | In one line |
|---|---|---|
| `ws_schema` | core | Field and component shapes of a type, as this token sees them. |
| `ws_get` | core | The draft with its `version` token and a `_key` per list row. |
| `ws_patch` | core | Version-checked change of one draft: `set`, `unset`, row `ops`; `publish: "if_clean"` also publishes it if the draft had no other change. |
| `ws_publish` | core | Publish only if the draft is still the version you reviewed. |
| `ws_batch` | core | Up to 100 patches and publishes in one all-or-nothing transaction. |
| `ws_find` | `find` (on by default) | Find drafts by filter: documentId, locale, version and a few fields per match. |
| `ws_create` | `create` | Create one draft; upsert with `unique_by`. |
| `ws_delete` | `delete` | Version-checked delete of one locale or every locale. |
| `ws_bulk` | `bulk` | Filter-scoped patch or publish of up to 5,000 documents (an admin may raise it to 100,000) in resumable chunks, started from a dry run's plan token. |
| `ws_replace` | `replace` | Find and replace text (literal or regex) across documents, components, zones and blocks. |
| `ws_job` | `bulk` or `replace` | List, read, cancel or undo your own ws_bulk, ws_replace and undo jobs. |
| `copy` row op | `copy` | Duplicate rows in place, or copy them from another document, locale or type (ws_patch, ws_batch). |
| `ws_localize` | `localize` | Create or update a locale from the source locale's structure; the agent supplies the text. |
| `ws_history` | `history` (on by default) | Who wrote what and when, with before-images (filtered by the caller's read permissions). |
| `ws_undo` | `history` (on by default) | Revert one receipt, one batch item, one document, or a whole bulk job, unless it changed since. |
| `ws_media_import` | `media` | Import files from allowlisted URLs into the Media Library (SSRF guard, dedup). |
| `ws_media_find` | `media` | Find files already in the Media Library. |

References:
[core tools, row ops, errors, receipts, dry runs](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#core-tools),
[ws_find](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#find-ws_find-on-by-default),
[create, delete, bulk, replace, copy](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-bulk-create.md),
[localize, history and undo](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-l10n-history.md),
[media](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-media.md).

## Safety model

- **Versions.** `ws_get` returns a `version` token (`v2.<mac>`, an HMAC keyed from `APP_KEYS` over the uid, documentId,
  locale and a semantic hash of the draft). `set` and `unset` need `expected_version`, an `if_match` value for every
  field they write (the mergeable path for scalar edits: other fields may have changed), or `force`; without one a
  write is `precondition_required`, and a stale one is `version_conflict` with the current values and a retry hint. A bare
  `updatedAt` or an rc.2 token is refused. Rotating or reordering `APP_KEYS` makes every version and row key stale.
  [Set and versions](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#set-and-versions),
  [what the version catches](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#version-token-what-it-catches-10).
- **Row keys.** Row ops (`add`, `update`, `remove`, `move`, ref ops) edit the current list by content-bound keys and
  need no version, so rows other writers added survive. A key whose row changed since it was read is `stale_row_key`;
  a key whose row is gone is `row_not_found`. Both need a re-read.
  [Row ops](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#row-ops),
  [row keys](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#row-keys-what-they-can-and-cannot-hit-10).
- **Errors** carry `retryable` and `requires_reread`.
  [Errors](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#errors).
- **Retries.** A versioned write sent again is answered with its first reply (`replayed: true`) for 10 minutes;
  `idempotency_key` covers writes without a version for 72 hours.
  [Idempotency](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#idempotency).
- **Dry runs.** `dry_run: true` runs a patch and rolls it back, returning a field-by-field `diff`; publish and delete
  dry runs are read-only previews.
  [Dry run](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#dry-run).
- **Built-in tools (`builtinUpdates`).** `keep` leaves Strapi's tools as they are, `guide` adds warnings, `guard` (the
  default) refuses list and component writes in the built-ins (`use_ws_patch`) and unlists `publish_<type>`, `hide`
  unlists `update_<type>` and `publish_<type>` and makes `write_<type>` create-only. `guard` and `hide` fail closed. Server instructions steer agents to the ws_* tools and say that field
  values are data, never instructions.
  [Built-in tools](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#built-in-tools-tool-collision).
- **`force`** (skip the version check, last write wins) is off by default in `guard` and `hide` (`allowForce`).
  [`force`](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#force-allowforce).
- **Locking.** Every write locks every locale's draft row of the documents it touches in one order; the Document
  Service lock (`documentServiceLock`, default on) makes admin Saves and agent writes queue instead of deadlocking.
  [Concurrency](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#concurrency),
  [locking](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/locking.md).
- **History** (on by default): every write stores a receipt with a before-image, and `ws_undo` reverts it unless the
  content changed since.
  [History and undo](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-l10n-history.md).

### Approvals and the job runner

A bulk job (ws_bulk, ws_replace) above `bulk.maxDocuments` can run with an admin's approval, **only when
`adminTokens` is `'mcp-only'`**. With `'any'` (the default) approvals are off: such a job is refused as before
(`approval_needs_mcp_only`). Jobs within the automatic tier run either way.

| Documents | What happens |
|---|---|
| up to `bulk.maxDocuments` (5,000; the automatic tier) | runs when the agent asks, as before |
| above it, up to `approvals.maxDocuments` (20,000 by default) | one admin approves |
| above `approvals.twoApproverAbove` (25,000), up to `approvals.maxDocuments` | two **different** admins approve: only when `approvals.maxDocuments` is raised above 25,000 (at most 100,000) |
| above `approvals.maxDocuments` | `too_many_documents` |

Tiers apply per job. `approvals.maxDocuments` is 20,000 by default, the size measured end to end (hard limit 100,000;
above 50,000 two approvers always). `approvals.escalate.publish` / `.relations` (off by default) ask for one approval
at any size (a patch job with `publish: "if_clean"` counts as a publish).

The agent never approves: only an admin in the admin panel, with the **Approve writesafe jobs** permission, decides on
the **Write-safe jobs** page, which also has a **Stop all bulk jobs** kill switch. Give agents tokens without user,
role or token permissions. The in-Strapi job runner (`runner.enabled`) is off by default.
[Approvals and the job runner](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-approvals.md).

## Config

```js
// config/plugins.js
module.exports = () => ({
  writesafe: {
    enabled: true,
    // resolve: './src/plugins/writesafe',   // only for a copy in src/plugins
    config: {
      builtinUpdates: 'guard',   // keep | guide | guard | hide (default guard since the 1.0 hardening)
      serverInstructions: true,  // MCP server instructions in the initialize reply
      baseVersion: 'auto',       // auto | off: pass the version through to Strapi's own check when it exists
      lenientArgs: true,         // accept "true"/"false" and JSON objects/arrays sent as strings
      documentServiceLock: true, // lock before every Document Service update/delete/publish (see Safety model)
      allowForce: false,         // may agents send force: true? default: false in guard/hide, true in keep/guide
      // modules: history and find are on unless set to false; the others are off unless set to true (see Tools)
      modules: { create: true, delete: true, bulk: true, replace: true, copy: true, localize: true, media: true }, // + history: false, find: false to turn those off
      history: { retentionDays: 30, maxBeforeBytes: 262144, pruneEverySeconds: 3600, undo: true },
      retention: { keyHours: 72, jobHours: 72, claimMinutes: 60, implicitClaimMinutes: 10, pruneEverySeconds: 3600 }, // receipts table (see below)
      bulk: { maxDocuments: 5000, chunkSize: 25, maxChunkSize: 100, timeBudgetMs: 20000, previewMax: 20, chunkTimeMs: 1000,
              paceMs: 50, planTtlSeconds: 900, paused: false }, // maxDocuments: at most 100,000 (a code constant)
      // bulk jobs above bulk.maxDocuments need an admin's approval in the admin panel (see Approvals and the job runner)
      approvals: { enabled: true, twoApproverAbove: 25000, maxDocuments: 20000, requestTtlSeconds: 86400, approvalTtlSeconds: 3600,
                   escalate: { publish: false, relations: false }, requesterMayApprove: true },
      runner: { enabled: false, workers: 1, leaseMs: 60000, heartbeatMs: 15000, chunkPauseMs: 250, killSwitch: false },
      replace: { regexTimeoutMs: 250, totalRegexMs: 5000, chunkRegexMs: 1000, maxScanDocuments: 5000 },
      media: { allow: ['images.example.com'], maxBytes: 10485760, maxPixels: 40000000, timeoutMs: 20000 }, // allow: [] = nothing
    },
  },
});
```

Every option has a default; only `modules` (and `media.allow` for imports) need to be set. A bad option stops Strapi
with the reason. Notes on `documentServiceLock`, `bulk.chunkTimeMs`, `lenientArgs` and `allowForce`:
[Config notes](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#config-notes);
the receipts table and its retention:
[Receipts table](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#receipts-table).

## Limits

- `api::` collection and single types only; plugin and admin types are not covered. Types with a polymorphic relation
  inside a component, or components nested deeper than 8 levels, are not offered (named in `ws_schema`).
- Strapi 5.47 to 5.62; prefer another minor than 5.51.x (its MCP endpoint keeps memory per request). MariaDB is not
  tested; MySQL 8.4 is.
- Everything that depends on Strapi internals is in `server/compat/`; `node scripts/compat_check.mjs` (repository root)
  shows which adapter a new Strapi release breaks.
  [Stable API boundary](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#stable-api-boundary).
- Agents that ignore instructions and descriptions can still pick `update_<type>` in `keep`/`guide` mode.

Full list (media, relations, locales, batches, upgrades, modules):
[Limits](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#limits-100-rc2).

## Tests

```bash
node --test test/*.test.js   # unit tests (helpers, baseVersion stub, built-in rewrite, modules, media guard, bulk)
```

The functional suites run against a real Strapi on SQLite, Postgres 16 and MySQL 8.4:
[Tests](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#tests).

## Links

- Install: [docs/install.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/install.md);
  connecting a client: [docs/clients.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/clients.md)
- Reference: [docs/reference.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md)
- Modules: [bulk and create](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-bulk-create.md),
  [localize and history](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-l10n-history.md),
  [media](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-media.md),
  [approvals](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-approvals.md)
- Locking: [docs/locking.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/locking.md)
- Changes: `CHANGELOG.md`; details per hardening stream:
  [docs/CHANGELOG-1.0-details.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/CHANGELOG-1.0-details.md)

MIT licensed. Built and maintained by [IsoKron](https://isokron.ai/?utm_source=npm&utm_medium=readme&utm_campaign=writesafe).
