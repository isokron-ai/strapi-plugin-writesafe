# Bulk and create tools (writesafe 1.0 modules)

These five modules add four tools and one row op. They are part of the writesafe plugin and are off until you turn
them on (`config.modules.<name>`, or `WRITESAFE_MODULES=bulk,create,delete,replace,copy`). A module that is off
registers nothing.

| Module | Adds | Permission (Content Manager) |
|---|---|---|
| `create` | `ws_create` | create (and read for `unique_by`) |
| `delete` | `ws_delete` | delete (and read) |
| `bulk` | `ws_bulk` | update or publish, per document |
| `replace` | `ws_replace` | read to scan, update to write, per document |
| `copy` | the `copy` row op in `ws_patch` and `ws_batch` | read on the source, update on the target |

They follow the same contract as the core tools:
- writes run in a transaction under a row lock;
- versions are preconditions;
- the Content Manager permission checker is applied per document and per field;
- refusals are `isError` with `{ok: false, error: {code, …}}`;
- `idempotency_key` (ws_create, ws_delete) and `dry_run` are supported (a create or bulk patch dry run runs the write
  and rolls it back, so Strapi lifecycle hooks and middlewares run in it; the ws_delete dry run and bulk publish
  previews never call Strapi's delete or publish); ws_bulk and ws_replace jobs start from a dry run's plan token
  instead of a key;
- replies are compact receipts.

Writes also go through the module hooks (`afterWrite`), so the history module records them and `ws_undo` can revert
them.

## ws_create

Creates one draft. `data` takes the same shape as `ws_patch` `set`:
- scalars;
- a single component as an object;
- repeatable components and dynamic zones as lists (zone rows with `__component`);
- blocks;
- relations as documentIds;
- media as existing file documentIds or ids.

Rows copied from a `ws_get` read may keep their `_key`. It is ignored: every row is new.

```json
{"uid": "api::story.story", "locale": "en", "unique_by": "externalId",
 "data": {"title": "Harbour lights", "externalId": "feed-4711", "items": [{"label": "a", "qty": 1}]}}
```

**Upsert (`unique_by`)**
- `unique_by` names a string, uid, email or integer field.
- If a draft with that value exists in the locale, nothing is created. The reply is that document with
  `existed: true` and `differs` (scalar fields whose value differs). Its `version` comes only with `return: "full"`,
  together with the `document` it stands for; otherwise read it with ws_get before patching.
- Concurrent identical creates are safe. Each create claims the value under the receipts table's unique index, and the
  claim is released before commit. On all three databases, 5 rounds of 6 simultaneous identical upserts gave one
  `created` and five `existed` each time, with one document.
- The token must be allowed to read and create the `unique_by` field.

**UID fields (slugs)**
- A missing value is generated from the target field the way the admin does it (`hello-world`, then
  `hello-world-1`, …).
- A given value that is already taken in the locale is refused with `uid_conflict`, which carries a free
  `suggestion`.
- A taken `unique: true` field is refused with `unique_conflict`.
- Uniqueness is per locale.

**Locales**
- Only the named locale is created. With no locale named, the default locale is used and the receipt says
  `locale_defaulted: true`.
- A matching value in another locale is reported as `same_value_in_other_locales`. It never adds a locale to that
  document (that is `ws_localize`).

**Not covered:** collection types only. Single types use the built-in `write_<type>`.

## ws_delete

Deletes a document, or one locale of it, only if it is still the version you read.

```json
{"uid": "api::page.page", "documentId": "…", "expected_version": "2026-…~ab12…"}
{"uid": "api::guide.guide", "documentId": "…", "all_locales": true, "expected_version": {"en": "…", "fr": "…"}}
```

**Preconditions**
- `expected_version` is required. Without it the call is refused with `precondition_required`, which carries no
  version (1.0 hardening): read with ws_get and send the version you read. `force: true` deletes without a check, where the admin allows it
  (`allowForce`; off by default in `guard` and `hide`, where the argument is not offered and is refused).
- A stale version gets `version_conflict`, with the current values; its `retry` carries a hint to re-read and confirm,
  no version.
- Localized types must name `locale`, or set `all_locales: true` with a version for every locale. A locale that
  someone added in the meantime is refused, not deleted unseen.

**Idempotency:** a document that is already gone gets `ok: true, deleted: false, already_absent: true`.

**Receipt contents**
- `previous_version` and `was_published` (per locale).
- `recreate`: `ws_create` arguments that bring back each deleted draft (relations and media as references). Fields
  the token could not read are listed in `recreate_missing`.

## ws_bulk

One patch or publish over every draft that matches a filter. Since the 1.0 hardening (Phase 3) a job always takes two
calls: a dry run, which returns a **plan token**, and a start that presents it.

### The call sequence

```jsonc
// 1. dry run: what would change, how many documents, and a plan token
ws_bulk {"uid": "api::post.post", "filters": {"category": {"name": {"$eq": "News"}}},
         "set": {"category": "n4f2…updates"}, "dry_run": true}
→ {"ok": true, "dry_run": true, "match_count": 2013, "chunks": 81, "max_documents": 5000,
   "preview": [{"position": 0, …}, {"position": 503, …}, {"position": 1006, …}, {"position": 1509, …}, {"position": 2012, …}],
   "events": {"per_document": ["entry.update"], "at_most": 2013, "note": "…"},
   "undoable": true, "plan_token": "wsp1.eyJl….Qm9v…", "expires_at": "2026-11-13T12:15:00.000Z", "hint": "…"}

// 2. start: the same call, dry_run left out, plan_token added
ws_bulk {"uid": "api::post.post", "filters": {"category": {"name": {"$eq": "News"}}},
         "set": {"category": "n4f2…updates"}, "plan_token": "wsp1.eyJl….Qm9v…"}
→ {"ok": true, "job_id": "j3c1…", "status": "running", "total": 2013, "processed": 975, "remaining": 1038, "totals": {…},
   "next": {"hint": "Not finished. Call the same tool again with only {job_id} to continue.", "job_id": "j3c1…"}}

// 3. continue until done
ws_bulk {"job_id": "j3c1…"}
→ {"ok": true, "status": "done", "total": 2013, "processed": 2013, "totals": {"ok": 2010, "unchanged": 0, "skipped": 3, "failed": 0, "conflict": 0},
   "reconcile": {"still_matching": 12, "late_matches": 12, "late_ids": ["…"], "note": "12 document(s) match the filter now that were not in the planned set …"}}
```

A lost reply is recovered by sending the start (step 2) again: the job id is derived from the plan token, so the same
start answers with the same job (`resumed: true`) instead of starting another. `idempotency_key` is no longer an
argument of ws_bulk and ws_replace.

### 1. Dry run

`chunks` in the reply is a lower bound: the chunk time cap (`bulk.chunkTimeMs`) can split a chunk.

- **A filter is required.** A missing or empty `filters` is refused with `filter_required`, also on a dry run (rc.2
  patched every document when the filter was left out). `allow_all: true` selects every document on purpose.
- **The ceiling.** More matches than `bulk.maxDocuments` (5,000 by default; an admin may raise it up to 100,000, a code
  constant) or than the caller's own `max_documents` are refused with `too_many_documents`, which carries
  `match_count` and `max_documents`. Nothing is written. Narrow the filter (a date range, another field) and run one
  job per part. A larger single job needs an admin to raise the ceiling: no argument raises it.
- **The preview** is the real write, rolled back, for a spread of the matches: the first, the last and evenly spaced
  ones between (`position` is the index in the job). Each entry has `changed`, `before`, `after`, or its error.
- **`events`** says what the job emits: `entry.update` (patch) or `entry.publish` (publish), at most once per
  document. Strapi fires them after each chunk commits, for documents actually written; every webhook subscribed to
  them is called that often. Lifecycle hooks and Document Service middlewares run during the dry run too.
- **`undoable`**: whether ws_undo can revert the job (the history module is on and the action is not publish).
- **The plan token** (`wsp1.<payload>.<mac>`): the MAC is a full-length HMAC-SHA256, keyed from the app's
  `APP_KEYS`, over
  - the token holder (the admin user and a hash of the bearer token),
  - the content type, the locale (resolved) and the canonical filter,
  - the action and a hash of every argument that defines the job (`set`, `unset`, `ops`, `mode`, `allow_all`, and
    for ws_replace `find`, `replace`, `regex`, `flags`, `case_sensitive`, `fields`),
  - the match count and a sha256 of the matched documentIds in job order (for publish: each with its draft version),
  - `undoable`, the expiry (15 minutes, `bulk.planTtlSeconds`) and a random nonce.

  The payload carries the expiry, count, id-list hash, `undoable` and nonce in clear (none of it is secret); the
  server recomputes everything else at the start. Arguments that only run or check a job (`chunk_size`, `max_chunks`,
  `preview`, `max_documents`, `expected_count`, `agent`) are not part of the plan. `publish: "if_clean"` is (see below).

### 2. Start

The start is the dry-run call with `dry_run` left out and `plan_token` added. It is refused, with nothing written, when:

| Code | When |
|---|---|
| `plan_required` | No `plan_token`, or not one from a dry run. |
| `plan_mismatch`, `reason: "request"` | The call is not the one that was dry-run (another filter, change, type, locale or mode), or another API token sends it. |
| `plan_expired` | The token is older than 15 minutes. |
| `plan_mismatch`, `reason: "matches"` | The documents the filter selects now are not the planned set: one entered or left the filter, or (publish) a draft changed. Carries `planned_count` and `match_count`. |
| `job_running` | This token already has an active job (running, paused or stopped) on this content type. Carries its `job_id`. |
| `jobs_paused` | The site owner paused all bulk jobs (`bulk.paused`). |

`plan_mismatch` and `plan_expired` have `requires_reread: true`: dry-run again. `expected_count` is still accepted as an
extra check (`count_changed`); the plan token already checks the exact set.

The start writes the **id snapshot once**: one row per document in `writesafe_bulk_items` (its ordinal, its documentId
and, for publish, the planned draft version) and one job row in `writesafe_bulk_jobs` with a cursor and counters.
rc.2 kept the id list inside the job's receipt row and rewrote that whole row after every chunk (about 2.5 GB written
for a 50,000-document job); now a chunk writes its own item rows and one fixed-size job row.

**Documents created or moved into the filter after the plan are never touched.** When the job is done, `reconcile`
counts the filter now (`still_matching`) and lists the documents that match now but were not in the job
(`late_matches`, up to 20 `late_ids`). Plan a new job to include them.

### 3. Chunks

The job runs in chunks (`chunk_size`, default 25, max 100), one transaction per chunk:
- lock the job row;
- lock the chunk's documents before the first read. With the 1.0 locking work (Phase 2 stream B) this is every
  locale's draft row, in the one lock order every writesafe write uses; before that it is the job locale's draft rows
  in id order, and two jobs on different locales of one type can wait on each other;
- check which of them still match the filter (one query);
- per document, in its own **savepoint**: re-read it, skip it if it no longer matches or was deleted, and write with a
  version precondition:
  - patch: the version read at that moment, so a colleague's edit to another field is kept (see "Clean merges");
  - publish: **the draft version the plan bound**. A draft edited since the dry run is a `conflict` for that document
    and is not published: only the reviewed draft is. Review it and publish it on its own (ws_publish).
- write the item outcomes and advance the cursor, in the same transaction.

So a chunk is either fully done and recorded, or not done at all. A failing document is rolled back to its savepoint
alone (its queued events dropped, its history entry removed); rc.2 rolled the whole chunk back and re-ran it once per
failing document. On a Strapi without `db.savepoint` (5.47 to 5.5x; 5.62.0 has it) the chunk re-run is kept as the
fallback. A chunk also ends early after `bulk.chunkTimeMs` (1 s), so an admin Save waiting on its rows does not wait
long, and ws_replace ends it when its regex budget for the chunk is spent.

**The canary.** The first chunk of a job that has more than one chunk is a canary: when any of its documents fails or
conflicts, or none of them changes, the job pauses (`status: "paused"`, error `paused_canary`, with `paused.why` and
the counts). `{job_id}` alone does not resume it; `{job_id, control: "resume"}` does, `ws_job {action: "cancel", job_id}`
ends it. The canary is the job's first chunk only: when that chunk stops (`stop_on_error`) and the job is resumed, no
canary runs again; and when the chunk time cap (`bulk.chunkTimeMs`) cuts the first chunk short, the canary judges
only the documents that chunk reached.

### 4. Resume, status, cancel (ws_job)

Continuing and resuming a job stay on its own tool (`ws_bulk` or `ws_replace` with `{job_id}`). Reading, listing,
cancelling and undoing a job is the `ws_job` tool (1.0 hardening, phase 4; it comes with the `bulk` or `replace`
module).

- A call runs chunks, with a pause of `bulk.paceMs` (50 ms) between them so other writers get the rows, until the job is
  done or the time budget is used (`bulk.timeBudgetMs`, 20 s), or after `max_chunks` chunks when the call gives it
  (on the start or on `{job_id, max_chunks}`: pacing for the caller, not part of the plan). Then it returns
  `status: "running"` and the `job_id`; call again with `{job_id}`, also after a crash. In the kill test Strapi was
  killed with `kill -9` mid-job and restarted; the job resumed and every document was written exactly once.
- `ws_job {action: "status", job_id}` returns the job and one page of items (200): failed, conflicting and skipped
  documents by default, `items: "all"` for every document, `cursor` from `items_next` for the next page. It writes
  nothing. rc.2 read up to 5,000 chunk receipts and returned every item. Status items carry the outcome, not the new
  version (the reply of the call that wrote a document has it).
- `ws_job {action: "list"}` lists the token's jobs (ws_bulk, ws_replace and undo jobs), newest first, 20 per page
  (`limit` up to 100, `cursor` from `next_cursor`): id, tool, action, type, status, totals, created and updated
  times. No content.
- Replies are bounded: the items of one call list at most 200 entries (only the problems when a call handled more:
  `items_truncated`), and `failures` and `conflicts` at most 20 each, with `failures_more` / `conflicts_more`. Item
  errors keep 500 characters of the database's own text (200 in reply lists).
- `ws_job {action: "cancel", job_id}`: waits for a chunk that is running (it commits), then the job stops; what was
  written stays, the rest is not written, and the job's slot is free. It cancels a running, paused, stopped or
  `awaiting_approval` job, also one an admin paused (`admin_job`, `permission_changed`, `runner_errors`): the agent
  can stop it but only an admin resumes it. A cancelled job cannot be resumed (`job_cancelled`). Cancelling a job that
  is done or cancelled changes nothing (`cancelled: false` and a note).
- Only the token that started a job can see, resume, cancel or undo it: another token's job id is `not_found` in
  ws_job too. One job per token and content type is active at a time (running, paused or stopped); finish or cancel it
  to start the next.
- **Moved arguments.** Before phase 4, ws_bulk and ws_replace took `status_only`, `items`, `cursor` and
  `control: "cancel"` with `{job_id}`. They now answer those with `invalid`, naming ws_job (nothing runs).
  `max_chunks` stays on both tools (start and `{job_id, max_chunks}`), as on ws_undo and ws_job's `undo`.
- The owner's kill switch: `bulk.paused: true` refuses new starts and pauses running jobs at their next chunk.

**Statuses**

| Job `status` | Meaning |
|---|---|
| `running` | More to do: call with `{job_id}`. |
| `paused` | The canary or the owner paused it: `{job_id, control: "resume"}`, or `ws_job {action: "cancel", job_id}`. An error reply (`paused_canary`, `jobs_paused`). |
| `stopped` | `stop_on_error` met a failing document: fix it and call `{job_id}` to retry from it. An error reply (`job_stopped`). |
| `done` | Finished; `reconcile` reports the filter now. |
| `cancelled` | Cancelled; earlier writes kept. |

| Item status | Meaning |
|---|---|
| `ok` | Written. In the reply of the call that wrote it: patch items carry the new `version`, publish items `published_version`. |
| `unchanged` | Every value was already as requested (only for fields the token can read). |
| `skipped` | `reason: no_longer_matches` or `deleted`. |
| `conflict` | The document is not the one the plan bound (publish: a newer draft). Not written. |
| `failed` | Carries the error. In `stop_on_error`, the stopping document is `failed` (counted, listed) while the job is stopped, and is retried on resume. |
| `not_attempted` | Not reached yet: after a stop, or (ws_job status of a running or paused job) not processed so far. |

**Modes**
- `stop_on_error` (default): the documents before the failing one are committed and the job stops (`job_stopped`,
  naming the document). A resume retries from that document. A `conflict` does not stop the job.
- `continue`: the failing document is recorded and the rest goes on. The reply has `totals.failed` and `failures`.

**Guards**
- `max_documents`: lowers the limit for this job. Up to `bulk.maxDocuments` (5,000) a job runs at once; above it, up to
  `approvals.maxDocuments` (20,000 by default, at most 100,000; ws_replace stays under `replace.maxScanDocuments`), the start answers `approval_required` and the job waits for one admin (two
  different admins above `approvals.twoApproverAbove`, 25,000) to approve it on the admin panel's Write-safe jobs page;
  then `ws_bulk {job_id}` starts it (or the in-Strapi runner does, when `runner.enabled`). More matches than that, or
  than `max_documents`, get `too_many_documents`. The agent cannot approve: see [`tools-approvals.md`](tools-approvals.md)
  (the plugin README has the summary).
- Filters are checked against read permission. A filter on a field the token cannot read is refused, never silently
  dropped. The action's permission conditions are added.
- `ops` may add rows, and add or remove single links by ref (1.0 hardening item 20): `{op: "add" | "remove", field, ref}`
  on a to-many relation or a multiple media field, or with `path` inside a single component. A re-tag (remove News,
  add Updates) keeps every other link of each document; a document where every ref op is a no-op is `unchanged`. Keyed
  ops (row edits, ref ops inside a row) are refused: row keys differ per document.
- The dry run's `undo_budget` (when `undoable`): the before-image budget per document and per job, the estimate from
  the previewed documents, and `within_budget`. The undo of a job is a resumable undo job (see `tools-l10n-history.md`,
  Undo jobs).

### Clean merges of different fields

A patch job writes each document at the version read under that document's lock, inside the chunk's transaction.
So when a colleague changed another field of the document after the dry run (a typo in the body, a new section),
the job's change lands next to it and the colleague's edit is kept: the two edits touch different fields and merge
cleanly. When the colleague changed the very field the job sets, the job's value wins for that field (the job was
told to set it), and the document's other fields are untouched. Rows a colleague added to a list survive an `add` op.
A document the colleague moved out of the filter is `skipped` (`no_longer_matches`), never written.

Publish is the exception on purpose: a publish makes the draft live, so it publishes only the draft the dry run saw
(item 19). A draft that changed is a `conflict`.

### Patch and publish: `publish: "if_clean"`

A patch job (and a ws_replace job) takes `publish: "if_clean"` (1.0 hardening, phase 4): each document is written as a
draft as usual and, in the same savepoint and transaction, published, but only when its draft and live version were
identical before the patch (the semantic hash the version uses, without publish-state fields). A document whose draft
already held another unpublished change stays a draft: publishing it would make that change live without review.

- **Per document**, a written item (`ok`) says what happened: `published: true`, or `published: false` and
  `publish_skipped`: `"draft_had_other_changes"`, `"no_live_version"` (never published), `"nothing_changed"` (the
  write changed nothing) or `"publish_invalid"` (Strapi's publish validation would refuse the new draft; it is
  written, not published). An `unchanged` item is neither written nor published. The job's `totals` add `published`
  and `publish_skipped`; `ws_job {action: "status"}` lists them per document.
- **The dry run** says it: `publish: "if_clean"` and a `publish_note`, and each preview entry has `would_publish` (and
  `publish_skipped` when it would not). The preview never calls Strapi's publish. `events.per_document` lists
  `entry.publish` next to `entry.update`, and `at_most` counts both.
- **Part of the plan.** `publish` is in the plan token's change hash: a start that adds or drops it is
  `plan_mismatch` (`reason: "request"`).
- **Permission.** A token without the publish permission on the type is refused with `forbidden` before anything is
  written, on the dry run too. `action: "publish"` with `publish` is `invalid` (a publish job publishes every matching
  draft as it is).
- **Approvals.** With `approvals.escalate.publish`, a patch job with `publish: "if_clean"` counts as a publish and
  needs an admin's approval, like `action: "publish"`. Whatever the reason for the approval, its approver needs the
  publish permission as well as the update permission, and the Write-safe jobs page titles the card "... and publish
  (if clean)".
- **Never over a conflict.** Each document is written with the version read under its lock; the publish only follows
  a write that landed. A document that failed or conflicted is neither written nor published.
- **Undo.** Undoing the job reverts the drafts it wrote. What it published stays live until it is published again: the
  dry run's `publish_note` says so.

### What a bulk job does and does not protect

- **Only writes through writesafe are protected.** The version check, the row locks and the plan cover writes made
  through ws_* tools. The Content Manager, REST, GraphQL and other plugins write without a version: they cannot
  deadlock with a job (the Document Service lock), but they can overwrite what a job wrote.
- **An open admin tab can overwrite an agent's edit.** An editor who opened a document before the job and saves after
  it saves the whole form, the job's change included, back to what the tab showed. Strapi's admin has no version
  check; writesafe cannot see that tab.
- **Changes are draft-only.** A patch job writes drafts; nothing goes live until a publish (ws_publish, ws_bulk
  `action: "publish"`, or the admin).
- **The version does not cover related documents or files.** A document's version covers its own fields, relation
  targets by documentId and media by reference. An edit inside a related document (the author's name) or a replaced
  file does not change it.
- **The set is fixed at the start.** Documents that join the filter later are reported, not touched.
- **Other locales' drafts.** On a localized type, a change to a non-localized field is copied by Strapi to every other
  locale's draft of the document. Those drafts change (and can fire `entry.update`) although the job planned only one
  locale; the dry run's `events.at_most` does not count them.

## ws_replace

Search and replace in the text of one content type. It reaches into:
- string, text and richtext fields;
- single components;
- repeatable components;
- dynamic-zone rows;
- blocks text nodes (formatting kept).

```json
{"uid": "api::page.page", "filters": {"title": {"$startsWith": "Rename"}}, "find": "Acme", "replace": "Apex", "dry_run": true}
```

**Scope**
- `filters` narrows the documents. It is required, as for ws_bulk (MWS-TGT-2): a missing or empty filter is refused
  with `filter_required`, also on a dry run, because it would scan and change every document of the type. Send
  `allow_all: true` when every document is really meant; the dry run's `plan_token` covers `allow_all`, so the start
  must send it too.
- `fields` takes paths such as `title`, `seo.metaTitle`, `items.label`, `sections.body` (any zone component with
  that field) and `body`.
- The default is every text path the token can write.

**Matching**
- Literal by default. `case_sensitive: false` is available.
- `regex: true` takes JavaScript syntax. `$1`, `$<name>` and `$&` are expanded, and `flags` may contain `imsu`.
- Patterns that match empty text are refused.

**Dry run** returns:
- `scanned` and `scan_limit`;
- `documents_matched` (`match_count`);
- `matches`, and `matches_by_path`;
- samples (before and after, with row keys);
- a preview of a spread of the writes, rolled back;
- a `plan_token` over the documents with a match (as ws_bulk, above).

**Run**
- The dry-run call with `plan_token` starts a `ws_bulk` job over exactly the documents the dry run found. The start
  scans again and is refused with `plan_mismatch` when a document gained or lost a match since.
- Each document is re-read under lock, and the replacement is computed again from its current text: a document a
  colleague already fixed is `unchanged`, and a row a colleague added is replaced too.
- Each document is written with the version read at that moment as the precondition. Component and zone rows are
  updated by key, so ids are kept.
- `publish: "if_clean"` publishes each changed document in the same write when its draft had no other unpublished
  change, as a ws_bulk patch job does (see above); it is part of the plan and needs the publish permission.

**Safety limits**
- Regexes run in a separate V8 context, with a time limit per document (`replace.regexTimeoutMs`, 250 ms), in total
  per scan (`replace.totalRegexMs`, 5 s) and per job chunk (`replace.chunkRegexMs`, 1 s): a chunk keeps one replacer
  and commits before a document could get less than its own limit, so the event loop is never held for a whole chunk
  of slow documents (rc.2 built a replacer per document). A catastrophic pattern is stopped with `regex_timeout`.
- Length caps on the pattern, the replacement and the result.
- **Two limits.** The scan reads at most `replace.maxScanDocuments` documents (5,000; rc.2's `scanMax` is still read);
  more matches of the filter are refused with `too_many_documents` and `scan_limit`. The job then changes at most
  `bulk.maxDocuments` of them (the ws_bulk ceiling). Both may be raised up to 100,000.
- **What a large scan costs.** One V8 context serves a whole scan, and only the time spent in the regex work counts
  against `totalRegexMs`. A trivial pattern counts about 0.005 ms per document, so 100,000 documents use about 0.5 s
  of the 5 s budget; the call itself takes longer (each document's run has a time-limit watchdog, about 0.1 ms per
  document on the machine measured, plus reading the documents: a dry run and a start of a 100,000-document replace
  each take tens of seconds). The plugin refuses to start when `totalRegexMs` is below `regexTimeoutMs` or below
  `maxScanDocuments` x 0.02 ms.

**Not covered:** text inside components nested in components, and blocks inside components.

## The copy row op

```json
{"op": "copy", "field": "sections", "key": "blocks.hero:505:<mac>"}
{"op": "copy", "field": "items", "keys": ["shared.item:3:<mac>", "shared.item:4:<mac>"], "position": "start"}
{"op": "copy", "field": "sections", "key": "blocks.hero:77:<mac>", "from": {"documentId": "…", "locale": "fr"}}
{"op": "copy", "field": "items", "key": "shared.item:3:<mac>", "from": {"uid": "api::guide.guide", "documentId": "…"}}
```

**What a copy is**
- The copy is a new row with a new id. Nested components are copied as new rows too.
- Relations and media references are kept.

**Position**
- Default: right after the source, when copying within the same field. Otherwise at the end.
- `position` works as for `add`. Several keys keep their order.

**Source**
- `from` names another document, locale, content type or field.
- The source is read with the caller's read permission.

**Refusals**
- A source row with any field the token cannot read, nested fields included: `forbidden`. The row is never copied
  without those fields.
- A copied sub-field the token may not write: `forbidden`.
- A component not allowed in the target zone: `invalid`.
- Blocks into a component field: `invalid`.
- A key that is gone: `row_not_found`. A source key whose row changed since it was read (or from another database):
  `stale_row_key` (1.0 hardening item 16b; keys are the ones ws_get shows for the source document).

Copies run inside the `ws_patch` transaction, after the version check, so rows other writers added survive.

## Config

```js
writesafe: { config: {
  modules: { bulk: true, create: true, delete: true, replace: true, copy: true },
  bulk:    { maxDocuments: 5000, chunkSize: 25, maxChunkSize: 100, timeBudgetMs: 20000, previewMax: 20, chunkTimeMs: 1000,
             paceMs: 50, planTtlSeconds: 900, paused: false },   // maxDocuments: at most 100,000 (a code constant)
  approvals: { enabled: true, twoApproverAbove: 25000, maxDocuments: 20000, escalate: { publish: false, relations: false } },
  runner:  { enabled: false, workers: 1, leaseMs: 60000, heartbeatMs: 15000, chunkPauseMs: 250 },
  replace: { regexTimeoutMs: 250, totalRegexMs: 5000, chunkRegexMs: 1000, maxPatternLength: 1000, maxReplaceLength: 10000,
             maxOutputLength: 1000000, maxScanDocuments: 5000, samples: 10 },   // rc.2's scanMax is still read
} }
```

## Tests

`tests/test_bulk_create.py` needs a running Strapi with the spike tokens plus `scripts/setup_bulk_tokens.mjs`. Set
`BULK_RESTART_CMD` and `BULK_PID_FILE` to include the kill-and-resume test.

It passes 172/172 on SQLite, Postgres 16 and MySQL 8.4 (see the PR for the per-database runs).

## Limits

**Bulk jobs**
- Jobs are kept in the receipts table and are not pruned yet.
- `continue` mode re-runs a chunk once per failing document, so many failures in one chunk cost one transaction
  each.

**MySQL**
- MySQL runs at REPEATABLE READ. A chunk locks its documents before its first read, so it never reads them stale.
  ws_delete locks its document as the transaction's first statement (1.0 hardening). ws_create's upsert lookup and
  ws_undo still read before they lock: a write that waited for a row lock while another write committed is re-run
  (`STALE_SNAPSHOT` in the log), and under heavy contention on one document it can end as `busy` after 8 attempts.

**Native-agent checks**
- Not run: the API key had no credit (fixtures and checkers are in `agent/bulk/`).

## From the package README

The package README's sections on these modules, moved here (the README keeps a one-line summary per tool). Phase 4
updated the job arguments in them (ws_job).

### `create`: ws_create

Creates one draft from `data` in the ws_patch `set` shape (scalars, components, zones, blocks, relations as
documentIds, media as existing files). `unique_by: "<field>"` makes it an upsert: if a draft with that value exists in
the locale it is returned (`existed: true`) instead of a duplicate, also under concurrent identical calls. That reply
carries a version only with `return: "full"`, together with the document it stands for; otherwise the hint says to read
it with ws_get. Upserts and unique values are serialised through the receipts table's unique index; without it such
creates are refused (`unsupported`). A `uid` field
is generated when not given; a taken one is `uid_conflict`. Only the named (or default) locale is created.
`uid_conflict` and `unique_conflict` name the other document only when the token may read that entry (its permission
conditions included), and keep the value in `value`, not in the message.

### `delete`: ws_delete

Deletes one locale (`locale`, `expected_version`) or every locale (`all_locales`, `expected_version: {locale: version}`).
Without a version the call is `precondition_required` (with no version in it: read with ws_get). A stale version is
`version_conflict`, whose `retry` carries no version; deleting an absent document is ok with `already_absent: true`. The reply carries
a `recreate` payload (ws_create arguments) and, with history on, a `receipt_id` that ws_undo can revert. The dry run is a
preview that never calls Strapi's delete (`would_delete: true`, `deleted: false`).

### `bulk`: ws_bulk

Patch (`set`, `unset`, `ops` add, and ref ops add/remove by `ref` for a re-tag that keeps other links) or publish every draft matching `filters` (required; `allow_all: true` to select every
document). Two calls (1.0 hardening, Phase 3):
1. `dry_run: true` returns `match_count`, a before/after preview spread over the matches, the events the job will fire
   (`events`), whether it is `undoable`, and a `plan_token`: a full-length HMAC over the token holder, type, locale,
   filter, change, count and the hash of the matched id list, valid 15 minutes.
2. The same call without `dry_run`, with `plan_token`, starts the job on exactly those documents. Another request,
   another API token, an expired token or a changed set of matches is refused (`plan_mismatch`, `plan_expired`);
   nothing is written. Sending the same start again answers with the same job (the job id comes from the token).

The id list is stored once, as rows of the plugin's `writesafe_bulk_items` table; the `writesafe_bulk_jobs` row keeps a
cursor and counters. The job runs in chunks (default 25), one transaction each; every document is re-read under lock
and written with that version as precondition (each in its own savepoint), so a colleague's edit to another field
survives. A publish job publishes only the draft version the dry run saw: a newer draft is a `conflict`, not
published. The first chunk is a canary: if a document in it fails or conflicts, or none changes, the job pauses
(`paused_canary`; `control: "resume"`, or cancel it with ws_job). Long jobs return `status: "running"` and a `job_id`; call again
with `job_id` (also after a crash). Documents created during the job are never touched; the done reply's `reconcile`
counts them (`still_matching`, `late_matches`). One active job per token and content type (`job_running`); `ws_job`
lists, reads (paging through the items), cancels and undoes jobs. `publish: "if_clean"` on a patch job also publishes
each document whose draft had no other unpublished change. Limits: `bulk.maxDocuments` (5,000; an admin may raise it to the hard 100,000), more matches
are `too_many_documents`. A token with only the publish permission may run `action: "publish"`; a patch job needs the
update permission. Full reference, with the call sequence and what a job does not protect:
`docs/tools-bulk-create.md`.
The dry run's `undo_budget` shows the before-image budget (per document, per job) and whether every change stays
undoable (`within_budget`).

### `replace`: ws_replace

Find and replace across the text of matching documents: scalars, components, zones, item labels and blocks text.
Literal by default, `regex: true` for a regular expression (run in a sandbox with per-document and total time limits).
`filters` is required (`filter_required`), or `allow_all: true` for every document of the type.
`fields` narrows the paths; by default every text path the token can write. An explicit field the token cannot write is
refused up front (`forbidden`, listing it), also on the dry run. Dry run lists matches with samples and returns a
`plan_token`; the start (the same call with it) runs through the bulk engine (chunks, resume, per-item status). The scan
reads at most `replace.maxScanDocuments` (5,000) documents; the job changes at most `bulk.maxDocuments` of them. A
scan uses one V8 context and counts only regex time against `totalRegexMs` (which must cover
`maxScanDocuments` x 0.02 ms); a chunk keeps one regex budget (`replace.chunkRegexMs`).

### `copy`: the copy row op

`{op: "copy", field, key | keys, position?, from?: {documentId, locale, uid, field}}` in ws_patch or ws_batch duplicates
rows as new rows (relations kept), right after the source by default, or copies them from another document, locale or
type. Source rows are read with the caller's read permissions; the core then checks write permission on every copied
field.
