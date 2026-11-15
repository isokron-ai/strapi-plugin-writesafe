'use strict';

// ws_job: list, status, cancel and undo the calling token's own ws_bulk, ws_replace and undo jobs (others: not_found).
const { z } = require('@strapi/utils');
const E = require('../../engine');
const U = require('./util');
const S = require('./store');
const J = require('./jobs');

const { WsError } = E;
// required when called: the history module may be off
const UJ = () => require('../history/undo-job');
const UJS = () => require('../history/undo-store');

const TOOLS = ['ws_bulk', 'ws_replace', 'ws_undo'];
const ACTIONS = ['list', 'status', 'cancel', 'undo'];
// each action's own arguments; any other is invalid
const ARGS = {
  list: ['limit', 'cursor'],
  status: ['job_id', 'items', 'cursor'],
  cancel: ['job_id'],
  undo: ['job_id', 'on_conflict', 'chunk_size', 'max_chunks', 'dry_run', 'preview', 'agent'],
};
const LIST_DEFAULT = 20;
const LIST_MAX = 100;

const invalid = (message, extra = {}) => new WsError({ code: 'invalid', message, ...extra });
const notFound = (id) => new WsError({ code: 'not_found', job_id: id, message: `No job ${id} for this token. ws_job {action: "list"} lists your jobs.` });

async function own(strapi, owner, a) {
  if (typeof a.job_id !== 'string' || !a.job_id) throw invalid(`action "${a.action || 'status'}" needs job_id.`);
  const job = await S.findJob(strapi, a.job_id);
  if (!job || job.owner !== owner || !TOOLS.includes(job.tool)) throw notFound(a.job_id);
  return job;
}

const iso = (d) => (d == null ? null : new Date(d).toISOString());

// one job in the list: no content (spec, filter)
function listItem(row) {
  const job = S.rowToJob(row);
  const undo = job.tool === 'ws_undo';
  const sp = job.spec || {};
  const out = {
    job_id: job.jobId, tool: job.tool, action: job.action, uid: job.contentType || null, locale: job.targetLocale || null,
    status: job.state, total: job.total, processed: job.cursor,
    totals: undo ? Object.fromEntries(UJ().TOTALS.map((k) => [k, (sp.totals || {})[k] || 0])) : J.totalsOf(job),
    created_at: iso(row.createdAt), updated_at: iso(row.updatedAt),
  };
  if (undo) out.undo_of = sp.receipt_id || null;
  else out.undoable = job.undoable;
  if (job.agent) out.agent = job.agent;
  return out;
}

async function list(strapi, owner, a = {}) {
  const limit = a.limit ?? LIST_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw invalid(`limit must be an integer from 1 to ${LIST_MAX}.`);
  const where = { owner, tool: { $in: TOOLS } };
  if (a.cursor !== undefined) {
    if (typeof a.cursor !== 'string' || !/^\d+$/.test(a.cursor) || !Number.isSafeInteger(Number(a.cursor))) {
      throw invalid('cursor must be a next_cursor from ws_job list.');
    }
    where.id = { $lt: Number(a.cursor) };
  }
  const rows = await strapi.db.query(S.JOB_UID).findMany({ where, orderBy: { id: 'desc' }, limit: limit + 1 });
  const shown = rows.slice(0, limit);
  const out = { ok: true, jobs: shown.map(listItem) };
  if (rows.length > limit) {
    out.next_cursor = String(shown[shown.length - 1].id);
    out.next_hint = 'More: call list again with this cursor.';
  }
  return out;
}

async function status(strapi, ctx, extra, owner, a) {
  const job = await own(strapi, owner, a);
  if (job.tool === 'ws_undo') {
    if (a.items !== undefined || a.cursor !== undefined) throw invalid('items and cursor are for ws_bulk and ws_replace jobs.');
    return { job_id: job.jobId, tool: 'ws_undo', ...(await UJ().statusView(strapi, ctx, E, UJS().fromRow(job))) };
  }
  return J.statusView(strapi, job, a);
}

async function cancel(strapi, ctx, extra, owner, a) {
  const job = await own(strapi, owner, a);
  if (job.tool === 'ws_undo') {
    return { job_id: job.jobId, tool: 'ws_undo', ...(await UJ().cancel(strapi, ctx, E, extra, job.jobId, owner)) };
  }
  const r = await J.cancelJob(strapi, ctx, extra, job);
  const v = await J.view(strapi, r.job, []);
  return { ...v, cancelled: r.cancelled, ...(r.cancelled ? {} : { note: `Nothing to cancel: the job is ${r.job.state}.` }) };
}

const NEXT_UNDO = 'Not finished. Call ws_job {action: "undo"} again with this job_id to continue.';

function historyOn() {
  if (!E.MOD.enabled().includes('history')) return false;
  const o = require('../history/capture').opts();
  return !o || o.undo !== false;
}

// undo: start the undo job of a job (ws_undo's code), or continue an active undo job
async function undo(strapi, ctx, extra, owner, a) {
  if (!historyOn()) {
    throw new WsError({ code: 'unsupported', message: 'Undo needs the history module with undo on. Nothing was undone.' });
  }
  const job = await own(strapi, owner, a);
  const pass = Object.fromEntries(['on_conflict', 'chunk_size', 'max_chunks', 'dry_run', 'preview', 'agent'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  let r;
  if (job.tool === 'ws_undo' && S.ACTIVE.includes(job.state)) {
    const fixed = ['on_conflict', 'chunk_size', 'dry_run', 'preview'].filter((k) => a[k] !== undefined);
    if (fixed.length) throw invalid(`${fixed.join(', ')}: an unfinished undo job continues as started (only max_chunks and agent apply). Nothing was undone.`);
    r = await UJ().handle(strapi, ctx, E, { undo_job_id: job.jobId, ...(a.max_chunks ? { max_chunks: a.max_chunks } : {}), ...(a.agent ? { agent: a.agent } : {}) }, extra);
  } else {
    if (job.tool !== 'ws_undo') {
      if (job.action === 'publish' || !job.undoable) {
        throw new WsError({ code: 'unsupported', job_id: job.jobId, message: `${job.action === 'publish' ? 'A publish job' : 'A job run with history off'} is not undone. Nothing was undone.` });
      }
      // an unfinished job may still write chunks the undo would miss
      const st = await UJ().sourceStatus(strapi, job.jobId);
      if (st) {
        throw new WsError({
          code: 'job_running', job_id: job.jobId, job_status: st, retryable: false, requires_reread: false,
          message: `Job ${job.jobId} is ${st}: finish it (${job.tool} {job_id}) or cancel it (ws_job), then undo it. Nothing was undone.`,
        });
      }
    }
    // a finished job, or a finished undo job (undoing it puts back what it reverted)
    try {
      r = await UJ().handle(strapi, ctx, E, { receipt_id: job.jobId, ...pass }, extra);
    } catch (e) {
      if (e && e.payload && e.payload.code === 'not_found' && e.payload.receipt_id === job.jobId) {
        throw new WsError({ code: 'not_found', job_id: job.jobId, message: `Job ${job.jobId} has no receipts to undo (none written, or expired).` });
      }
      throw e;
    }
  }
  if (r && r.undo_job_id) r = { job_id: r.undo_job_id, tool: 'ws_undo', ...r };
  if (r && r.next) r.next = { hint: NEXT_UNDO, job_id: r.undo_job_id, undo_job_id: r.undo_job_id };
  return r;
}

const RUN = { list: (strapi, ctx, extra, owner, a) => list(strapi, owner, a), status, cancel, undo };

async function dispatch(strapi, ctx, extra, owner, a) {
  if (!ACTIONS.includes(a.action)) throw invalid(`action must be one of ${ACTIONS.join(', ')}.`);
  const other = Object.keys(a).filter((k) => k !== 'action' && a[k] !== undefined && !ARGS[a.action].includes(k));
  if (other.length) {
    throw invalid(`action "${a.action}" takes ${ARGS[a.action].join(', ')}; not ${other.join(', ')}.`);
  }
  return RUN[a.action](strapi, ctx, extra, owner, a);
}

function toolDef(strapi, h, cfg) { // eslint-disable-line no-unused-vars
  const L = h.lenient || { bool: (x) => x, int: (x) => x, obj: (x) => x, arr: (x) => x };
  return {
    name: 'ws_job',
    title: 'Write-safe: list, read, cancel or undo your jobs',
    description: 'Your ws_bulk, ws_replace and undo jobs. "list": newest first. "status" {job_id}: state, totals and documents page by page (an undo job: its conflicts). '
      + '"cancel" {job_id}: stops an active job (also awaiting approval) after its current chunk; what it wrote stays. '
      + '"undo" {job_id}: reverts a finished job as a resumable undo job (dry_run first); documents changed since are skipped and listed, or stop it (on_conflict "stop"). '
      + 'To continue a ws_bulk or ws_replace job, call that tool with {job_id}.',
    auth: h.policies(strapi, ['plugin::content-manager.explorer.update', 'plugin::content-manager.explorer.publish']),
    resolveInputSchema: () => h.strict({
      action: z.enum(ACTIONS).describe('list, status, cancel or undo.'),
      job_id: z.string().max(100).optional().describe('status, cancel, undo: the job.'),
      items: z.enum(['problems', 'all']).optional().describe('status: "problems" (default) or "all", 200 per page.'),
      cursor: z.string().max(20).optional().describe('list: next_cursor. status: items_next.cursor.'),
      limit: L.int(z.number().int().min(1).max(LIST_MAX)).optional().describe(`list: jobs per page (default ${LIST_DEFAULT}).`),
      on_conflict: z.enum(['skip', 'stop']).optional().describe('undo: "skip" (default) or "stop" at the first changed document.'),
      chunk_size: L.int(z.number().int().min(1)).optional().describe('undo: entries per transaction (default 25).'),
      max_chunks: L.int(z.number().int().min(1)).optional().describe('undo: chunks in this call at most.'),
      dry_run: L.bool(z.boolean()).optional().describe('undo: the plan only.'),
      preview: L.int(z.number().int().min(0).max(20)).optional().describe('undo dry_run: entries to preview (default 5).'),
      ...E.MOD.writeArgs(z), // `agent` (history module)
    }),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try {
        const owner = U.callerId(context, extra);
        await J.ready(strapi);
        const r = await dispatch(strapi, context, extra, owner, args || {});
        return r.ok === false ? h.fail(r) : h.ok(r);
      } catch (e) { return h.fail(h.errorOf(e)); }
    },
  };
}

module.exports = { toolDef, dispatch, list, status, cancel, undo, own, listItem, ARGS, ACTIONS, TOOLS };
