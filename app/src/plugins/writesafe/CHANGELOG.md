# Changelog

**(contract)** marks a change to the tool contract. The full notes of every 1.0 hardening stream (and of 1.0.0-rc.2
and rc.1) are in
[docs/CHANGELOG-1.0-details.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/CHANGELOG-1.0-details.md);
the Upgrading notes below are complete.

## Unreleased (1.0 hardening)

### Summary
- **MWS self-test fixes** (D1, D3, D4, D5 of the self-test against MWS 0.9):
  **(contract)** A versioned write sent again without an `idempotency_key` is answered with its first reply only
  while what that write produced is still in effect (patch and translation: the draft version; publish: the live
  row's version, which publish replies now carry as `live_version`; delete: still gone; batch: per item). Otherwise it is refused with `replay_superseded` (`requires_reread`,
  nothing written), naming `receipt_id`, `produced_version` and `current_version`; before, a document that went
  A -> B -> A was answered `ok: true` with nothing applied (MWS-RES-1).
  **(contract)** ws_replace needs a filter, as ws_bulk does: a missing or empty `filters` is refused with
  `filter_required`, also on a dry run; `allow_all: true` is the opt-in (MWS-TGT-2).
  **(contract)** An unknown name in `config.modules` (`histroy: false`, `bulkk: true`) stops Strapi at startup instead
  of a warning (MWS-CFG-2, CFG-4).
  **(contract)** **Behaviour change (D4, MWS-IN-6): strict argument types by default.** `lenientArgs` now defaults to `false`: a string
  sent where a boolean, integer, object or array is declared (`"dry_run": "true"`, `"limit": "5"`, `"set": "{...}"`) is
  refused before the tool runs (`isError`, nothing written), naming the argument, the type and the value. The
  advertised schemas are unchanged. To opt back in: `lenientArgs: true`.
  **(contract)** A `version_conflict` carries the whole document in `current` (as ws_get shows it to the token), not
  only the fields the refused write touched, so another writer's change to any field is shown with the
  `current_version` it belongs to; an `if_match` refusal still names the differing fields in `fields_changed`
  (MWS-CONC-6). A ws_undo conflict shows the fields changed since the receipt, as before, and now lists the other
  readable fields in `omitted`. Conflict replies no longer include document content the token cannot read: for such a
  token the reply has no `current`, `current_rows` or version, and says that the token cannot read the document.
- **(contract) Version tokens are `v3.`** (self-test D1): the token binds the draft's content revision (per document
  and locale; it moves whenever a Document Service write changes that draft's content) as well as its content, so
  after A → B → A (and after a delete and a re-create under the same documentId) an old token never matches again, so
  a fresh write with a re-read token is not answered as a replay of an earlier one; an agent holding a token from
  before a change and its undo must re-read. The `replay_superseded` check above stays: it covers the requests whose
  key no revision can change (an `if_match` precondition is a value; publish state is not part of the draft's
  revision, so after an unpublish the same `ws_publish` is the identical request). A `v2.` token from before the upgrade
  (or from a not yet upgraded node of a rolling deploy) is refused with its own code, `version_format`
  (`requires_reread`; the document may not have changed): read again; agents get these until every node runs this
  version. New table `writesafe_content_rev`. Needs `documentServiceLock` (with it off,
  the revision is 0 and tokens are content-only as before).
- **Stale admin forms** (bench X4): an admin-panel Save whose form was loaded before an agent's write no longer writes
  the form's old values over it behind a 200. New option `staleFormGuard` (default on; needs `documentServiceLock`;
  new `retention.journalHours`, 72). **Behaviour change for sites that use the admin together with REST or GraphQL:**
  an update or delete by REST, GraphQL, another plugin or review workflows leaves an opaque journal entry, so an admin
  form loaded before it gets 409 on Save (Strapi answered 200, last write wins); the panel "Your unsaved edits" keeps
  the editor's values. `staleFormGuard: { otherWriters: false }` restores last-write-wins for those writers.
  Upgrading: agent writes made while the guard was off (or on an old node during a rolling deploy) are not
  journaled, so a form loaded before them is not protected, and an old node does not move content revisions (an
  A → B → A split across old and new nodes keeps its token); reload open admin tabs after deploying (an old admin
  bundle sends no version: its Saves get 409 on any entry with a journal entry, and so do header-less clients of the
  Content Manager routes, such as scripts, on any entry an agent, another writer or a discard changed, permanently).
  Agent writes are journaled per field (new tables `writesafe_doc_rev`, `writesafe_journal`, created at start); the
  edit view's load answers `X-Writesafe-Version`, the admin echoes it per tab (`X-Writesafe-Base`, the plugin's admin
  code wraps `window.fetch`), and the Save is rebased on the current draft under the document's lock: merged (200,
  with an `X-Writesafe-Merged` note), or 409 (`ConflictError`, `details.code: "stale_form"`) when both changed one
  field or list, on edit against delete (also inside nested components), a publish or discard with unseen agent
  changes, an agent's delete of the locale, a discard or another writer since the load, or a Save without the header
  on an entry with journal entries. Private and password fields are journaled as keyed hashes; values in 409
  messages and merge notes follow the editor's read permissions; component rows are named by field and position
  ("items row 2 qty"), never by a value. Editors alone and REST or GraphQL calls
  themselves behave as before; two editors' Saves are last-write-wins, but a discard in one tab makes the other tabs'
  older forms 409.
  Reference: [locking.md](https://github.com/isokron-ai/strapi-plugin-writesafe/blob/main/docs/locking.md#stale-admin-forms-staleformguard-default-on).
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

#### MWS self-test fixes (D1, D3, D4, D5)
- **Callers that read `Object.keys(current)` of a `version_conflict` as "what changed":** use `fields_changed` (an
  `if_match` refusal) or `changed_since` (a ws_undo conflict) instead; `current` is now the whole document. A conflict
  with `readable: false` carries no state: the token cannot read the document.
- **Agents and scripts that resend a versioned write:** handle `replay_superseded` like `version_conflict` without a
  retry version: read again (ws_get), check whether the change is still there, and send it with an `idempotency_key`
  only if it is still wanted. A late retry after any later write to the document is refused this way too.
- **Callers of ws_replace without a filter:** add `allow_all: true` to the dry run and to the start (the `plan_token`
  covers it), or give a filter. A job started from an unfiltered plan before the upgrade resumes with `{job_id}`.
- **Config:** check `config.modules` (and `WRITESAFE_MODULES` in the test app) for misspelled names before upgrading;
  Strapi does not start with one.
- **Clients that send booleans, integers or JSON as strings:** they now get a type error naming the argument. Fix the
  client, or opt back in with `lenientArgs: true` in the plugin config (`WRITESAFE_LENIENT_ARGS=true` in the test app).

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
