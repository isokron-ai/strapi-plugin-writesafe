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

## Not covered

Raw knex and `strapi.db.query` writes; `create` and `clone` (a new document has no row to lock).
