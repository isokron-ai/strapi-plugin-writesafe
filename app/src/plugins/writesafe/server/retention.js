'use strict';

/**
 * Retention for the receipts table (1.0 hardening item 5; Gemini review, fourth review N16). rc.2 only pruned history
 * rows: bulk jobs, their chunk rows, abandoned media claims and every idempotency row stayed for good, and a keyed row's
 * stored reply could hold a whole document (`return: "full"`, ws_delete's `recreate`), so deleted content stayed too.
 *
 * Config: writesafe.config.retention, every key optional:
 *   keyHours (72)         an idempotency key answers retries for this long; then its row is deleted, or, when the
 *                         history module still keeps the write's history, turned into a plain history row ("h:<id>")
 *                         with the stored documents stripped. A retry after that is a new request.
 *   jobHours (72)         a bulk job (its row and item rows in writesafe_bulk_jobs / writesafe_bulk_items, and an
 *                         rc.2 job's receipt and chunk rows) idle this long is deleted, finished or not. Its writes keep
 *                         their own history receipts (ws_undo with the job id works while those last).
 *   longHorizonDays (30)  [stream G] a paused job, and an approved job already under way, are kept this long idle (not
 *                         jobHours), with their approval request and lease, unless an admin cancels them first.
 *   claimMinutes (60)     a claim that never got its reply (a media import whose process died) is deleted after this.
 *   implicitClaimMinutes (10)  the implicit retry record of a versioned write without idempotency_key (1.0 hardening
 *                         item 16d) answers identical retries for this long; then it is deleted (or turned into a plain
 *                         history row), so a deliberate re-run of the same request applies again (re-review N1).
 *                         0 keeps them as long as idempotency keys (keyHours).
 *   pruneEverySeconds (3600)  how often the prune runs (also once at startup); 0 runs it on every ws_history call and
 *                         at startup only (tests).
 * 0 for keyHours or jobHours keeps those rows. History rows have their own retention (history.retentionDays).
 */
const RECEIPT_UID = 'plugin::writesafe.receipt';
const DEFAULTS = { keyHours: 72, jobHours: 72, claimMinutes: 60, implicitClaimMinutes: 10, pruneEverySeconds: 3600, longHorizonDays: 30 };
const BATCH = 500;
const MAX_INTERVAL_S = 2147483; // floor((2^31 - 1) / 1000): the largest delay setInterval honours
const CONTENT_KEYS = ['document', 'recreate', 'diff'];

let OPTS = { ...DEFAULTS };
let orphanCursor = 0;
const resetCursors = () => { orphanCursor = 0; require('./modules/_bulk/store').resetPruneCursor(); };

function configure(opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof o[k] !== 'number' || !(o[k] >= 0)) throw new Error(`writesafe.retention.${k} must be a number >= 0 (got ${JSON.stringify(o[k])})`);
  }
  // setInterval clamps a delay above 2^31-1 ms (about 24.8 days) to 1 ms: the prune would run continuously (review).
  if (o.pruneEverySeconds > MAX_INTERVAL_S) throw new Error(`writesafe.retention.pruneEverySeconds must be at most ${MAX_INTERVAL_S} (got ${o.pruneEverySeconds})`);
  OPTS = o;
  return o;
}

/** A stored reply without the documents it may carry (kept: ids, versions, statuses, counts). */
function stripReceipt(r, depth = 0) {
  if (!r || typeof r !== 'object' || depth > 3) return r;
  if (Array.isArray(r)) return r.map((x) => stripReceipt(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (CONTENT_KEYS.includes(k)) continue;
    out[k] = k === 'items' ? stripReceipt(v, depth + 1) : v;
  }
  return out;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

/** One pass. Returns counts per kind. Runs outside any write transaction; every statement stands alone. */
async function prune(strapi) {
  const q = strapi.db.query(RECEIPT_UID);
  const out = { keys: 0, keys_to_history: 0, jobs: 0, chunks: 0, claims: 0, implicit: 0, job_items: 0 };
  // 0. implicit retry records of versioned writes ("v:" keys, item 16d): implicitClaimMinutes (re-review N1)
  if (OPTS.implicitClaimMinutes) {
    const where = { key: { $startsWith: 'v:' }, receipt: { $notNull: true }, createdAt: { $lt: new Date(Date.now() - OPTS.implicitClaimMinutes * 60000) } };
    for (let round = 0; round < 20; round += 1) {
      const rows = await q.findMany({ where, select: ['id', 'receiptId', 'receipt'], orderBy: { id: 'asc' }, limit: BATCH });
      if (!rows.length) break;
      const plain = rows.filter((r) => !r.receiptId).map((r) => r.id);
      if (plain.length) await q.deleteMany({ where: { id: { $in: plain } } });
      for (const r of rows.filter((x) => x.receiptId)) await q.update({ where: { id: r.id }, data: { key: `h:${r.receiptId}`, requestHash: null, receipt: stripReceipt(r.receipt) } });
      out.implicit += rows.length;
      if (rows.length < BATCH) break;
    }
  }
  // 1. idempotency keys (core writes and media imports): requestHash set, not a job, a chunk, a claim or a history row
  if (OPTS.keyHours) {
    const where = {
      // history rows ("h:") have no requestHash; jobs, chunks and claims are told apart by their tool
      requestHash: { $notNull: true, $ne: '' }, tool: { $notIn: ['ws_bulk_job', 'ws_bulk_chunk', 'claim'] },
      receipt: { $notNull: true }, createdAt: { $lt: hoursAgo(OPTS.keyHours) },
    };
    for (let round = 0; round < 20; round += 1) {
      const rows = await q.findMany({ where, select: ['id', 'receiptId', 'receipt'], orderBy: { id: 'asc' }, limit: BATCH });
      if (!rows.length) break;
      const plain = rows.filter((r) => !r.receiptId).map((r) => r.id);
      if (plain.length) { await q.deleteMany({ where: { id: { $in: plain } } }); out.keys += plain.length; }
      for (const r of rows.filter((x) => x.receiptId)) {
        // still in the history module's record: keep the history, drop the key (and the documents in the stored reply)
        await q.update({ where: { id: r.id }, data: { key: `h:${r.receiptId}`, requestHash: null, receipt: stripReceipt(r.receipt) } });
        out.keys_to_history += 1;
      }
      if (rows.length < BATCH) break;
    }
  }
  // 2. claims that never got a reply (media imports of a process that died; a transient claim that leaked)
  if (OPTS.claimMinutes) {
    const r = await q.deleteMany({ where: { receipt: { $null: true }, $or: [{ key: { $startsWith: 'claim:' } }, { requestHash: { $notNull: true, $ne: '' } }], updatedAt: { $lt: new Date(Date.now() - OPTS.claimMinutes * 60000) } } });
    out.claims += (r && r.count) || 0;
  }
  // 3. bulk jobs idle for jobHours (done, stopped or abandoned while running), with their chunk rows
  if (OPTS.jobHours) {
    const cutoff = hoursAgo(OPTS.jobHours);
    // rc.2 job rows in the receipts table (jobs live in their own tables since stream E; these are leftovers)
    const jobs = await q.findMany({ where: { tool: 'ws_bulk_job', updatedAt: { $lt: cutoff } }, select: ['id', 'key'], limit: BATCH });
    for (const j of jobs) {
      // Re-checked at delete time (review): a job resumed at the 72 h mark moved its updatedAt since the lookup, and
      // its chunk transaction holds the job row's lock, so this waits for it and then finds it no longer idle.
      const d = await q.deleteMany({ where: { id: j.id, updatedAt: { $lt: cutoff } } });
      if (!d || !d.count) continue;
      out.jobs += 1;
      const c = await q.deleteMany({ where: { key: { $startsWith: `${j.key}:c` } } });
      out.chunks += (c && c.count) || 0;
    }
    // Chunk rows whose job row is gone (a job deleted by hand, or a crash between the two deletes above), paged by id
    // from a cursor kept between runs (review): an unordered page could stay full of a live job's old chunks forever.
    for (let page = 0; page < 20; page += 1) {
      const chunks = await q.findMany({ where: { tool: 'ws_bulk_chunk', updatedAt: { $lt: cutoff }, id: { $gt: orphanCursor } }, select: ['id', 'key'], orderBy: { id: 'asc' }, limit: BATCH });
      if (!chunks.length) { orphanCursor = 0; break; }
      orphanCursor = chunks[chunks.length - 1].id;
      const jobOf = (k) => k.replace(/:c\d+$/, '');
      const keys = [...new Set(chunks.map((c) => jobOf(c.key)))];
      const live = new Set((await q.findMany({ where: { key: { $in: keys } }, select: ['key'] })).map((r) => r.key));
      const gone = chunks.filter((c) => !live.has(jobOf(c.key))).map((c) => c.id);
      if (gone.length) {
        await q.deleteMany({ where: { id: { $in: gone } } });
        out.chunks += gone.length;
      }
      if (chunks.length < BATCH) { orphanCursor = 0; break; }
    }
  }
  // 4. bulk jobs in their own tables (1.0 hardening item 18): the job row and its item rows, idle for jobHours
  if (OPTS.jobHours && strapi.contentTypes && strapi.contentTypes['plugin::writesafe.bulk-job']) {
    try {
      const S = require('./modules/_bulk/store');
      const AR = require('./approval/retention');
      const AD = require('./runner/adapter');
      // never younger than a plan token's life (review of PR #16, L2)
      const cutoff = S.jobCutoff(OPTS.jobHours, require('./modules/_bulk/util').settings(strapi).bulk.planTtlSeconds);
      const now = Date.now();
      const longCutoffMs = now - (OPTS.longHorizonDays || 0) * 86400000;
      // [stream G] a job waiting for approval, paused, under way after an approval or run by the runner goes only with
      // its request and lease, on the long horizon where it applies (approval/retention.js)
      const r = await S.prune(strapi, cutoff, 200, {
        decide: async (row) => {
          const g = AD.toG(row);
          const linked = await AR.linkedOf(strapi, g);
          const act = AR.jobAction(g, linked.request, linked.lease, now, { updatedAtMs: new Date(row.updatedAt).getTime(), longCutoffMs });
          return { act, linked, g };
        },
        linked: async (row, v) => { await AR.deleteLinked(strapi, v.g, v.linked); out.approval_records = (out.approval_records || 0) + 1; },
      });
      out.jobs += r.jobs;
      out.job_items = r.items;
      // [stream G] finished requests (spec and samples), their decisions and finished leases, on the same clock
      const rec = await AR.pruneRecords(strapi, cutoff.getTime(), async (jobId) => Boolean(await S.findJob(strapi, jobId)));
      out.approval_records = (out.approval_records || 0) + rec.requests + rec.leases;
    } catch (e) {
      strapi.log.warn(`[writesafe] bulk job retention failed: ${e.message}`);
    }
  }
  return out;
}

let last = 0;
let running = null;
/** Runs the prune when it is due (always with force). Never throws: a failure is logged and retried next time. */
async function maybePrune(strapi, force) {
  const now = Date.now();
  if (running) return running;
  if (!force && OPTS.pruneEverySeconds && now - last < OPTS.pruneEverySeconds * 1000) return null;
  last = now;
  running = prune(strapi)
    .then((r) => {
      const n = Object.values(r).reduce((a, b) => a + b, 0);
      if (n) strapi.log.info(`[writesafe] receipts retention: ${JSON.stringify(r)}`);
      return r;
    })
    .catch((e) => { strapi.log.warn(`[writesafe] receipts retention failed: ${e.message}`); return null; })
    .finally(() => { running = null; });
  return running;
}

let timer = null;
function start(strapi, opts) {
  configure(opts);
  maybePrune(strapi, true);
  if (timer || !OPTS.pruneEverySeconds) return;
  timer = setInterval(() => maybePrune(strapi, true), OPTS.pruneEverySeconds * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { DEFAULTS, configure, prune, resetCursors, maybePrune, start, stripReceipt, opts: () => OPTS };
