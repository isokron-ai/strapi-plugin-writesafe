# writesafe: locking and the Document Service lock

Reference for operators. The plugin README has a pointer here; the summary is in [`reference.md`](reference.md#concurrency).

## The lock every writer takes

A write locks every locale's draft row of each document it touches: one
`SELECT … WHERE documentId = ? [AND published_at IS NULL] ORDER BY id FOR UPDATE` per document, types by uid,
documents by documentId (`server/compat/db.js` `lockDocuments`). The statement runs again until two runs return the
same rows: a writer that deletes and recreates the draft rows while we wait (`discardDraft`) would otherwise leave the
waiting statement with none or some of them (Postgres READ COMMITTED skips deleted rows and cannot see new ones). A
document whose lock found no row is not remembered as locked. ws_patch, ws_publish, ws_batch, ws_delete and
ws_localize take the lock as the transaction's first statement, so MySQL's REPEATABLE READ snapshot is never older
than the lock. SQLite serialises writers and takes no row lock.

## The Document Service lock (`documentServiceLock`, default on)

Strapi writes a document's component rows before its main row; writesafe locks the main row first. Without a common
order an admin Save and an agent's write on one page deadlock (Phase 0: 143/200 rounds on Postgres, 118/200 on
MySQL). A Document Service middleware, registered first in writesafe's `register()`, takes the same lock before
Strapi's `update`, `delete`, `publish`, `unpublish` and `discardDraft` on the types writesafe covers (`api::`
collection and single types), from every caller: the admin panel, REST, GraphQL, other plugins, Strapi's built-in MCP
tools. Plugin and admin types keep Strapi's behaviour. `false` registers nothing; SQLite: no effect. The long-term fix
is the same lock inside Strapi's `updateEntry`.

### Where the one order does not hold

Writers queue in one order when each writes one document per transaction, or locks its documents through writesafe.
These do not, and can still deadlock with each other (as they could before):

- **Content Manager bulk publish / unpublish** (`publishMany`): one transaction, documents in request order.
- **Content Releases** runs: a release publishes and unpublishes many documents in one transaction, in its own order.
- **App lifecycles or middlewares that update other documents** while one is being written: the second document is
  locked after the first, in an order writesafe does not control.

### Custom order (Strapi 5.62+, future flag `unstableCustomOrder`)

Custom order keeps a position on every row of a document. Its `move()` takes the type's order lock (a `FOR UPDATE` on
the type's list-view settings row) and then rewrites the positions of many documents' rows; a write that creates a row
(a new locale) gets its position under the same lock after the row exists. Under the document lock that order is
reversed, so writesafe takes the order lock first whenever a write may create a row of an ordered type: the middleware
for an `update` whose locale row does not exist yet, ws_localize and ws_create on an ordered type, and ws_undo before it
recreates a deleted document or locale. Other updates of an ordered type take no order lock.

### What runs inside the lock's transaction

The middleware opens the transaction (or joins the caller's) before Strapi's own, so everything registered after it
runs inside it, with the document locked:

- i18n's copy of non-localized fields, Content Manager history, custom order, review workflows, releases, upload URL
  signing, and any app middleware registered in a `bootstrap()`. Their failures now roll the write back.
- **Review workflows' stage webhook** (`review-workflows.updateEntryStage`) is emitted by its middleware directly, so
  it now fires before the write commits, and once per writesafe retry of a write that moves the stage.
- **Fire-and-forget work** started by a later middleware joins the open transaction until it commits, through
  Strapi's transaction context: AI localizations (`generateDocumentLocalizations`, not awaited) and custom order's
  stale-settings refresh with its heal of missing positions. writesafe checks custom order's settings before it opens a
  transaction, so the refresh starts outside it; AI localizations cannot be detached from outside Strapi (upstream ask:
  run background work outside the caller's transaction context).
- On Postgres, when the middleware opened the transaction, it runs `SELECT 1` after the write: a transaction aborted
  by an error someone swallowed fails there, instead of committing as a silent rollback behind an HTTP 200.

### Waits and timeouts

An admin Save that meets an agent's write waits for its commit. Postgres has no lock timeout by default; MySQL gives
up after `innodb_lock_wait_timeout` (50 s). A ws_bulk or ws_replace chunk (25 documents by default) checks
`bulk.chunkTimeMs` (default 1000) between documents and takes no further one once it has run that long, so a Save
behind it waits about that long plus one document's write. The cap applies between documents: one slow document, or a
chunk that itself waits for a lock, goes past it. A ws_batch holds all its documents until it commits.

### The stale-form 400

A form loaded before the agent replaced rows (a list `set`, or Strapi's i18n copy recreating another locale's
non-localized rows) holds ids of rows that no longer exist. Strapi refuses its Save with HTTP 400 "Some of the provided
components in … are not related to the entity" (about half the rounds of those stress arms) instead of the deadlock
500 it got before. The editor reloads and saves again.

### Retries

A write is run again when its final error is a deadlock, serialization failure, lock wait timeout or busy database
(MySQL 1213/1205, Postgres 40P01/40001/55P03, `SQLITE_BUSY`), or writesafe's own stale-read signal; also, on MySQL,
when Strapi hid a deadlock behind the SQL error of its failed restore. Up to 8 attempts with exponential backoff and
jitter (25 ms doubling to 800 ms), lock wait timeouts at most twice, and at most 25 s per tool call. Then `busy`:
nothing was written.

## Stale admin forms (`staleFormGuard`, default on)

The Content Manager's Save sends the whole form and nothing about when it was loaded. Before this guard, a writesafe
write that committed between the form's load and its Save was replaced by the form's old values, and the Save
answered 200 (bench task X4). With the Document Service lock this happened every time the agent's write took the lock
first: the Save waited for it, then wrote its stale components over it.

**What it covers.** Writes through the Document Service (`strapi.documents()`) of `api::` types, under the document's
lock:

| Writer | Journaled as | An older admin form then |
|---|---|---|
| writesafe tools (ws_patch, ws_batch, bulk, replace, localize, undo) | every changed leaf, before and after | is merged, or 409 on a real conflict |
| writesafe delete (a locale or the document) and discard | opaque | 409 `other_writer` |
| an editor's discard in the admin | opaque | 409 `other_writer` |
| an editor's Save in the admin | nothing (editor against editor: last Save wins, as in Strapi) | saves |
| REST, GraphQL, other plugins, review workflows, Content History restore (updates, discards, deletes) | opaque (default); nothing with `staleFormGuard: { otherWriters: false }` | 409 `other_writer` (default), or saves (Strapi's last-write-wins) |

**Replays (D1).** Version tokens (`v3.`) bind each draft's content revision, so a token never comes back after
A → B → A. A request without a version (`if_match` only) or a publish whose draft did not change can still be identical
to an earlier one; the implicit retry record then answers it only while that write is still in effect, and otherwise
refuses with `replay_superseded` (resend with an `idempotency_key` to apply it again).

**MySQL and concurrent discards.** Every form write (Save, publish, discard) inserts the document's counter row when it
is missing (insert-ignore after a plain existence read) and only then locks it, so it never takes a locking read of a
missing row: two discards of documents without a counter row (a tab opened before the deploy, a client without the
header) do not deadlock on MySQL gap locks (`t_concurrent_discards_fresh`: 20 pairs, 40 discards).

**What it does not cover.** Writes that bypass the Document Service: `strapi.db.query()` and raw knex (custom code,
and Strapi's own i18n copy of non-localized fields after a non-agent write), component rows written outside a
document update, and, with `otherWriters: false`, writers outside the plugin. A stale form still overwrites those, as
before. Agent writes made while the guard was off, or on a node without it during a rolling deploy, are not
journaled, and such a node does not move content revisions either. The guard's tables (`writesafe_doc_rev`,
`writesafe_journal`, `writesafe_content_rev`) are not pruned except for the journal, and are outside
`strapi export`/`import` (after an import content revisions restart at 0). A user who may publish but not update
publishes the current draft through a route that never calls the update, so the guard does not run there (nothing is
lost; agent changes in the draft are published unseen).

**Behaviour change (the default).** A write by REST, GraphQL, another plugin, review workflows (a stage or assignee
change) or Content History restore makes every admin form of that entry loaded before it refuse its Save with 409
`other_writer`; Strapi answered 200 (last write wins). The panel "Your unsaved edits" keeps the editor's values.
`staleFormGuard: { otherWriters: false }` restores last-write-wins for those writers. Clients of the Content Manager
routes that send no `X-Writesafe-Base` (scripts with an admin token, an old admin bundle, a cross-origin admin without
the CORS settings) get 409 `missing_base` on every entry that has ever had a journal entry (agent write, other writer,
discard), permanently.

How a Save is tied to its load and merged (`server/compat/stale-form.js`, `server/rebase.js`, `admin/form-base.mjs`):

- **One revision counter per document** (table `writesafe_doc_rev`), not per locale (i18n copies non-localized fields
  with `strapi.db.query()`, past the Document Service). Every read of it, and of the journal, inside a write is a
  locking read; a header-less Save is decided from the locked row, never from a count (MySQL's REPEATABLE READ snapshot
  can predate the lock). The row is inserted before it is locked, so two writers of fresh documents take no gap locks.
- **The journal** (table `writesafe_journal`): each writesafe write records, in its own transaction before the commit,
  every leaf it changed (path, locale or `*` for a non-localized field, value before and after). Component rows are
  matched by id; a change of a list's rows (added, removed, reordered) is one entry. A dry run or a failed write rolls
  its entries back. Private and password fields are recorded as keyed hashes (HMAC with the app's keys), never values.
  Entries older than `retention.journalHours` (72) are pruned; the counter remembers the newest pruned revision, and a
  form older than that gets 409 `base_too_old` (a form left open three days reloads instead of merging).
- **Version out, version back.** The edit view's load answers `X-Writesafe-Version`, read before the document. The
  plugin's admin code wraps `window.fetch` and keeps the version per tab and per entry and locale (the load whose
  request started last, or the answer of a Save that was not merged: a late answer of an earlier request never moves
  it, and a merged Save's answer leaves it for the refetch that shows the merged entry), and sends it as
  `X-Writesafe-Base` on Save, publish and discard. Two tabs keep their own bases. This relies on Strapi internals (the
  Content Manager's URLs and the admin's global `fetch`); `test/form-base.test.js` pins them to the installed Strapi.
  An admin panel on another origin needs `strapi::cors` to allow `X-Writesafe-Base` and expose `X-Writesafe-Version`
  and `X-Writesafe-Merged`; the plugin warns at start when `admin.url` is on another origin.
- **The rebase**, in the Document Service middleware under the document's lock (so it also covers publish, whose route
  calls its own update): for every leaf an agent changed since the base, a value the editor left as loaded takes the
  agent's value; a value only she changed stays hers; both changed it to different values is a conflict. Rows are
  matched by id; a list whose rows changed on both sides is a conflict; a row one side removed while the other changed
  anything in it (fields, media, relations, nested components) is a conflict. Decimals compare as exact strings.
- **409** (`ConflictError`, `details.code: "stale_form"`, `details.reason`): `conflict` (the message names the field
  and both values, for fields the editor may read; others show `(hidden)`; component rows are named by field and
  position, "items row 2 qty", never by a value, also in the journal and the merge note), `publish_unseen` and `discard_unseen`
  (never publish or discard agent changes the editor has not seen), `other_writer`, `missing_base` (no header while
  the entry has journal entries: fail closed), `bad_base`, `base_too_old`. Nothing is saved.
- **Unchanged:** a Save with no journal entry since its load goes through as before.

What the editor sees (Strapi 5.62, headless Chrome): after a merge, Strapi's "Saved document" and a note "Kept 1 change
made by an agent: Coffee qty 4 → 12"; the form shows the merged entry. On a 409, Strapi shows the message as an error
notification, then refetches the entry and resets the form to it; the plugin's panel "Your unsaved edits" keeps every
field the editor had changed, with copy buttons, until she closes it.

Also not covered: Strapi re-creates a localized entry's non-localized component rows in the other locales after any
write (new row ids), so a stale form of another locale is refused by Strapi itself (400) when it carries such a
component. Merging list order or membership changed on both sides is left for later.

## Not covered

Raw knex and `strapi.db.query` writes; `create` and `clone` (a new document has no row to lock).
