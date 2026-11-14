'use strict';

/**
 * history module (config.modules.history = true): receipts with before-images for every ws_* write, ws_history and
 * ws_undo. Options in config.history: { retentionDays: 30, maxBeforeBytes: 262144 (per document), maxJobBeforeBytes:
 * 1073741824 (per job), pruneEverySeconds: 3600, undo: true }. With the module off nothing is recorded and neither tool is registered.
 *
 * Who wrote: the admin token (id and name, looked up the way Strapi authenticates it) and an optional agent label,
 * from the `agent` argument (added to ws_patch, ws_publish, ws_batch, ws_localize, ws_undo) or the
 * X-Writesafe-Agent header. This is lightweight history for agent writes: no approvals or review workflows.
 */
const C = require('./capture');
const U = require('./undo');
const UJ = require('./undo-job');
const M = require('../../model');
const R = require('../../reply');
const CFG = require('../../config');

const RECEIPT_UID = C.RECEIPT_UID;
const FILE_UID = 'plugin::upload.file';

function itemView(e) {
  const v = { uid: e.uid, documentId: e.documentId, locale: e.locale || null, op: e.op };
  if (e.ref !== undefined) v.ref = e.ref;
  if (e.t) v.too_large_to_undo = true; // item 21: the before-image cap is per document (and per job)
  if (e.op === 'update') {
    v.fields = [...Object.keys(e.f || {}), ...Object.keys(e.r || {})];
    const rows = {};
    for (const [f, img] of Object.entries(e.r || {})) {
      const before = new Set(img.o);
      const after = new Set(img.n);
      const r = {
        added: img.n.filter((k) => !before.has(k)).length,
        removed: img.o.filter((k) => !after.has(k)).length,
        updated: Object.keys(img.a || {}).filter((k) => before.has(k)).length,
      };
      if (img.m) r.moved = true;
      rows[f] = r;
    }
    if (Object.keys(rows).length) v.rows = rows;
  }
  return v;
}

async function listHistory(strapi, ctx, E, a) {
  await C.prune(strapi, false).catch((e) => strapi.log.warn(`[writesafe] history prune failed: ${e.message}`));
  await require('../../retention').maybePrune(strapi, false); // keys, jobs, claims (when due; never throws)
  const where = { receiptId: { $notNull: true } };
  // A job id (ws_bulk, ws_replace) names every chunk receipt of the job ("<job id>~r_...").
  if (a.receipt_id) where.$or = [{ receiptId: a.receipt_id }, { receiptId: { $startsWith: `${a.receipt_id}~` } }];
  if (a.tool) where.tool = a.tool;
  if (a.agent) where.agent = a.agent;
  if (a.token) where.tokenId = a.token === 'me' ? (await C.tokenOf(strapi, a._extra)).id : String(a.token);
  const and = [];
  if (a.uid) and.push({ targets: { $contains: `|${a.uid}~` } });
  if (a.documentId) and.push({ targets: { $contains: `~${a.documentId}~${a.locale !== undefined ? `${a.locale || ''}|` : ''}` } });
  if (a.since) and.push({ createdAt: { $gte: new Date(a.since) } });
  if (a.until) and.push({ createdAt: { $lte: new Date(a.until) } });
  if (C.opts().retentionDays) and.push({ createdAt: { $gte: new Date(Date.now() - C.opts().retentionDays * 86400000) } });
  if (a.cursor) and.push({ id: { $lt: Number(String(a.cursor).replace(/^c/, '')) } });
  if (and.length) where.$and = and;
  const limit = Math.min(Math.max(a.limit || 20, 1), 100);
  const pcs = new Map();
  // Media Library imports (ws_media_import) are listed only to tokens that may read THAT file: the permission's
  // conditions (e.g. "own files only") apply per file, as in the media module's own reads (second-agent review).
  let pmFiles;
  const fileSeen = new Map();
  const canReadFile = async (documentId) => {
    if (fileSeen.has(documentId)) return fileSeen.get(documentId);
    let okRead = false;
    try {
      if (pmFiles === undefined) pmFiles = strapi.service('admin::permission').createPermissionsManager({ ability: ctx.userAbility, action: 'plugin::upload.read', model: FILE_UID });
      if (pmFiles.isAllowed) {
        const q = await pmFiles.addPermissionsQueryTo({ filters: { documentId }, page: 1, pageSize: 1 });
        okRead = (await strapi.plugin('upload').service('upload').findPage(q)).results.length > 0;
      }
    } catch { okRead = false; }
    fileSeen.set(documentId, okRead);
    return okRead;
  };
  const pcFor = (uid) => { if (!pcs.has(uid)) pcs.set(uid, E.permissionChecker(strapi, ctx, uid)); return pcs.get(uid); };
  // Read permission per entry, not per type (1.0 hardening item 9; fourth review N19): for a type without i18n the
  // check ran without an entity, so permission conditions (e.g. "own entries only") were never applied and the token
  // saw ids, fields and labels of other entries. A token with conditions is checked against the current entry; an
  // entry that no longer exists is checked as {locale}, which passes locale conditions only, so for a token limited
  // to its own entries a deleted document's receipts are left out.
  const entrySeen = new Map();
  const canReadEntry = async (e) => {
    if (!E.writableUids(strapi).includes(e.uid)) return false;
    const pc = pcFor(e.uid);
    const bare = e.locale ? { locale: e.locale } : {};
    // no conditions on read: no entry needed (Strapi versions without requiresEntity always check the entry)
    if (typeof pc.requiresEntity?.read === 'function' && !pc.requiresEntity.read()) return !pc.cannot.read(bare);
    const k = `${e.uid}\u0000${e.documentId}\u0000${e.locale || ''}`;
    if (!entrySeen.has(k)) {
      // the current row with the creator fields conditions read (M.creatorPopulate; item 10a, Phase 0 N-A/N-B)
      const row = await strapi.db.query(e.uid).findOne({ where: { documentId: e.documentId, ...(e.locale ? { locale: e.locale } : {}) }, populate: M.permQueryPopulate(strapi, e.uid) });
      entrySeen.set(k, { ok: !pc.cannot.read(row || bare), row });
    }
    return entrySeen.get(k).ok;
  };
  // Before values are sanitized against the entry's creator too (conditional field permissions; item 10a).
  const creatorOf = (e) => {
    const hit = entrySeen.get(`${e.uid}\u0000${e.documentId}\u0000${e.locale || ''}`);
    return hit && hit.row ? Object.fromEntries(['createdBy', 'updatedBy'].filter((f) => hit.row[f]).map((f) => [f, hit.row[f]])) : {};
  };
  const out = [];
  let lastId = null;
  let exhausted = false;
  let brokeEarly = false;
  // Receipts on types the token cannot read are left out; keep reading pages until `limit` visible ones are found.
  for (let page = 0; page < 20 && out.length < limit && !exhausted; page += 1) {
    const rows = await strapi.db.query(RECEIPT_UID).findMany({
      where: lastId ? { ...where, $and: [...(where.$and || []), { id: { $lt: lastId } }] } : where,
      orderBy: { id: 'desc' }, limit: 50,
    });
    if (rows.length < 50) exhausted = true;
    for (const row of rows) {
      lastId = row.id;
      const h = C.histOf(row) || {};
      let es = [];
      for (const e of h.e || []) {
        if (e.uid === FILE_UID ? await canReadFile(e.documentId) : await canReadEntry(e)) es.push(e);
      }
      const total = (h.e || []).length;
      if (a.uid) es = es.filter((e) => e.uid === a.uid);
      if (a.documentId) es = es.filter((e) => e.documentId === a.documentId && (a.locale === undefined || (e.locale || null) === (a.locale || null)));
      if (!es.length) continue;
      const r = {
        receipt_id: row.receiptId, at: M.isoOf(row.createdAt), tool: row.tool,
        token: h.tn || row.tokenId, token_id: row.tokenId,
      };
      if (row.agent) r.agent = row.agent;
      if (h.undo_of) r.undo_of = h.undo_of;
      if (h.undone_by) r.undone_by = h.undone_by;
      if (h.undone_items) r.undone_items = h.undone_items;
      if (h.group) r.group = h.group;
      // undoable while some entry is neither undone, nor a publish/import, nor without its before-image (item 21)
      r.undoable = !h.t && !h.undone_by && es.some((e) => C.undoableEntry(e) && !(h.undone_items && h.undone_items[e.i] !== undefined));
      if (h.t) r.too_large_to_undo = true;
      r.items = [];
      for (const e of es) {
        const v = itemView(e);
        if (a.include_before && !h.t && !e.t) v.before = await C.visibleBefore(pcFor(e.uid), e, undefined, creatorOf(e));
        r.items.push(v);
      }
      if (es.length !== total) r.items_total = total;
      out.push(r);
      if (out.length >= limit) { brokeEarly = row !== rows[rows.length - 1]; break; }
    }
  }
  const more = Boolean(lastId) && (brokeEarly || !exhausted);
  const res = { receipts: out };
  if (more && lastId) res.next_cursor = `c${lastId}`;
  return res;
}

let S = null;
// A slug only (letters, digits, '.', '_', '-'; 1.0 hardening item 4): ws_history shows it to other agents.
const agentArg = (z) => ({ agent: z.string().max(80).regex(R.AGENT_RE).optional().describe('Optional label for who is writing, a slug such as "translator-bot" (letters, digits, ".", "_", "-"); shown by ws_history. The X-Writesafe-Agent header works too.') });

module.exports = {
  name: 'history',
  writeArgs: (z) => agentArg(z),
  hooks: {
    aroundWrite: (meta, next) => C.aroundWrite(meta, next),
    afterWrite: (ctx, info, before, after) => C.afterWrite(ctx, info, before, after),
  },
  tools(strapi, api) {
    S = strapi;
    const o = C.configure(strapi, CFG.get(strapi).history);
    C.startPruning(strapi);
    const { z, lenient: L } = api;
    const E = api.engine;
    const defs = [{
      name: 'ws_history',
      title: 'Write-safe: history of ws_* writes',
      description: 'List the receipts of writes made through the ws_* tools (newest first): who (token, agent label), what (document, '
        + 'locale, fields and rows changed), when, and whether it can be undone. Filter by document, content type, tool, token, agent or time. '
        + 'include_before adds the before values (only fields this token may read). Use a receipt_id with ws_undo. Read-only.',
      auth: api.policies('plugin::content-manager.explorer.read'),
      resolveInputSchema: () => z.object({
        uid: api.uidSchema().optional(),
        documentId: z.string().optional().describe('Only receipts that changed this document.'),
        locale: z.string().optional().describe('With documentId: only this locale.'),
        receipt_id: z.string().optional().describe('Only this receipt, or every chunk receipt of a bulk job (its job_id).'),
        tool: z.string().optional().describe('e.g. ws_patch, ws_batch, ws_localize, ws_undo.'),
        token: z.string().optional().describe('Token id from an earlier reply, or "me" for the token making this call.'),
        agent: z.string().optional().describe('Only receipts written with this agent label.'),
        since: z.string().optional().describe('ISO date-time.'),
        until: z.string().optional().describe('ISO date-time.'),
        limit: L.int(z.number().int().min(1).max(100)).optional().describe('Default 20.'),
        cursor: z.string().optional().describe('next_cursor from the previous page.'),
        include_before: L.bool(z.boolean()).optional().describe('Add the before-image of each change.'),
      }).strict(),
      resolveOutputSchema: () => z.object({}).passthrough(),
      createHandler: (s, context) => async ({ args, extra }) => {
        try { return api.ok(await listHistory(strapi, context, E, { ...args, _extra: extra })); } catch (e) { return api.fail(api.errorOf(e)); }
      },
    }];
    if (o.undo) {
      defs.push({
        name: 'ws_undo',
        title: 'Write-safe: undo one receipt',
        description: 'Revert exactly what one ws_* write changed (its receipt_id from the write reply or ws_history): the fields and rows it '
          + 'changed go back to their before values; other writers\' rows and fields are left alone. A document changed again since is left as it is '
          + 'and listed in `conflicts` with its before values (if nothing could be undone: version_conflict). Works for ws_patch, ws_batch (or one item by '
          + 'ref or index), ws_localize, ws_undo and jobs: a job_id (or a large receipt) runs as a resumable undo job; call again with {undo_job_id} while '
          + 'status is "running". The undo gets its own receipt_id. dry_run shows the plan.'
          + `${api.forceAllowed() ? ' force: true (allowed by the admin) reverts even what changed since, overwriting it: only when a person asks.' : ''}`,
        auth: api.policies('plugin::content-manager.explorer.update'),
        resolveInputSchema: () => api.strict({
          receipt_id: z.string().optional().describe('receipt_id from a write reply or ws_history (or a job id). Not needed with undo_job_id.'),
          item: z.union([z.string(), z.number()]).optional().describe('ws_batch receipts: undo only this item (its ref or index).'),
          documentId: z.string().optional().describe('Undo only what the receipt changed in this document.'),
          locale: z.string().optional().describe('With documentId: only that locale.'),
          ...api.forceArg('Revert even if the fields changed since (overwrites the later change).'), // config.allowForce only
          on_conflict: z.enum(['skip', 'stop']).optional().describe('skip (default): leave documents changed since alone and list them. stop: undo nothing (a job: stop) at the first.'),
          undo_job_id: z.string().optional().describe('Resume (or read, with status_only) an undo job this token started.'),
          status_only: L.bool(z.boolean()).optional().describe('With undo_job_id: state and conflicts, nothing run.'),
          max_chunks: L.int(z.number().int().min(1)).optional().describe('Undo jobs: at most this many chunks in this call.'),
          chunk_size: L.int(z.number().int().min(1)).optional().describe('Undo jobs: entries per transaction (default 25).'),
          preview: L.int(z.number().int().min(0).max(20)).optional().describe('Undo jobs, dry_run: entries to preview (default 5).'),
          dry_run: L.bool(z.boolean()).optional().describe('Show what would be reverted, then roll back (a job: its plan). Strapi lifecycle hooks and Document Service middlewares run during it (rolled back; no webhooks).'),
          idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request.'),
          ...agentArg(z),
        }),
        resolveOutputSchema: () => z.object({}).passthrough(),
        createHandler: (s, context) => async ({ args, extra }) => {
          try {
            if (!args.receipt_id && !args.undo_job_id) throw new E.WsError({ code: 'invalid', message: 'Give receipt_id (or undo_job_id to resume an undo job).' });
            // review H1: these never write. status_only reads an undo job; dry_run previews a NEW undo (a receipt_id).
            if (args.status_only && !args.undo_job_id) throw new E.WsError({ code: 'invalid', message: 'status_only reads an undo job: give undo_job_id (from an earlier ws_undo reply). Nothing was undone.' });
            if (args.dry_run && args.undo_job_id) throw new E.WsError({ code: 'invalid', message: 'dry_run previews a new undo of a receipt_id. To see an undo job, call ws_undo with {undo_job_id, status_only: true}. Nothing was undone.' });
            // review M6: a job still writing chunks cannot be undone yet (the undo would miss its later chunks)
            if (args.receipt_id && !args.undo_job_id && !args.dry_run) {
              const st = await UJ.sourceStatus(strapi, args.receipt_id);
              if (st) {
                throw new E.WsError({
                  code: 'job_running', receipt_id: args.receipt_id, job_status: st, retryable: false, requires_reread: false,
                  message: `Job ${args.receipt_id} is ${st}: it may still write chunks, which an undo started now would miss. Finish it first (resume it with its job_id until status is "done"), then undo it. Nothing was undone.`,
                });
              }
            }
            // item 21: a job, or a receipt with more than 100 entries, is undone as a resumable undo job (review M3)
            if ((await UJ.route(strapi, args)) === 'job') {
              const r = await UJ.handle(strapi, context, E, args, extra);
              return r.ok === false ? api.fail(r) : api.ok(r);
            }
            return api.ok(await api.runWrite(context, 'ws_undo', args, () => U.applyUndo(strapi, context, E, args), extra));
          } catch (e) { return api.fail(api.errorOf(e)); }
        },
      });
    }
    return defs;
  },
  // For other modules (ws_bulk, ws_create, ...): group a job's receipts, read options.
  annotate: C.annotate,
  // bulk chunks (item 22): drop the entries of a document rolled back to its savepoint
  entriesMark: C.entriesMark,
  entriesRewind: C.entriesRewind,
  recordWrite: (strapi, w) => C.recordWrite(strapi, w),
  options: C.opts,
  prune: (force) => C.prune(S, force),
};
