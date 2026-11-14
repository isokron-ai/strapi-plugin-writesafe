# Internals: design notes of the plugin source

Notes for contributors, kept here so the published package stays small. Each section is the design note of one
source file under `app/src/plugins/writesafe/`; the file itself keeps a one-paragraph summary that points here.

## server/modules/index.js

```text
Module registry: optional feature modules (bulk, l10n, media, ...) plug into the core without editing it.

A module is a folder `server/modules/<name>/index.js` exporting:

  {
    name: 'bulk',                                   // must equal the folder name; config.modules.<name> turns it on
    tools: (strapi, api) => [definition, ...],      // MCP tool definitions (same shape as tools.js uses for
                                                    // strapi.ai.mcp.registerTool); registered only when enabled
    hooks: {                                        // all optional; called for every ws_patch/ws_publish/ws_batch item
      beforeWrite: async (ctx, info) => {},         // inside the write transaction, after the version check and before
                                                    // the write; throw api.WsError({code, message}) to refuse
      afterWrite: async (ctx, info, before, after) => data,   // inside the transaction, after the write; `before` and
                                                    // `after` are the normalized drafts (relations as documentIds).
                                                    // A non-undefined return is put in receipt.modules[<name>]
    },
    ops: {                                          // extra row ops for ws_patch `ops` (e.g. copy)
      copy: {
        schema: { from: z.string().optional() },    // extra op properties (zod shape), merged into the op schema
        apply: (opCtx) => {},                       // see engine.applyRowOps: mutate opCtx.work, push keys to opCtx.summary
      },
    },
  }

ctx is the MCP handler context ({ userAbility, user }). info is
  { tool, action: 'patch' | 'publish', uid, documentId, locale, args, dryRun,
    data,               // patch: the sanitized payload about to be written (beforeWrite may inspect, not change it)
    sanitize(doc),      // the token's read view of a raw document (hidden fields removed)
    raw: { before, after } }  // the FULL normalized drafts, hidden fields included: for data a module keeps to itself
  afterWrite's `before`/`after` arguments are the token's view (hidden fields removed), because whatever afterWrite
  returns is shown to the caller in receipt.modules and replayed on idempotent retries. Never copy info.raw into the
  return value.
  Batches: hooks run per item (info.tool 'ws_batch'); their returns are in the reply's items[].modules (and so in a
  stored idempotent receipt).
  Module tools that write documents (ws_localize, ws_undo, ws_create, ws_delete, ws_bulk, ...) run through
  api.runWrite and report each write with MOD.afterWrite(ctx, { action: 'patch' | 'create' | 'delete' | 'publish',
  tool, uid, documentId, locale, args, dryRun }, before, after) (before null = created, after null = deleted), so the
  history module records them like the core's own writes.
opCtx is { strapi, uid, field, attr, kind, work, op, index, where, refs, summary, find(key) -> i,
  resolvePos(pos) -> i, newKey() -> 'new:n', checkComponentData(cuid, data), WsError }.
  `work` is the list being edited: entries { key, row, isNew }. A new row must be pushed with isNew: true and a
  key from newKey() (the receipt maps it to its final key). After all ops the core strips `id` from new rows, refuses
  an existing row that appears twice, and checks field permissions on every changed sub-field, so a copy op cannot
  share or leak a row.

`api` (second argument of tools) exposes the engine so module tools reuse its transaction, idempotency, version and
permission handling: see apiFor() below.

Optional module exports besides tools/hooks/ops:
  hooks.aroundWrite(meta, next)  wraps every write run (inside its transaction); must return await next() (possibly
                                 extended). meta = { strapi, ctx, extra, tool, args, key }. Used by history.
  writeArgs(z) -> zod shape      extra top-level arguments for ws_patch, ws_publish, ws_batch (e.g. history's `agent`)
  contentTypes                   { <singularName>: { schema } }, declared for every module folder, on or off

Receipts (plugin::writesafe.receipt, one schema for the core and every module; see strapi-server.js):
  key, requestHash, tool, receipt   the core's idempotency record (rows exist for writes with an idempotency_key)
  targets                          "|<uid>~<documentId>~<locale>|...|" of every document the write touched
  receiptId, tokenId, agent         filled by the history module, which adds a row ("h:<receiptId>" key) for every
                                   write without an idempotency key, in the write's own transaction
  moduleData                       modules' own records keyed by module name, e.g. moduleData.history
```

## server/model.js

```text
Schema helpers: deep populate, row keys, the semantic content hash and the version token.

Version token (1.0 hardening item 15): "v2.<mac>", where mac is a full-length HMAC-SHA256 (base64url, 43 characters)
over the token version, the content type uid, the documentId, the locale and the SEMANTIC content hash of the draft.
  - The semantic hash covers what an editor would call the content: scalars, single components, the type, order and
    nesting of every component row and dynamic-zone block, blocks (rich text) trees, relation documentIds and media
    references, at every depth. It leaves out component row ids at every depth, timestamps and authors.
  - So a write that only makes Strapi recreate component rows (the i18n sync of non-localized fields, a new locale,
    an import) keeps the version; a real change of a value, a row's type, the order or the nesting changes it.
  - updatedAt is not part of the token and not a matching condition (rc.2 compared it first).
  - The uid, documentId and locale are bound, so a version read from one locale (or document, or type) never matches
    another one with the same content.
Tokens of 1.0.0-rc.2 and the Phase 1 builds ("<updatedAt>~<hash12>") are refused with error.code version_format
(requires_reread): see engine.assertVersion and the plugin CHANGELOG for why they are not accepted any more.

Why an HMAC and not a plain hash (0.2): the version covers fields the token may not be allowed to read. With a plain
sha256, a token could rebuild the draft from what it can read, add a guess for a hidden field and compare hashes
(measured: a hidden `note` of "approved" was recovered from the version alone). The key is derived from the app's
own secret keys at register time (setVersionKey), so versions stay stable across restarts.
```

## server/epoch.js

```text
The database epoch of component row keys (1.0 hardening item 16b).

A random value, created once per database, mixed into every component row key (model.rowHandle). It lives in its own
table, `writesafe_row_epoch`, created with knex and NOT declared as a Strapi content type or model, because:
  - Strapi's data transfer (`strapi export`, `strapi import`, `strapi transfer`) carries every content type (plugin
    ones included: the receipts table travels with the content) and the core store (its `configuration` stage), but
    nothing else. So an import into a fresh database never brings the source's epoch: the fresh database creates its
    own at first start, and every key read from the source is refused (stale_row_key) instead of naming whatever row
    now has that id. An import into the same database leaves the table alone: keys stay valid where the row content
    is still the same (and fail where it is not).
  - Strapi's schema sync leaves tables it never created alone ("a user custom table that we should not touch",
    @strapi/database schema/diff), so the table survives restarts and upgrades.
A dump-and-restore of the whole database (pg_dump, mysqldump, a copied SQLite file) carries the table: the restored
database keeps its ids and sequences too, so its keys stay valid; the content MAC still refuses a key whose row
changed. An admin can force every key stale by deleting the row (or the table): the next check creates a new epoch.

Missing at runtime (table or row gone): the next check (at most every REFRESH_MS, 10 s, before a read or write that
hands out or takes keys) creates a new epoch, so old keys are refused. If the read works but the epoch cannot be
created again, a fresh random per-process epoch is used at once (fail closed). If the
read itself fails (a pool timeout, a dropped connection), the epoch last read from the database is kept for up to
TRANSIENT_GRACE_MS (60 s), then the plugin fails closed the same way until a read works again. At
bootstrap there is no epoch to keep: a failed first read starts on a per-process epoch.
Several replicas: each re-reads the epoch on its own schedule, so after a reset a replica can keep accepting old keys
for up to REFRESH_MS (10 s); after that every replica uses the new one.
```

## server/preview.js

```text
True previews for the ws_publish and ws_delete dry runs (1.0 hardening phase 2, item 10).

rc.2 answered a publish or delete dry run by calling Strapi's real documents().publish / delete inside the write
transaction and rolling it back. Phase 0 (test 1) showed that Strapi already holds webhooks and `entry.*` events until
the commit, so a rollback never fires them, but Document Service middlewares and database lifecycle subscribers run
inside the transaction: any plugin that does outside I/O from them (a search index, a cache purge, a CDN call) did it
on every dry run. The publish and delete dry runs now never call Strapi's publish or delete. They compute the answer:

  publish  the version check, the permission check and the live diff as before, plus Strapi's own publish validation
           (required fields, lengths, patterns, unique values among published entries, relations that must exist),
           run through strapi.entityValidator exactly as Strapi's publish runs it, without writing anything. A draft
           that the real publish would refuse is refused by the dry run with the same `invalid` error.
  delete   the version and permission checks for every locale, what would be deleted, and the `recreate` arguments.

Where the publish preview can differ from a real publish (none of them makes a write unsafe: a real publish still
validates):
  - a ws_batch or ws_bulk dry run publishing two documents with the same unique value passes; the real run refuses the
    second (earlier items are not really published in a preview, so the unique check cannot see them);
  - with api.documents.strictRelations, a required relation whose target has no published version passes here (the
    real publish maps relations to published targets first);
  - the first publish of a locale whose sibling is already published validates the draft's non-localized values,
    where Strapi validates the sibling's published ones.

Patch dry runs (ws_patch, ws_batch patch items, ws_localize, ws_undo, ws_create, ws_replace, bulk previews) still run the
real write and roll it back: the write is what produces the diff, row keys and Strapi's validation of the exact data.
So Document Service middlewares and lifecycle hooks DO run in those dry runs (their database work is rolled back;
webhooks and entry.* events are not sent). That is documented on every dry_run argument and in the README.
```

## server/retention.js

```text
Retention for the receipts table (1.0 hardening item 5). rc.2 only pruned history
rows: bulk jobs, their chunk rows, abandoned media claims and every idempotency row stayed for good, and a keyed row's
stored reply could hold a whole document (`return: "full"`, ws_delete's `recreate`), so deleted content stayed too.

Config: writesafe.config.retention, every key optional:
  keyHours (72)         an idempotency key answers retries for this long; then its row is deleted, or, when the
                        history module still keeps the write's history, turned into a plain history row ("h:<id>")
                        with the stored documents stripped. A retry after that is a new request.
  jobHours (72)         a bulk job (its row and item rows in writesafe_bulk_jobs / writesafe_bulk_items, and an
                        rc.2 job's receipt and chunk rows) idle this long is deleted, finished or not. Its writes keep
                        their own history receipts (ws_undo with the job id works while those last).
  longHorizonDays (30)  [stream G] a paused job, and an approved job already under way, are kept this long idle (not
                        jobHours), with their approval request and lease, unless an admin cancels them first.
  claimMinutes (60)     a claim that never got its reply (a media import whose process died) is deleted after this.
  implicitClaimMinutes (10)  the implicit retry record of a versioned write without idempotency_key (1.0 hardening
                        item 16d) answers identical retries for this long; then it is deleted (or turned into a plain
                        history row), so a deliberate re-run of the same request applies again.
                        0 keeps them as long as idempotency keys (keyHours).
  pruneEverySeconds (3600)  how often the prune runs (also once at startup); 0 runs it on every ws_history call and
                        at startup only (tests).
0 for keyHours or jobHours keeps those rows. History rows have their own retention (history.retentionDays).
```

## server/modules/_bulk/jobs.js

```text
ws_bulk: one patch or publish over every document that matches a filter, as a resumable job. ws_replace runs on the
same engine (registerAction).

Flow (1.0 hardening items 17-19, 22, 23):
 1. dry_run: match the filter (checked against the token's read permission and narrowed by its update or publish
    conditions), refuse more than the ceiling (bulk.maxDocuments, 5,000 by default, at most 100,000), preview a
    spread of the matches (first, ..., last: written for real and rolled back), and return a PLAN TOKEN
    (plan.js): a full-length HMAC over the token owner, uid, locale, canonical filter, action and spec hash, count,
    the hash of the matched id list (for publish: with each draft's version), `undoable` and an expiry (15 min).
    ws_bulk needs a filter (`filter_required`) unless allow_all: true. The dry run also says how many webhook/entry
    events the job will fire and whether it can be undone.
 2. Start: the same call without dry_run, with plan_token. The token must be valid for this exact request and token
    holder (plan_mismatch), unexpired (plan_expired), and the matches now must be exactly the planned set
    (plan_mismatch, reason "matches"). The job id is derived from the token, so sending the same start again (after
    a lost reply) resumes that job instead of starting another. One job per token and content type may be active
    (job_running). The id snapshot is written ONCE, as rows (store.js); the job row keeps a cursor and counters.
    Documents created or moved into the filter after the plan are never touched; the end report counts them
    (`reconcile.still_matching`, `late_matches`).
 3. Chunks: each chunk is ONE transaction: lock the job row, lock the chunk's documents before the first read, then
    per document: read it, check it still matches the filter, take its version at that moment (publish: the version
    the plan bound; a newer draft is a `conflict` for that document, never published), write with that version as
    the precondition. Each document runs in a savepoint (item 22): a failing one is rolled back alone and the rest
    of the chunk goes on (mode continue) or the job stops there (stop_on_error). Item outcomes and the job's cursor
    are written in the same transaction, so a chunk is fully done and recorded or not at all.
    The first chunk of a longer job is a canary: when any document in it fails or conflicts, or none changed, the
    job pauses (`paused_canary`) until the caller resumes (control: "resume") or cancels it (ws_job).
 4. A call runs chunks, with a short pause between them (bulk.paceMs), until the job is done or the time budget is
    used (bulk.timeBudgetMs, or max_chunks); {job_id} continues it. Only the token that started a job can see, resume or cancel it.
    Reading, listing, cancelling and undoing jobs is ws_job (job-tool.js).

runChunk(strapi, ctx, extra, jobId, owner) runs exactly one chunk of a stored job and returns its outcome: the hook
for an in-Strapi runner (a later stream). The job's whole state is in the two tables.
```

## server/modules/_bulk/plan.js

```text
The plan token of a bulk job (1.0 hardening item 17).

A dry run of ws_bulk or ws_replace ends with a plan token; a start must present it. The token is

  wsp1.<payload>.<mac>

payload  base64url of the JSON {e, n, h, u, r}: expiry (unix seconds), match count, the id-list hash (sha256 of the
         matched documentIds in job order, base64url; for a publish job each entry also carries the draft version the
         dry run read, so a newer draft never takes its place), `undoable` (1 or 0) and a random nonce (96 bits), so
         two dry runs of one request are two plans (two jobs). Nothing in it is secret: the server recomputes the
         rest at the start and compares.
mac      a full-length HMAC-SHA256 (base64url, 43 characters) under the plan key over
         "wsp1", the owner (the token identity: user id plus a hash of the bearer token), the content type uid, the
         locale, the canonical filter, the action, the spec hash (every argument that defines the job), the count,
         the id-list hash, undoable, the expiry and the nonce.

The plan key is derived from the app's APP_KEYS (a separate derivation from the version key), so a token cannot be
made or altered without them. Without app keys a random per-process key is used: tokens then die on a restart.

What a start checks, in order (jobs.js):
  1. the token is present and well formed            → plan_required
  2. the MAC over THIS request and THIS token holder  → plan_mismatch (reason "request": other arguments, another
                                                         token's plan, or an altered token)
  3. the job derived from the token exists           → resume it (a lost reply is recovered by the same start)
  4. the expiry                                      → plan_expired
  5. the matches now: count and id-list hash         → plan_mismatch (reason "matches": the set changed since the
                                                         dry run; nothing was written)
The job id is derived from the MAC: one plan starts at most one job.
```

## server/modules/_bulk/store.js

```text
The job store of ws_bulk and ws_replace (1.0 hardening item 18): two plugin tables, written once per job and then
per chunk, never as one growing JSON value.

  writesafe_bulk_jobs   one row per job: what it does (tool, type, locale, action, spec, filter with the token's
                        conditions), who owns it, its state, a cursor (the ordinal of the next document) and counters.
                        `slot` is "<owner>|<uid>" while the job is active (running, paused, stopped) and null once it
                        is done or cancelled: a unique index on it allows one active job per token and content type.
  writesafe_bulk_items  one row per document of the job, written once at the start (the id snapshot): its ordinal in
                        job order, its documentId, for a publish job the draft version the plan bound, then its outcome
                        (state, chunk number, reason or error).

rc.2 kept the whole id list inside the job's receipt row and rewrote that row after every chunk: O(N^2 / chunk) bytes
written per job (about 2.5 GB at 50,000 documents). Now a chunk writes its own item rows and one fixed-size job row.

The database enforces what the app relies on (Strapi's own `unique` is checked by the app only): unique indexes on
jobs.job_id and jobs.slot, a unique index on items (job_id, ordinal) and indexes on items (job_id, state) and jobs.owner.
They are created on first use; starts are refused (`unsupported`) while they cannot be.

A job state change is made only under the job row's lock (FOR UPDATE; SQLite serialises writers), in the same
transaction as the chunk's writes: a chunk is fully recorded or not at all.
```

## server/modules/_bulk/deps.js

```text
What the bulk engine (jobs.js) takes from the core and from Strapi, in one place (1.0 hardening, stream E).

Phase 3 was built while two Phase 2 streams were still open: stream A (the semantic version "v2.<mac>",
content-bound row keys, stale_row_key, the scalar precondition rule) and stream B (one ordered lock helper, the
Document Service lock, MySQL lock-before-read, a per-chunk time cap). jobs.js uses their interfaces only through
this file, so rebasing onto them changes this file and nothing else in the engine.

Assumed interfaces (as designed in the 1.0 hardening; what each falls back to without them):
 - versionOf(strapi, uid, raw): the version token of a raw draft. A: engine.versionOfRaw (same signature; the
   token becomes "v2.<mac>"). Bulk publish binds this per document in the snapshot (item 19) and compares tokens
   as opaque strings, so the format does not matter here.
 - lockDocuments(strapi, uid, documentIds): lock a chunk's documents before its first read. B: compat/db.js
   lockDocuments (every locale's draft row, one ordered statement per type, remembered per transaction); main:
   util.lockMany (the target locale's draft rows in id order). Either way it joins the running transaction.
 - isSqlite(strapi): B exports compat/db.isSqlite; main has only clientOf.
 - chunkTimeMs: B's bulk.chunkTimeMs (default 1000): a chunk takes no further document after this long. The same
   key and default live in util.DEFAULTS here, so B's setting keeps its meaning.
 - attemptRetryable(e): whether an item's error is a deadlock, lock timeout or stale snapshot (B: engine.retryDecision
   over the cause chain, the test runWrite itself applies). A per-item savepoint must not swallow such an error: the
   whole chunk is re-run by engine.runWrite instead.
 - itemErrorKind(code): which item errors are a "conflict" (the document changed under the plan) rather than a
   failure. A adds stale_row_key and version_format; both count as conflicts when they appear.
 - savepoint(strapi, fn): Strapi's db.savepoint (5.5x onward; it also drops the events a rolled-back item queued).
   null on Strapi versions without it: jobs.js then re-runs the chunk without the failing document (rc.2's way).
```

## server/modules/history/capture.js

```text
History capture: one receipt row per successful ws_* write, holding who wrote, what, when, and a compact
before-image of exactly the fields and rows the write changed.

How it plugs in (server/modules/index.js):
 - hooks.aroundWrite wraps every write run (engine.runOnce, inside its transaction). It opens a collector,
   runs the write, then stores the receipt row in the same transaction and adds `receipt_id` to the reply.
 - hooks.afterWrite is called by the engine (ws_patch, ws_publish, each ws_batch item) and by module writes
   (ws_localize, ws_undo, and any module that calls MOD.afterWrite, e.g. ws_create / ws_delete / ws_bulk) with the
   normalized draft before and after. It adds one entry to the collector. info.action:
     'patch' (before and after)   -> changed fields and rows, with their before values and after hashes
     'create' (before = null)     -> the created document/locale and its version (undo deletes it)
     'delete' (after = null)      -> the whole deleted draft (undo recreates it)
     'publish'                    -> recorded for history; not undoable

Entry format (history.e[]), version 1:
  { i, ref?, tool, uid, documentId, locale, op, vb?, va?,
    f: { <field>: { b: <before value>, a: <hash of after value> } },        whole-field images (scalars, single
                                                                             components, blocks, media, relations)
    r: { <field>: { o: [before keys], n: [after keys], b: {key: row}, a: {key: hash}, m: 0|1 } },
                                                                             row images of component lists: b holds
                                                                             the before content of rows the write
                                                                             updated or removed, a the after hash of
                                                                             rows it updated or added, m = reordered
    doc?: <whole before draft> (op delete) }
Size caps (item 21): an entry over maxBeforeBytes loses its before values (t: 1, tr: "document"); the receipts of one
job share maxJobBeforeBytes (stats row "undostat:<group>"), later entries get t: 1, tr: "job". The receipt is t: 1
only when no entry can be undone. An undo entry carries uo: [receipt id, entry index], the entry it reverted.
```

## server/modules/history/undo.js

```text
ws_undo: revert exactly what one receipt changed, using the before-image the history module stored with it.

- update entries: each changed field goes back to its before value; for component lists only the rows the write
  added, updated, removed or moved are reverted, so rows other writers added since stay. An entry whose fields or
  rows changed after the receipt is a conflict: on_conflict "skip" (default since 1.0 hardening item 21) leaves that
  document alone and lists it with its before values; on_conflict "stop" refuses the whole undo.
- create entries (ws_localize creating a locale; ws_create): the created document/locale is deleted, refused if it
  changed since.
- delete entries (an undo of a create; ws_delete): the deleted draft is recreated (as a draft, same documentId).
- publish entries: not undone (reported in `skipped`).
The undo is itself a write with a receipt, so it can be undone. A small undo runs in one transaction (here); the undo of
a job, or of a receipt with more than 100 entries (not under on_conflict "stop"), runs as a resumable undo job
(undo-job.js) in its own chunks.

Extension point for other modules: any tool that runs through api.runWrite and reports its writes with
MOD.afterWrite(ctx, {action: 'patch'|'create'|'delete', ...}, before, after) gets history and undo for free. A
multi-chunk job (ws_bulk) calls history.annotate({ group: jobId }) inside each chunk's run; ws_undo then accepts the
job id as receipt_id and reverts every chunk receipt of the job.
```

## server/modules/localize/build.js

```text
Build a target locale from a source locale's structure.

Text units are the translatable values of the source: string, text, richtext and uid fields, at any depth inside
components and dynamic zones, and the text leaves of blocks. Each has a STRUCTURAL path (1.0 hardening item 15):
positions and types, never database row ids, so a path stays the same when Strapi recreates the source's component
rows without changing them (the i18n sync on a new locale, an import), e.g.
  title                                         a top-level field
  seo.metaTitle                                 a field of a single component
  sections[0:blocks.hero].heading              a field of the first dynamic-zone row, a blocks.hero
  items[1:shared.item].label                    a field of the second row of a repeatable component
  groups[0:shared.group].entries[1:shared.meta].note   a row of a repeatable nested in a component row
  body[0:paragraph].children[0].text            a text leaf of the first blocks node, a paragraph
A path names a position of a given type: if the source moves, removes or retypes a row, its version changes and the
plan must be read again (expected_source_version).

Everything else is structure and is copied: row order, component types, numbers, enumerations, booleans, JSON,
media (ids) and relations (mapped: a relation to a localized type points to the related document's version in the
target locale when it exists, and is left out and reported otherwise; a relation to a type without i18n is kept).
Non-localized fields are never written (Strapi keeps them in sync across locales).

Updating an existing target locale: every source row is paired with a target row through an explicit row map
(1.0 hardening phase 2, item 12), never by position. A paired row keeps its id and
its own per-locale values (translated text, media, enumerations, relations). In order:
  1. row_map from the caller: {"<list path>": {"<source row ref>": "<target row ref>" | null}} (null: a new row);
  2. the map recorded by earlier ws_localize writes of this document and locale pair (links.js): source row id ->
     target row id, kept up to date after every write;
  3. a component type with exactly one unpaired, unrecorded row on each side pairs those two.
Anything else (two same-type rows on one side, one or more on the other) is ambiguous: the plan lists it with a
proposed pairing, and a write is refused (ambiguous_rows) until the caller sends a row_map. Source rows left unpaired
are added (copied from the source). Target rows left unpaired (only in the target, or their source row was removed)
are KEPT where they are, unless remove_extra_rows is set; the plan lists them either way. The output follows the
source order, with kept target rows after the target row they followed. Blocks nodes match by index when their
node structure is the same. copy_non_text: true copies non-text values from the source into paired rows too.

Row refs: the plan shows rows as structural positions "<index>:<component>" (as in unit paths such as
sections[0:blocks.hero]); row_map also takes a ws_get row key ("<component>:<id>:<mac>") or identity for a row.
```

## server/runner/runner.js

```text
The in-Strapi job runner (1.0 hardening, Phase 4 stream G). Off by default (config writesafe.runner.enabled).

It runs approved bulk jobs in the background, chunk by chunk, with the same engine the agent's own `ws_bulk
{job_id}` calls use (adapter.js). Caller-driven resume keeps working whether the runner is on or off.

Every chunk:
 1. the kill switch is read (an admin's "stop all jobs", or config): set, the worker takes no chunk;
 2. the lease is renewed (heartbeat); a worker that lost it stops;
 3. the permissions of the token that asked for the job are rebuilt from the token itself (never a superuser, never
    the approver's): a revoked or expired token, a deactivated owner, or any change to the token's rules on the
    job's content type pauses the job with `permission_changed`;
 4. the chunk runs with that token's ability, inside one transaction that first checks the lease is still held (the
    fence), so a worker that was taken over writes nothing;
 5. pacing: chunkPauseMs between chunks, so admin saves and other writers get the rows in between (the per-chunk
    time cap is the bulk engine's own, from stream B).
After a crash the lease expires (leaseMs) and any worker resumes from the job's last committed cursor.
```

## server/runner/lease.js

```text
Job leases for the in-Strapi runner (1.0 hardening, Phase 4 stream G).

One lease row per job the runner owns (table writesafe_job_leases). A worker may run chunks of a job only while it
holds the lease: leaseOwner = its worker id, leaseUntil in the future, and the fence it got when it acquired.
 - acquire: one conditional UPDATE (no owner, or the lease has expired) that also increments `fence`; the database
   decides which of several replicas wins.
 - renew (heartbeat): the same row, only while owner and fence still match. An expired lease nobody took over is
   still the worker's: the fence, not the clock, says who holds it.
 - check: called inside every chunk's transaction (after the job row is locked): owner and fence must still match,
   so a worker whose lease was taken over (a long GC pause, a frozen container) writes nothing: its chunk rolls back.
   The check is a locking read of the lease row (on MySQL a plain read there would fix the snapshot before the
   document rows are locked), so a heartbeat waits for the running chunk; since expiry alone never takes a lease
   away from its owner, a chunk longer than the heartbeat costs nothing but a delayed renew. Others can take the
   lease only after leaseMs without any renew, so a chunk must stay well under leaseMs: the runner does not start when
   leaseMs is below 3 x the chunk time cap (bulk.chunkTimeMs from stream B, taken as 1 s until then; control.js).
A crashed worker simply stops renewing; after leaseMs another worker (or the restarted process) acquires the lease
with a higher fence and resumes from the job's last committed cursor.

Times are epoch milliseconds from the worker's clock: replicas need synchronised clocks (NTP); leaseMs (60 s by
default) is the tolerance.

Store contract (SQL: ./store.js; memory: below):
  insert(row), get(jobId), list(where), candidates(now, limit) -> rows runnable now,
  tryAcquire(jobId, worker, now, until) -> row | null (not before nextAttemptAt), renew(jobId, worker, fence, until, now) -> bool,
  release(jobId, worker, fence, patch) -> bool, update(jobId, patch, expect) -> bool, assertHeld(jobId, worker, fence) -> bool
```

## server/runner/adapter.js

```text
The one place stream G (approvals, the runner, the admin page) touches the bulk job engine of stream E
(modules/_bulk: jobs.js, store.js, plan.js). Everything in server/approval and server/runner calls only these.

E's job: a row in writesafe_bulk_jobs (state, cursor, counters, slot, plan-bound idHash) and its id snapshot in
writesafe_bulk_items. A chunk commits its writes and the advanced cursor in ONE transaction that starts by locking
the job row (store.lockJob), so two callers never run the same chunk; jobs.runChunk(..., guard) calls guard(job)
inside that transaction, after the lock. B's per-chunk time cap (bulk.chunkTimeMs) applies inside.

States: E's running, paused (canary, the config kill switch, or stream G's admin_job / permission_changed /
runner_errors), stopped, done, cancelled; stream G adds awaiting_approval (holds the slot), rejected and expired
(terminal, slot freed). The G view of a job (toG) is what the approval code reads.

Stream F's undo jobs live in the same tables (tool ws_undo, slot undo|<scope>). They are not approval-tier bulk jobs:
never gated (they start in ws_undo, not in jobs.handle), never run by the runner (it only takes jobs with a lease),
not stopped by the kill switches (those stop forward bulk changes, so an undo can repair them), and the admin job API
only lists them: their control stays with the agent (isUndo).
```
