# Changelog

**(contract)** marks a change to the tool contract. The full notes of every 1.0 hardening stream (and of 1.0.0-rc.2
and rc.1) are in
[docs/CHANGELOG-1.0-details.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/CHANGELOG-1.0-details.md);
the Upgrading notes below are complete.

## Unreleased (1.0 hardening)

### Summary
- **Jobs, `publish: "if_clean"`, `if_match`** (phase 4): `ws_job` lists, reads, cancels and undoes the token's own
  ws_bulk, ws_replace and undo jobs (undo jobs can now be cancelled). `publish: "if_clean"` on ws_patch and on ws_bulk
  patch and ws_replace jobs also publishes in the same write, only when the draft had no other unpublished change.
  `if_match` on ws_patch and ws_batch patch items checks only the fields written, instead of `expected_version`.
  **(contract)** ws_bulk and ws_replace refuse `status_only`, `items`, `cursor` and `control: "cancel"` (`invalid`,
  naming ws_job); `max_chunks` stays on them; one more tool when `bulk` or `replace` is on.
  Reference: [reference.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/reference.md#jobs-ws_job-with-bulk-or-replace),
  [tools-bulk-create.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-bulk-create.md).
- **Approvals and the job runner** (phase 4, stream G): admin approval tiers for bulk jobs above `bulk.maxDocuments`
  (needs `adminTokens: 'mcp-only'`), the admin page "Write-safe jobs" with a kill switch, and an in-Strapi job runner
  (off by default). **(contract)** Above `bulk.maxDocuments` ws_bulk/ws_replace answer `approval_required` instead of
  `too_many_documents`, which now means above `approvals.maxDocuments`. The package ships `admin/`.
  Reference: [tools-approvals.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-approvals.md).
- **Undo as a job, ref ops** (phase 3, stream F): ref ops link or unlink one relation target or file without a
  version; the undo of a job or of a large receipt runs as a resumable job. **(contract)** Replacing a list nested in
  a component needs `expected_version`; `on_conflict: "skip"` is the undo default; `history.maxBeforeBytes` caps each
  document.
- **Bulk jobs** (phase 3, stream E): the id list is stored once as item rows, each document runs in a savepoint, the
  first chunk is a canary, replies are bounded. **(contract)** ws_bulk needs a filter (or `allow_all`); a job starts
  only from a dry run's `plan_token` (no `idempotency_key`); bulk publish binds each draft version; the default
  ceiling is 5,000 (at most 100,000); one active job per token and type; `status_only` is paged; ws_replace has
  `replace.maxScanDocuments`.
- **ws_find, force, history** (phase 4, stream D): `ws_find` (on by default) and 16 compat rows and probes for Strapi
  internals. **(contract)** History is on by default; `force` is a privileged capability (`allowForce`, off in
  `guard` and `hide`).
- **Modules** (phase 2, stream C): **(contract)** the ws_publish and ws_delete dry runs are read-only previews;
  ws_localize pairs rows through a row map (`ambiguous_rows`) and keeps target-only rows; `builtinUpdates` covers the
  create and delete built-ins and fails closed; without `sharp`, imports of the image formats it decodes are refused.
  Media dedup is safe across replicas.
- **Versions and keys** (phase 2, stream A): **(contract)** the version token is `v2.<mac>` over a semantic hash;
  older tokens get `version_format`; ws_localize paths are structural; row keys are content-bound (`stale_row_key`)
  and replies return keys only for rows the request added or named; `set` and `unset` always need a version;
  versioned writes are idempotent without a key.
- **Locking** (phase 2, stream B): one ordered lock for every write and a Document Service lock
  (`documentServiceLock`), so admin Saves and agent writes no longer deadlock; bounded retries.
  Reference: [locking.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/locking.md).
- **Phase 1** (four outside reviews of rc.2): **(contract)** every error carries `retryable` and `requires_reread`;
  publish, delete and localize conflicts carry no version; `builtinUpdates` defaults to `guard`; publish items need
  `expected_version`; a bare `updatedAt` is refused; idempotency keys are scoped by the resolved target. Tokens with
  permission conditions (Strapi's Author role) work on their own entries; receipts have a retention.

### Upgrading

#### Jobs, `publish: "if_clean"`, `if_match` (phase 4)
- **Agents and scripts that call ws_bulk or ws_replace:** read a job with `ws_job {action: "status", job_id}` (same
  `items` and `cursor`) instead of `{job_id, status_only: true}`, and cancel it with `ws_job {action: "cancel", job_id}`
  instead of `{job_id, control: "cancel"}`. The old arguments are refused with `invalid`, naming ws_job; nothing runs.
  `{job_id}`, `{job_id, max_chunks}` (and `max_chunks` on the start) and `{job_id, control: "resume"}` stay.
- **Approvers:** approving a patch or replace job with `publish: "if_clean"` needs the publish permission too.
  ws_undo keeps its arguments.
- **tools/list:** `ws_job` is one more tool when the `bulk` or `replace` module is on; the default modules add none.
- **Database:** new integer columns `writesafe_bulk_jobs.n_published` and `.n_publish_skipped` (created on start) and
  an index on `writesafe_bulk_jobs.owner` (created on the first job).

#### Approvals and the job runner (stream G)
- New tables `writesafe_approval_requests`, `writesafe_approval_decisions`, `writesafe_job_leases`; new columns
  `writesafe_bulk_jobs.approval` (json) and `.runner` (boolean). Created on the first start.
- Set `adminTokens: 'mcp-only'` when agents hold admin tokens, and give agent tokens content permissions only.
- Approvers whose credentials changed in the 24 h before a request cannot approve it (`approverQuietHours: 0` turns
  this off, e.g. on a fresh install).
- Rebuild the admin panel (`strapi build`) and give **Approve writesafe jobs** to the approving roles.
- Agents that split jobs on `too_many_documents` now get `approval_required` between the two ceilings.
- The runner stays off until `runner.enabled: true`; with several replicas keep clocks in sync (NTP).

#### Undo as a job, ref ops (stream F)
- Upgrading: pass `on_conflict: "stop"` for the old undo; finish a bulk job before undoing it; send `expected_version`
  for nested-list replaces. New receipts-table rows `undostat:<job id>` (kept with the history).

#### Bulk jobs (stream E)
- **Agents and scripts that call ws_bulk or ws_replace:** call with `dry_run: true` first and start with the returned
  `plan_token`; drop `idempotency_key` (send the same start again to recover a lost reply); give ws_bulk a filter or
  `allow_all: true`; handle `paused` (`control: "resume"`, or cancel with ws_job since phase 4) and `job_running`.
- **Config:** an explicit `bulk.maxDocuments` above 100,000 stops the start; `replace.scanMax` keeps working (rename it
  to `maxScanDocuments`).
- **Database:** Strapi creates the two new tables on start; the plugin adds their indexes on the first job. rc.2 jobs
  in the receipts table (`bulkjob:<id>`) cannot be resumed: finish them before upgrading. Retention still deletes
  their rows after `jobHours`.
- **Monitoring:** a bulk publish of N documents fires N `entry.publish` events (shown in the dry run).

#### ws_find, force, history (stream D)
- **History on:** an install that never named `history` starts recording on the first write after the upgrade. The
  receipts table grows by one row per write without an idempotency key (measured: see the history section of
  [tools-l10n-history.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/tools-l10n-history.md)), kept
  `history.retentionDays` (30) and pruned every `history.pruneEverySeconds`. To keep the old behaviour set
  `modules: { history: false }`. Nothing is backfilled: writes made before the upgrade have no receipts.
- **Force off in guard/hide:** agents or scripts that send `force: true` (ws_patch whole-list `set`, ws_delete,
  ws_localize, ws_undo) are refused after the upgrade unless the admin sets `allowForce: true`. Read with ws_get and send
  `expected_version` instead (row ops need none).
- **ws_find on:** one more tool in tools/list (and in the instructions). `modules: { find: false }` turns it off.
- tools/list grows by ws_find, ws_history and ws_undo for installs that had no modules on.

#### Modules (stream C)
- ws_localize: an existing target locale that was not written by this version's ws_localize has no recorded row map. If
  it has two or more rows of one component type in a list, the first update is refused with `ambiguous_rows`: call the
  plan, check the pairing against both locales' text, and send `row_map` once; the map is recorded from then on. Lists
  with at most one row per component type need nothing.
- ws_localize: target-only rows are no longer deleted. Send `remove_extra_rows: true` where the old behaviour is wanted.
- ws_delete dry run: read `would_delete` (or `preview`) instead of `deleted`.
- `builtinUpdates: 'guard'` or `'hide'` with the `delete` module on: `delete_<type>` is gone from tools/list; use
  ws_delete. With `hide` and the `create` module on, `create_<type>` is gone; use ws_create.
- A Strapi without `sharp` can no longer import images through ws_media_import until sharp is installed.
- No schema change. The recorded row maps (`l10nmap:` keys) and media claims (`claim:media-sha:` keys) live in the
  existing receipts table; the map rows carry no content and are not pruned by retention.

#### Versions and keys (stream A)
- Agents holding an rc.2/Phase 1 version get `version_format` once: read again with ws_get. Old row keys
  (`<component>:<id>`) get `stale_row_key`: read again. Nothing is accepted on the old formats, so nothing is written
  from a read that predates the upgrade. Why not accept old tokens for one release: an rc.2 token binds `updatedAt` and
  component row ids, the two things the semantic version stops trusting, and matching it would keep the old rules
  alive next to the new ones in every write path (patch, publish, batch, delete, localize, bulk, undo). Every version
  goes stale with any write anyway, so the cost of refusing is one re-read per agent session; the cost of a second
  matcher is a path where the rc.2 bugs (N13's false conflicts, ids reused after an import) live on.
- Code that sent `set` or `unset` without `expected_version` (scalars, single components, single media, to-one
  relations, `unset`) gets `precondition_required`: read with ws_get and send the version, or use row ops.
- ws_localize translation paths from an rc.2 plan (`sections[blocks.hero:12].heading`) are unknown paths (`invalid`):
  call the plan again.
- Code that compared row keys before and after a write to check that "the same rows" were kept must compare the
  identity part (`<component>:<id>`): a row the write changed has a new key.
- History receipts keep row identities (`<component>:<id>`) internally; undo of receipts written before the upgrade
  works as before. An rc.2 receipt without a creation hash compares its stored version, which never matches a v2
  version: undo of such a create reports a change (use `force` after checking).
- Re-review of the stream A PR (second round):
  - **(contract)** An implicit retry record answers for `retention.implicitClaimMinutes` (default 10 minutes), not
    `keyHours`: after that the same request applies again (a deliberate re-run, e.g. deleting again after a human undid
    a delete). Every replay carries `current_version` (`current_versions` per item for a batch) and a `hint`; inside the
    window, an `idempotency_key` applies the same change again on purpose. Explicit-key replays get the same fields.
  - The implicit record is keyed by the resolved request (default locale named or not, a single type's documentId
    given or not): such a retry is replayed, no longer `idempotency_key_reused`.
  - The row key epoch survives transient read errors (pool timeout, dropped connection) for up to 60 s; it fails
    closed at once only when the table or row is missing and cannot be recreated.
  - Row keys bind a relation's linked locale inside the row (keys are computed from the raw rows): switching it makes
    the key stale.
  - A top-level morph relation is hashed as (`__type`, documentId) and its type is covered; a morph relation inside a
    component, or nesting deeper than 8, still leaves the type out, now named in `ws_schema` (`not_covered`) and the
    instructions.
  - **(contract)** blocks fields no longer return keys for nodes whose index shifted unless the request named them
    (rc.2 returned `keys_after` for blocks): read again for those.
- The first start creates `writesafe_row_epoch`. An import into a fresh database (or `DELETE FROM writesafe_row_epoch`)
  makes every row key read before it stale, by design; with several replicas, a replica can accept old keys for up to
  10 s after a reset. If the epoch cannot be read, a fresh random one is used (old keys refused).
- Versions and row keys are HMACs keyed from `APP_KEYS` in their configured order: rotating or reordering `APP_KEYS`
  makes every version and key stale (agents re-read), and every replica must use the same list in the same order.
- Content types the version cannot fully cover are no longer offered by the ws_* tools (one warning at startup): a
  polymorphic (morph) relation anywhere, or components nested deeper than 8 levels.
- A relation to a localized type is read with its linked locale, and the version covers it (the same documentId linked
  in another locale is another version).
- ws_bulk and ws_replace read each document's version under the row lock when they write it (16c is met per document,
  never with a version the agent sent).

#### Locking (stream B)
- Nothing to migrate. `documentServiceLock: false` restores rc.2; `bulk.chunkTimeMs: 0` removes the cap.

#### Phase 1
- Agents that copied `retry.expected_version` from a publish, delete or localize conflict, `current_version` from
  `precondition_required`, `retry.force` from an undo conflict, or sent a bare `updatedAt`, must read with ws_get
  instead. Built-in `update_<type>` refuses list fields and `publish_<type>` is not listed under the new default
  (`builtinUpdates: 'guide'` restores the old behaviour).
- Idempotency rows stored by rc.2 for a localized type without a named locale (or a single type without a documentId)
  are under the old scope: a retry that spans the upgrade writes again. Keys older than 72 hours stop answering.
- Bulk jobs idle for 72 hours are deleted on the first prune after the upgrade.
- An `agent` argument that is not a slug is refused by the schema.

## 1.0.0-rc.2 (13 Nov 2026, private)

The single 1.0 release: the core of rc.1 plus every module (`media`, `localize`, `history`, `create`, `delete`,
`bulk`, `replace`, `copy`), integrated on one receipt schema. Details:
[docs/CHANGELOG-1.0-details.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/CHANGELOG-1.0-details.md#100-rc2-13-nov-2026-private).

### Upgrading
- From 0.2.0: Strapi adds the new nullable columns on start. 0.2 idempotency rows still answer retries; they are not
  listed by ws_history (they have no before-image).
- From 1.0.0-rc.1: Strapi's schema sync drops `target` (nothing read it). Nothing else to do.
- From a build of the unreleased v1-l10n branch: its `history` column is dropped and its before-images are lost; those
  receipts are no longer listed or undoable.

## 1.0.0-rc.1 (13 Nov 2026, private)

`builtinUpdates`, server instructions, the baseVersion path, `server/compat/`, the module registry, `lenientArgs`,
media and relations through `set`, `ws_schema` and dry-run diffs. Details:
[docs/CHANGELOG-1.0-details.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/CHANGELOG-1.0-details.md#100-rc1-13-nov-2026-private).

## 0.2.0
Hidden fields, i18n, single types, relations inside components, publish races, idempotency under concurrency, MySQL.

## 0.1.x
First build: ws_get, ws_patch, ws_publish, ws_batch.
