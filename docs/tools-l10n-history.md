# Translation, history and undo (modules `localize` and `history`)

Two modules of the writesafe plugin. `localize` is off by default; `history` is on by default since the 1.0 hardening
(phase 4) and turned off with `modules: { history: false }`. When a module is off it registers no tools, adds no
arguments and stores nothing.

```js
// config/plugins.js
writesafe: {
  enabled: true,
  resolve: './src/plugins/writesafe',
  config: {
    modules: { localize: true, history: true },
    history: { retentionDays: 30, maxBeforeBytes: 262144, pruneEverySeconds: 3600, undo: true }, // all optional
  },
}
```

In this repo, `WRITESAFE_MODULES=localize` turns localize on (history is on already); `WRITESAFE_MODULES=-history`
turns history off. The `WRITESAFE_HISTORY_*` variables set the options
(see `app/config/plugins.js`).

| Tool | Module | Auth (session gate) | What it does |
|---|---|---|---|
| `ws_localize` | localize | content-manager update | Creates or updates one target locale from the source locale's structure. The agent supplies only translated text. |
| `ws_history` | history | content-manager read | Lists the receipts of ws_* writes: who, what, when, which fields and rows changed, and optionally the before values. |
| `ws_undo` | history (`undo: true`) | content-manager update | Reverts exactly what one receipt changed. It is refused if those fields or rows changed since. |

These tools follow the same rules as `ws_patch`:
- one transaction per call;
- row locks;
- version tokens;
- the token's content-manager permissions, checked per document and per field;
- `isError` with `{ok: false, error: {code, …}}`;
- `idempotency_key`, `dry_run` and compact receipts.

Neither module calls a language model. Translation is the agent's job.

## ws_localize

Two calls:

1. **Plan** (no `translations`): read-only. It returns every text unit of the source locale as `{path, source}`. For
   an existing target it also returns `current`, the target's text where it differs from the source. The reply also
   has `source_version` and `target_version`, a summary of matched, added, kept and removed rows, the relations it
   cannot map, and for an existing target the row pairing (`row_map`), the rows it cannot pair (`ambiguous_rows`) and
   the rows only the target has (`target_only_rows`).
2. **Write** (`translations: {path: text}` with `expected_source_version`, plus `expected_version` when the target
   exists).

```json
{"uid": "api::article.article", "documentId": "…", "locale": "fr",
 "expected_source_version": "v2.Lr3vO8m2Qe1kT9zXyB4nH6sJ0pWcA5dF7gUiE2qRtM",
 "translations": {
   "title": "Jardin de printemps",
   "seo.metaTitle": "…",
   "sections[0:blocks.hero].heading": "Bienvenue",
   "items[0:shared.item].label": "Râteau",
   "body[2:paragraph].children[1].children[0].text": "ce lien"
 }}
```

### Paths

Paths are structural (1.0 hardening item 15): a position and a type at every level, never a database row id. Strapi
recreates component rows when a locale is created or a non-localized field changes; the paths (and the source's
semantic version) stay the same then.

| Path | Unit |
|---|---|
| `title` | top-level string, text, richtext or uid field |
| `seo.metaTitle` | field of a single component |
| `sections[0:blocks.hero].heading` | field of the first dynamic-zone row, a `blocks.hero` |
| `items[1:shared.item].label` | field of the second repeatable-component row |
| `sections[2:x.y].list[0:a.b].label` | nested component rows |
| `body[0:paragraph].children[0].text` | text leaf of the first blocks node, a paragraph |

A path names a position of a given type: when the source moves, removes or retypes a row, its version changes too, and
the call is refused (`version_conflict` on `expected_source_version`): plan again.

- Only text can be translated: string, text, richtext and uid fields, and the text leaves of blocks.
- A path that is not a text unit of the current source, such as a typo, an rc.2 row-key path or a non-text field like
  `code`, is refused with `invalid` and `unknown_paths`. Nothing is written.
- The receipt's `source_version` is the source re-read inside the write's transaction; it stays valid for the next
  locale (Phase 0 N13: before the semantic version, creating `fr` made it stale).

### What gets copied

- **Structure**: row order, component types, blocks node types, link URLs and heading levels.
- **Values that are not text**: numbers, enumerations, booleans, JSON, dates, and media (by reference, including media
  inside components).
- **Relations**:
  - A relation to a localized type is linked to the related document's version in the target locale.
  - If that version does not exist, the relation is left empty and reported in `unmapped_relations`.
  - A relation to a type without i18n is kept as is.
  - `relations: "skip"` copies no relations.
- **Non-localized fields** are never written. Strapi keeps them in sync across locales.
- **Fields the token cannot read** in the source are neither shown nor copied. If the token cannot read the target
  locale, the plan shows neither its text nor its version.
- **Locking**: every locale row of the document is locked before the source and target are read. Two calls that would
  both create the target queue, and the second one then needs the first one's `expected_version`.

### Updating an existing target locale

- **Pairing rows** (since the phase 2 hardening, item 12): every source row is paired with a target row through an
  explicit row map, never by position. In order:
  1. `row_map` from the caller: `{"<list path>": {"<source row>": "<target row>" | null}}`. Rows are named as the plan
     shows them, by position in their own locale's list (`0:blocks.hero`, the form of the unit paths); a ws_get row key
     (`blocks.hero:12:<mac>`) is accepted too and matched by its row identity. `null` makes the source row a new row.
     List paths are the plan's (`sections`, or `sections[0:l10n.figure].slides` for a nested list).
  2. The map recorded by the last ws_localize write of the same document and locale pair (source row id to target row
     id, in the receipts table, written in the same transaction; row ids only). It is bound to the database's row-key
     epoch (stream A, item 16b), so after an import into a fresh database it is not used.
  3. A component type with exactly one unrecorded row on each side pairs those two. A target row recorded for a source
     row that no longer exists is never paired this way: next to an unpaired source row of its type it is ambiguous.
  - Anything else is ambiguous (two hero rows in the target, none recorded): the plan lists it in `ambiguous_rows` with
    `source`, `target` and a `proposed` pairing (the old order-based guess), and a write is refused with
    `ambiguous_rows` until `row_map` names the pairs. The plan shows `current` text for paired rows, so the caller can
    pair by meaning.
  - A paired row keeps its id and its own per-locale values: translated text, media, enumerations and relations, also
    after the source was reordered or had rows inserted.
  - A source row with no pair is added from the source, with the source text, reported as untranslated.
  - A target row with no pair (only in the target, or its source row was removed) is **kept** where it was, after the
    target row it followed, unless `remove_extra_rows: true`. The plan lists each one in `target_only_rows`
    (`{field, key, component, reason: only_in_target | source_row_removed, action: keep | remove}`). rc.2 removed them.
  - The output follows the source order, with kept target rows in place.
- **Blocks nodes** match by index when their node structure is the same.
- **Text** not given in `translations` keeps the target's current text. A new row keeps the source text.
- **`copy_non_text: true`** also copies media, enumerations, numbers and relations from the source into matched rows.

### Refusals

| Situation | Error |
|---|---|
| The source changed after the plan | `version_conflict`, with `locale` set to the source locale and a `retry.hint` to re-plan. No source version (1.0 hardening): the plan returns the text and the version together. Re-plan, translate what changed, retry. |
| The target exists and `expected_version` is missing | `precondition_required`, without a version: re-plan and send its `target_version` (or send `force: true`) |
| The target changed since `expected_version` | `version_conflict` with the target's current values; `retry` carries a hint to re-plan, no version |
| Unknown path | `invalid`, with `unknown_paths` |
| `translations` without `expected_source_version` | `precondition_required` |
| The type is not localized, the locale is unknown, or the target is the source | `invalid` |
| The token cannot read the source, or cannot create or update the target or one of its fields | `forbidden` |

### Receipt

```json
{"ok": true, "documentId": "…", "locale": "fr", "source_locale": "en", "source_version": "…", "created": true,
 "previous_version": null, "version": "…", "changed": ["title", "seo", "items", "sections", "body", …],
 "translated": 15, "units": 15, "untranslated_count": 0, "rows": {"sections": {"matched": 0, "added": 4, "kept": 0, "removed": 0}},
 "unmapped_relations": [{"target": "api::topic.topic", "documentId": "…"}], "receipt_id": "r_…"}
```

- `untranslated` lists up to 50 paths whose value is still the source text. Those are units you did not translate,
  in new rows or in a new locale.
- `dry_run: true` returns the same receipt plus `diff`:
  - `{field: {before, after}}` for fields;
  - `{added, removed, changed: {key: {field: {before, after}}}, order}` for list rows.
  - For a new locale, every field is in `diff`.
- `return: "full"` adds the resulting document.

### Other locales

The write goes only to the target locale.

Measured (tests/test_l10n_history.py, all three databases): after a locale is created, the content hash of every
other locale is unchanged and so is its data.

When a new locale is created, Strapi's own i18n sync rewrites the non-localized fields of every sibling locale with
their unchanged values. This happens in `bootstrap.js`: `shouldSync = !originalData || …`. It moves the siblings'
`updatedAt`, so a version token read from en before fr was created gets a `version_conflict` after it. The refusal
is safe, but an agent has to re-read en. Updating an existing locale does not do this. REST and the admin panel create
locales the same way.

## History

With the module on, every successful ws_* write stores one receipt row in `writesafe_receipts`, in the same
transaction as the write. That includes `ws_patch`, `ws_publish`, `ws_batch`, `ws_localize`, `ws_undo`, and module
tools that report their writes (see Extension).

Each reply gets a `receipt_id`. On a scalar patch the receipt stays under 300 bytes. Dry runs store nothing. An
idempotent replay returns the same `receipt_id`.

The row holds:
- **Who**:
  - the admin token's id and name, looked up the way Strapi authenticates admin tokens. The token itself is never
    stored.
  - an optional agent label, from the `agent` argument (added to `ws_patch`, `ws_publish`, `ws_batch`, `ws_localize`
    and `ws_undo`) or the `X-Writesafe-Agent` header. It must be a slug (letters, digits, `.`, `_`, `-`, up to 80);
    other agents see it in ws_history, so a sentence is refused (argument) or ignored (header).
- **Hashes**: plain sha256 over the full draft (1.0 hardening; rc.2 used an HMAC under the version key over the token's
  view, so a key rotation or a token that cannot read every field made every undo conflict).
- **What**: per document and locale, the operation (`update`, `create`, `delete`, `publish`), the changed fields and
  the version before and after.
- **Before-image**: only what the write changed:
  - whole values for scalars, single components, blocks, media and relations;
  - for component lists (dynamic zones, repeatables), only the rows the write updated or removed, the row order, and
    hashes of the rows it added or updated (for the undo check).
- **Size caps** (1.0 hardening item 21):
  - per document: an entry whose before-image is over `maxBeforeBytes` (default 256 KB) loses it. ws_history marks that
    item `too_large_to_undo`; the other documents of the same receipt or bulk chunk keep theirs (rc.2 dropped the
    before-images of the whole receipt). A receipt is `too_large_to_undo` (undo refused with `unsupported`) only when
    none of its entries can be undone.
  - per job: the receipts of one job (ws_bulk, ws_replace, an undo job) share `maxJobBeforeBytes` (default 1 GiB). Once
    the job has stored that much, its later entries keep no before-image (marked like the above). A stats row per job
    (`undostat:<job id>`: bytes, entries, stripped, rows) holds the running total; it lives as long as the history.
  - the ws_bulk and ws_replace dry runs show the estimate: `undo: {per_document_bytes, job_budget_bytes, sampled,
    estimated_bytes, over_document_cap, undoable: true | "partial" | false, note}`.
- **Retention**: after `retentionDays` (default 30), history-only rows are deleted.
  - Rows that also hold an idempotency key lose their history; the key itself lives 72 hours (`retention.keyHours`, see
    [reference.md, Receipts table](reference.md#receipts-table)), after which the row is deleted (or becomes a plain history row while the history
    lasts). Stored replies keep no documents.
  - Expired receipts are not listed, and their undo is `not_found`.
  - Pruning runs every `pruneEverySeconds` and when `ws_history` is called. `retentionDays: 0` keeps everything.

### ws_history

Filters:
- `uid`, `documentId` (with `locale`), `receipt_id`, `tool`;
- `token` (a token id, or `"me"`), `agent`;
- `since`, `until` (ISO);
- `limit` (default 20, at most 100) and `cursor`.

Newest first.

```json
{"receipts": [{"receipt_id": "r_…", "at": "2026-11-13T16:31:59.027Z", "tool": "ws_patch", "token": "spike-agent-a",
  "token_id": "3", "agent": "writer-bot", "undoable": true,
  "items": [{"uid": "api::page.page", "documentId": "…", "locale": null, "op": "update", "fields": ["note", "items"],
             "rows": {"items": {"added": 0, "removed": 0, "updated": 1}}}]}],
 "next_cursor": "c1234"}
```

- `include_before: true` adds `before: {fields: {…}, rows: {field: {key: row}}}` to each item. Values pass through the
  calling token's read permissions: a field or sub-field the token cannot read is left out, never shown empty.
- Receipts on content types, or locales, the token cannot read are not listed. Before-images are sanitized with the
  entry's locale, so locale-scoped permissions apply.
- Undo marks are shown as `undo_of`, `undone_by` and `undone_items`.

This is lightweight history for agent writes. It has no approvals, review workflows or audit-log export (Strapi
Enterprise covers those).

## ws_undo

`{receipt_id, item?, documentId?, locale?, on_conflict?, force?, dry_run?, idempotency_key?, agent?}`, and for undo jobs
`{undo_job_id, status_only?, max_chunks?, chunk_size?, preview?}`

- **ws_patch receipts**:
  - Each changed field goes back to its before value.
  - In component lists only the receipt's rows are reverted. Rows it updated get their old content and keep their
    ids. Rows it removed are put back after the row they used to follow. Rows it added are removed. A move is
    reversed.
  - Rows other writers added since stay where they are, and so do other fields.
- **ws_batch receipts**: the whole batch, or one item by `item` (its `ref` or index). Items already undone one by one
  are skipped in a later whole undo.
- **ws_localize**: a created locale is deleted (only that locale). An update is reverted like a patch.
- **ws_undo receipts**: the undo is undone, which redoes the change. The original receipt becomes undoable again.
- **Job receipts** (ws_bulk, ws_replace, an undo job; see Extension): `receipt_id` may be a job id. The job is undone as
  an undo job (below), or one document of it with `documentId` (one transaction, reading only the job's receipts that
  touched that document).
- **ws_publish**: not undone. It is reported in `skipped` and stays published. To revert the draft, undo the patch
  that changed it.

**Conflicts.** An entry conflicts when any field or row it changed is different now. `on_conflict` decides (1.0 hardening
item 21):
- `"skip"` (default): that document is left as it is and listed in `conflicts`; every other entry is undone, and the
  receipt stays undoable for the skipped ones (the reverted entries are marked one by one). When nothing at all could
  be undone, the reply is the `version_conflict` below.
- `"stop"`: one conflict refuses the whole undo, nothing is undone (an undo job stops at it instead, see below).

Each conflict, and the refusal, carries:
- `changed_since`, e.g. `["note"]` or `["items[shared.item:4]"]`;
- the current values, filtered for the token, and `current_version`;
- `before`: what the receipt replaced in those fields (filtered for the token), so the agent can put back its own
  change with ws_patch and keep the later one;
- `retry: {hint}`. Since the 1.0 hardening it does not offer `force` (that erased the later change).
- A created document is compared by its content hash: if its later edits were undone, the create can be undone.

- A colleague's change to another field, or to another row of the same list, does not block the undo.
- If the receipt moved rows, a later reorder of that list blocks it (`<field>(order)`).
- Undoing a created locale or document is refused once it has been published, so the live page is not deleted.
- `force: true` overrides these checks and lists what it overwrote in `overwrote`. It exists only where the admin set
  `allowForce: true` (the default is false in `guard` and `hide`); otherwise it is not in the schema and is refused
  (`force_disabled`).
- `force` never overrides `already_undone`: re-applying an undone change would apply it twice.

`item` matches a batch item's `ref`. It is matched as an index only on a single receipt, because a job's chunks each
start at 0.

Other refusals:
- `already_undone`, with `undone_by`;
- `not_found`: unknown or expired receipt;
- `unsupported`: the before-image was too large;
- `forbidden`: the undoing token needs update permission on every field it reverts.

An undo of a single receipt runs in one transaction. Targets are locked in a fixed order. Entries on the same document
are reverted newest first. A recreate first locks every locale row of the document.

### Undo jobs (1.0 hardening item 21)

The undo of a job id, or of a single receipt with more than 100 entries (the ws_batch maximum; a single receipt under
`on_conflict: "stop"` always stays one transaction), is itself a resumable job (rc.2 ran it as one
transaction over up to 10,000 chunk receipts: every draft row locked, a client timeout at 1,000 documents, and one
conflict refused all of it):
- chunks of `chunk_size` entries (default the bulk chunk size, 25; at most `bulk.maxChunkSize`), each its own
  transaction: lock the undo job row, take the next entries from the job's cursor, lock their documents in one order,
  revert them, record the chunk, move the cursor. A chunk commits whole or not at all.
- backwards through the job: newest chunk receipt first, newest entry first, so a document written twice by the job
  goes back through its states in order. Entries undone before (one by one, or by an earlier undo) are skipped and
  counted (`already_undone`).
- a call runs chunks until the job is done or the bulk time budget (`bulk.timeBudgetMs`) is used, or `max_chunks`.
  `status: "running"` comes with `undo_job_id` and `next`; call `ws_undo {undo_job_id}` to continue. A process killed
  in the middle loses only the running chunk: the same `ws_undo {receipt_id}` call (or `{undo_job_id}`) resumes from
  the cursor (`resumed: true`), and no entry is reverted twice.
- `on_conflict: "skip"`: conflicts are left alone, counted and returned (this call's, with `before` and `current`);
  `status_only` lists every conflict of the job with its before values. `on_conflict: "stop"`: the job stops at the
  first conflict (`status: "stopped"`, error `job_stopped` with `conflict`, its `changed_since` and `before`); the
  documents before it in undo order stay reverted; `{undo_job_id}` retries from it. No reply offers `force`.
- an entry the token cannot read is skipped and only counted (`unreadable`), never named; entries without a
  before-image (`too_large`), publishes and imports (`not_undoable`) and expired ones are skipped and counted.
- a Strapi refusal of one entry (`failed`) is recorded and the job goes on (`skip`), or stops at it (`stop`).
- one running undo job per token, receipt and mode: a repeated call resumes it. Undo jobs belong to the token that
  started them. A finished undo job that found every entry undone already answers `already_undone`.
- its chunk receipts are grouped under the undo job id (`ws_history {receipt_id: <undo_job_id>}`), name what they undo
  (`undo_of`) and carry the `agent` label, so the undo job can itself be undone (as a job).
- a job that is not finished (a bulk job or an undo job whose status is not `done`) cannot be undone yet: `job_running`
  (it may still write chunks the undo would miss). Finish it first.
- `dry_run` previews a new undo (a `receipt_id`); with `undo_job_id` it is refused (`invalid`): use
  `{undo_job_id, status_only: true}` to read a job. `status_only` without `undo_job_id` is refused too. Neither writes.
- needs a per-token identity (the request's Authorization header) and the receipts table's unique index, like bulk
  jobs; without them the undo of a job or of a receipt over 100 entries is refused (`unsupported`, saying so). Undo
  single documents with `documentId` instead.
- `dry_run`: the plan without a write: `total` entries, before-image `bytes`, `not_undoable`, `budget`
  (`per_document_bytes`, `per_job_bytes`), `chunk_size`, `chunks` and a read-only `preview` of the first entries
  (`would`: restore, unchanged, conflict, delete, recreate, already_gone, too_large, not_undoable).

Reply of an undo job:

```json
{"ok": true, "undo_job_id": "u…", "undo_of": "j…", "status": "done", "on_conflict": "skip", "total": 1050, "processed": 1050,
 "remaining": 0, "totals": {"restored": 1047, "conflicts": 3, "already_undone": 0, "…": 0}, "chunks_done": 42,
 "items": [{"uid": "…", "documentId": "…", "op": "restored", "fields": ["summary"]}],
 "conflicts": [{"code": "version_conflict", "documentId": "…", "changed_since": ["summary"], "before": {"fields": {"summary": "s"}}, "current": {"…": "…"}}],
 "conflicts_hint": "…"}
```

Undo job state lives in the bulk job tables (`server/modules/history/undo-store.js` over `modules/_bulk/store.js`):
one `writesafe_bulk_jobs` row per undo job (tool `ws_undo`, action `undo`; state, counters, and the receipt cursor and
totals in `spec`) and one `writesafe_bulk_items` row per undone entry (its outcome, in undo order). The job's `slot` is
`undo|<scope>` while it is running, paused or stopped (one active undo job per caller, receipt and mode; two concurrent
starts become one job) and is released when it is done or cancelled. The job store's retention removes an idle job with
its items. A job that is not finished (running, paused, stopped) cannot be undone yet (`job_running`). Each entry an
undo writes carries `uo: [receipt id, entry index]`, the entry it reverted, so undoing that undo entry clears exactly
that mark.

Reply:

```json
{"ok": true, "undo_of": "r_…", "items": [{"uid": "…", "documentId": "…", "locale": null, "item": 0, "op": "restored",
 "fields": ["note", "items"], "version": "…"}], "receipt_id": "r_…"}
```

## Extension (for ws_create, ws_delete, ws_bulk and other modules)

A module tool gets history and undo for free if it:
- runs through `api.runWrite(ctx, tool, args, fn, extra)`;
- reports each write with `MOD.afterWrite(ctx, info, before, after)`. `info` is
  `{tool, action, uid, documentId, locale, args, dryRun}`, and `before`/`after` are normalized drafts (`model.normalize`).

| `info.action` | before | after | Undo |
|---|---|---|---|
| `patch` | draft | draft | reverts the changed fields and rows |
| `create` | `null` | draft | deletes the document or locale (refused if it changed since) |
| `delete` | draft | `null` | recreates it as a draft, under the same documentId |
| `publish` | draft | draft | none (history only) |

- `modules/_lib/write.js` has `writeFields`, `deleteLocale` and `recreate`, which do the permission checks and report
  the write.
- A job that writes in chunks calls `require('…/modules/history').annotate({ group: jobId })` inside each chunk's run.
  Its receipt ids then start with `jobId~`, and `ws_undo {receipt_id: jobId}` reverts the job.
- `tests/test_history_extension.js` plays ws_create, ws_delete and a two-chunk ws_bulk job through exactly this
  interface, including undo of the whole job and of one document in it.

## Shared-file hooks (marked `[l10n/history]`)

- `server/engine.js`: `runOnce` calls `MOD.aroundWrite(meta, fn)` around the write. `runWrite` passes `ctx` and
  `extra` to `runOnce`.
- `server/modules/index.js`: `aroundWrite` and `writeArgs` (module hooks).
- `server/tools.js`: `...MOD.writeArgs(z)` in the ws_patch, ws_publish and ws_batch schemas.
- `strapi-server.js`: the receipt schema gains `receiptId`, `tokenId`, `agent`, `targets` (text) and `history` (json).
- `app/config/plugins.js`: `history` options from the environment.

## Limits

- **Row pairing** uses recorded row ids. A target locale written by rc.2, by the admin or by a built-in tool has no
  recorded map, and neither has one after an import into a fresh database (a new row-key epoch), so the first update
  of a list where a component type repeats needs a `row_map` once. When source rows get new ids (Strapi's
  discard-draft, a whole-list replace without keys), a target row recorded for a vanished source row is never paired
  silently: next to an unpaired source row of its type it is ambiguous (send `row_map`), otherwise it is a target-only
  row.
- **Stale translations**: there is no per-unit digest yet. If the source text changes after a translation, the target
  keeps its translation. The plan shows both texts, but the receipt does not flag it.
- **Polymorphic relations** inside rows are not copied.
- **Recreate**: a recreated document or locale comes back as a draft. Its published version is not restored.
- **Undoing a ref op** (and any relation or media change) restores the whole field as it was before the receipt: a later
  link change to that field (by anyone) makes it a conflict, which the undo then leaves alone and lists.
- **Undo job items** list each entry compactly (ids and outcome, not content); `status_only` reads the before values
  from the receipts.
- **Concurrency on undo**: an undo runs under the same row locks as ws_patch. Undo and redo of one receipt race like
  any two writes. The second one is checked against the first one's result.
- **Before-images** are stored as written, including fields some readers cannot see. Only `ws_history` filters them,
  per token. Anyone with database access sees them, as they see the content itself.

## Tests

- `tests/test_l10n_history.py`: 133 checks, on SQLite, Postgres 16 and MySQL 8.4. Results are in
  `tests/results/test_l10n_history_{sqlite,postgres,mysql}.json`. With the modules off (`EXPECT_MODULES_OFF=1`, Strapi
  started with `WRITESAFE_MODULES=-history`: history is on by default since the 1.0 hardening, phase 4), 3 checks: no tools, no `agent` argument, no receipt. The existing `tests/test_plugin.py` (252 on v1-core 50d881d) also passes on all
  three databases with both modules on.
- `tests/test_history_extension.js`: 14 checks, in-process, on a copy of the SQLite database.
- Setup: `scripts/setup_l10n.mjs` adds the `fr` and `de` locales and the `agent-en-only` token (articles, en only). Run
  it before `scripts/setup_hardening.mjs`, which syncs agent-a/b's permissions so they cover the new locales.

## From the package README

The package README's sections on these modules, moved here unchanged (the README keeps a one-line summary per tool).

### `localize`: ws_localize

Without `translations` it returns a plan: every text unit of the source locale by a structural path (positions and
types, never row ids, since the 1.0 hardening: `title`, `seo.metaTitle`, `sections[0:blocks.hero].heading`,
`items[1:shared.item].label`, `body[0:paragraph].children[0].text`) with `source_version` and `target_version`. With `translations: {path: text}` and `expected_source_version` it
creates or updates the target locale from the source's structure: rows, order, component types, blocks structure, link
URLs and media are copied; relations to localized types are mapped to the target-locale document or reported in
`unmapped_relations`. Untranslated units are reported (they keep the source text). Updating an existing target needs
its `expected_version`; matched rows keep their ids. Other locales are never written. No language model is called.
The receipt's `source_version` is the source re-read inside the write's transaction; creating a locale makes Strapi
recreate the source's non-localized component rows, which no longer changes its (semantic) version, so the same
`source_version` works for the next locale (Phase 0 N13).

Updating an existing target pairs each source row with its own target row through an explicit row map, never by
position (phase 2 hardening): first the caller's `row_map` (`{"<list path>": {"<source row>": "<target row>" | null}}`,
rows as the plan shows them, by position in their own locale's list such as `0:blocks.hero`, or a ws_get row key;
`null` for a new row), then the map ws_localize recorded at its last write of the same document and locale pair (bound
to the row-key epoch, so not used after an import into a fresh database), then one unrecorded row of a component type
on each side. A list with several unrecorded rows
of one type is ambiguous: the plan lists it in `ambiguous_rows` (with an order-based `proposed` pairing to check against
both locales' text) and a write is refused with `ambiguous_rows` until `row_map` says which is which. The plan shows the
effective `row_map`. So a reorder or an insert in the source keeps the target's own media, enumerations, relations and
text on the right sections. Target rows with no source row (only in the target, or their source row was removed) are
kept where they are, unless `remove_extra_rows: true`; the plan lists them in `target_only_rows` with the reason and the
action, and `rows.<field>` counts `{matched, added, kept, removed}`. The map is stored in the receipts table (row ids
only) in the write's own transaction.
Without that version the call is `precondition_required`; a stale source or target is `version_conflict`. None of these
replies carries a version: the plan returns the text and versions together.

### `history`: ws_history and ws_undo (on by default)

On unless `modules: { history: false }` (1.0 hardening, phase 4: the reviews asked for history on by default, or its
opt-in made unmissable). What it costs: one receipt row per write, in the write's own transaction. A row op (no
version, no key) inserts it; a write with `expected_version` or an `idempotency_key` already claims a retry record, and
history fills that row (one SELECT and one UPDATE) instead of adding one. The token's id and name are looked up once per
token and cached. Rows are kept `retentionDays` (30) and pruned every `pruneEverySeconds`
(3600); before-images are capped at `maxBeforeBytes` (256 KB). Measured on the test app:

| Write (`ws_patch`, no idempotency key) | Receipt rows, history on | Bytes per write, history on: SQLite / Postgres 16 / MySQL 8.4 | Same, history off |
|---|---|---|---|
| `set` of one short text field (with `expected_version`) | 1 | 679 / 721 / 721 | 319 / 330 / 330 (the implicit retry record, kept 10 minutes) |
| `ops` add of one row (10-row list, no version) | 1 | 1,531 / 1,628 / 1,628 | 0 |
| `set` replacing a 5 KB text (with `expected_version`) | 1 | 3,738 / 3,780 / 3,780 | 322 / 333 / 333 (the implicit retry record) |

Bytes are the stored text of `key`, `receipt`, `targets` and `module_data` (the before-image), without row overhead or
indexes (`tests/test_phase4d.py`, Strapi 5.62.0). A versioned write's receipt is its implicit retry record (see
[Idempotency](reference.md#idempotency)): with history on it carries the history and becomes a plain history row when the retry
window ends; with history off it is deleted then. A receipt grows with the size of what the write replaced, up to
`maxBeforeBytes`. As a rough guide, 1,000 small writes a day kept 30 days is about 20 to 50 MB of receipts before
indexes; the prune deletes older rows. Latency (median, 40 writes, history on / off, one test machine): one-field set
SQLite 12.8 / 12.3 ms, Postgres 41.1 / 38.8 ms, MySQL 36.0 / 33.7 ms; row add 20.6 / 18.3, 58.9 / 56.2, 53.1 / 48.7 ms:
about 1 to 4 ms per write, the extra insert or update of the receipt row.

Every successful ws_* write stores one receipt in its own transaction: who (admin token, optional `agent` label from
the argument or the `X-Writesafe-Agent` header; a slug of letters, digits, `.`, `_` and `-`, since other agents see it),
what (documents, locales, changed fields and rows), when, and a
before-image of exactly the changed fields and rows (capped at `maxBeforeBytes` per document and `maxJobBeforeBytes`
per job; kept `retentionDays`). Every write
reply carries `receipt_id`. Media imports are recorded too (not undoable).

`ws_history` lists receipts newest first, filtered by document, locale, type, receipt or bulk job id, tool, token
(`me`), agent and time, with a cursor; `include_before` passes before-images through the caller's read permissions.
Read permission is checked per entry: a token limited by conditions (for example to its own entries) sees only the
receipts of entries it can read now; receipts of documents that no longer exist are left out for it.

Permission conditions (1.0 hardening): every read that feeds a permission check or the output sanitizer loads the
entry's `createdBy` and `updatedBy` (with their roles), so a token limited to its own entries, like Strapi's Author
role, can read, patch, publish, delete and undo its own entries through the ws_* tools and is refused on everyone
else's. Relations that a token's conditions name (for example a custom condition on `reviewer.name`) are loaded for the
same checks; the plugin reads the condition paths from the token's rules. Every populated relation selects only its id
plus the fields the conditions name (for the creator: id and role ids/codes), never a whole row: an admin user's
password hash, tokens and email are never loaded. The creator fields and
these relation fields are never part of the version or of a reply. ws_undo checks read permission per entry too: a
receipt that touched an entry the token cannot read is refused (`forbidden`) without naming it.

`ws_undo {receipt_id}` reverts what that receipt changed: fields go back to their before values; for lists only the
rows the write added, updated, removed or moved are reverted, so rows other writers added stay. A created document is
deleted, a deleted one recreated (as a draft, same documentId). `item` undoes one batch item, `documentId` one document,
and a bulk `job_id` the whole job. A document whose reverted fields or rows changed since is left alone and listed in
`conflicts` (`on_conflict: "skip"`, the default since the 1.0 hardening): `current`, `changed_since`, and `before`, the
values the receipt replaced (fields the token can read), so the agent can put back its own change with ws_patch and keep
the later one; the rest is undone. If nothing could be undone the reply is a `version_conflict`; `on_conflict: "stop"`
refuses the whole undo at one conflict. The undo of a job (or of a single receipt with more than 100 entries) runs as a resumable
undo job: chunks of 25 entries, each its own transaction, newest change first; `status: "running"` comes with an
`undo_job_id` to call again, a killed process resumes from the last committed chunk, and `dry_run` shows the plan and
the byte budget. The reply does not offer `force`; where the admin allows it (`allowForce`), `force: true` still overwrites the later change when a person asks
for that. The undo has its own receipt and
can itself be undone. Stored hashes are plain sha256 over the full draft (not an HMAC over the token's view), so a key
rotation or a token that cannot read every field no longer makes every undo conflict. A created document is compared by
its content, so a create whose later edits were undone can be undone too.

