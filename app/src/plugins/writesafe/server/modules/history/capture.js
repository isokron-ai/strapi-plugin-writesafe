'use strict';

/**
 * History capture: one receipt row per successful ws_* write, holding who wrote, what, when, and a compact
 * before-image of exactly the fields and rows the write changed.
 * Design notes: docs/internals.md, section "server/modules/history/capture.js".
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const M = require('../../model');
const R = require('../../reply');

const RECEIPT_UID = 'plugin::writesafe.receipt';
const als = new AsyncLocalStorage();

/**
 * Where a receipt row keeps its history (one schema with the core, 1.0.0-rc.2): the module's record lives in the
 * row's `moduleData.history`; `receiptId`, `targets`, `tokenId` and `agent` are columns so ws_history can filter on
 * them. A row written with the history module off has receiptId null and is never listed.
 */
const histOf = (row) => (row && row.moduleData && typeof row.moduleData === 'object' ? row.moduleData.history || null : null);
const withHist = (row, h) => {
  const md = { ...((row && row.moduleData && typeof row.moduleData === 'object') ? row.moduleData : {}) };
  if (h == null) delete md.history; else md.history = h;
  return Object.keys(md).length ? md : null;
};

const DEFAULTS = { retentionDays: 30, maxBeforeBytes: 262144, maxJobBeforeBytes: 1073741824, pruneEverySeconds: 3600, undo: true };
let S = null; // strapi
let OPTS = { ...DEFAULTS };

function configure(strapi, opts) {
  S = strapi;
  const o = { ...DEFAULTS, ...(opts || {}) };
  for (const k of ['retentionDays', 'maxBeforeBytes', 'maxJobBeforeBytes', 'pruneEverySeconds']) {
    if (typeof o[k] !== 'number' || !(o[k] >= 0)) throw new Error(`writesafe.history.${k} must be a number >= 0 (got ${JSON.stringify(o[k])})`);
  }
  // setInterval clamps a delay above 2^31-1 ms to 1 ms, so the prune would run continuously (phase 1 review).
  if (o.pruneEverySeconds > 2147483) throw new Error(`writesafe.history.pruneEverySeconds must be at most 2147483 (got ${o.pruneEverySeconds})`);
  if (typeof o.undo !== 'boolean') throw new Error('writesafe.history.undo must be a boolean');
  OPTS = o;
  return o;
}
const opts = () => OPTS;

/**
 * Stored hashes of after-values (1.0 hardening item 8; fourth review N14): a plain sha256, not an HMAC under the version
 * key. They are never shown to a caller, so a keyed hash protects nothing, and it made every stored hash stale when
 * APP_KEYS rotated (or, without APP_KEYS, on every restart): each ws_undo then reported "changed since".
 * h16mac is the rc.2 form, still accepted when comparing (sameHash) so receipts written before the upgrade keep working
 * until the key changes.
 */
const h16 = (v) => M.sha(M.canonical(v === undefined ? null : v)).slice(0, 16);
const h16mac = (v) => M.mac(M.canonical(v === undefined ? null : v)).slice(0, 16);
const sameHash = (v, h) => h === h16(v) || h === h16mac(v);
const newId = () => `r_${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;

function listImage(kind, attr, b, a) {
  const bk = M.rowKeys(kind, attr, b);
  const ak = M.rowKeys(kind, attr, a);
  const bm = new Map((b || []).map((r, i) => [bk[i], r]));
  const am = new Map((a || []).map((r, i) => [ak[i], r]));
  const img = { o: bk, n: ak, b: {}, a: {}, m: 0 };
  for (const [k, r] of bm) {
    if (!am.has(k)) img.b[k] = r;
    else if (M.canonical(r) !== M.canonical(am.get(k))) { img.b[k] = r; img.a[k] = h16(am.get(k)); }
  }
  for (const [k, r] of am) if (!bm.has(k)) img.a[k] = h16(r);
  const common = (keys, other) => keys.filter((k) => other.has(k));
  if (common(bk, am).join('\n') !== common(ak, bm).join('\n')) img.m = 1;
  return img;
}

/** One history entry from a write's before/after drafts (both normalized: relations as documentIds, media as ids). */
function entryOf(info, before, after, view) {
  // versions as ws_get shows them come from the raw drafts (relations keep their linked locale): the writer passes them
  // in info.versions; the normalized drafts are the fallback (phase 2 A review, finding 4)
  const v = (side, d) => (info.versions && info.versions[side] !== undefined ? info.versions[side] : M.versionOf(S, info.uid, d));
  const e = { tool: info.tool, uid: info.uid, documentId: info.documentId || (after || before || {}).documentId, locale: info.locale || (after || before || {}).locale || null };
  if (info.args && info.args.ref !== undefined) e.ref = info.args.ref;
  if (info.action === 'publish') return { ...e, op: 'publish', vb: before ? v('before', before) : null };
  // ha: plain hash of the created draft's content, compared by ws_undo (no timestamp, no version key).
  if (!before) return { ...e, op: 'create', va: v('after', after), ha: h16(stripDoc(after)) };
  // The recreate payload stays the token's view (shown), so an undo never writes fields the token cannot read back.
  if (!after) {
    // cr: the original createdBy/updatedBy ids (ws_undo restores them and checks the image's fields against them)
    const cr = info.creators && (info.creators.createdBy != null || info.creators.updatedBy != null) ? { cb: info.creators.createdBy ?? null, ub: info.creators.updatedBy ?? null } : null;
    return { ...e, op: 'delete', vb: v('before', before), doc: stripDoc(view && view.before !== undefined ? view.before : before), ...(cr ? { cr } : {}) };
  }
  const attrs = M.attrsOf(S, info.uid);
  const f = {};
  const r = {};
  for (const [name, attr] of Object.entries(attrs)) {
    if (M.SKIP_KEYS.has(name)) continue;
    const b = before[name];
    const a = after[name];
    if (M.canonical(b === undefined ? null : b) === M.canonical(a === undefined ? null : a)) continue;
    const kind = M.fieldKind(attr);
    if (kind === 'repeatable' || kind === 'dynamiczone') r[name] = listImage(kind, attr, b, a);
    else f[name] = { b: b === undefined ? null : b, a: h16(a) };
  }
  return { ...e, op: 'update', vb: v('before', before), va: v('after', after), f, r };
}

/** The draft without the keys a recreate must not send. */
function stripDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) if (!M.SKIP_KEYS.has(k)) out[k] = v;
  return out;
}

/** Entries that carry a before-image (only these are capped). */
const hasBefore = (e) => e && (e.op === 'update' || e.op === 'delete');
const entryBytes = (e) => Buffer.byteLength(JSON.stringify(e));
function stripBefore(e) {
  for (const x of Object.values(e.f || {})) delete x.b;
  for (const x of Object.values(e.r || {})) x.b = {};
  delete e.doc;
}

/** Caps before-images in place: per document, then the job's budget left (in order). { bytes, stripped, exhausted } */
function capEntries(entries, { perDocument, budgetLeft = Infinity }) {
  let bytes = 0;
  let stripped = 0;
  let left = budgetLeft;
  let exhausted = !(left > 0);
  for (const e of entries) {
    if (!hasBefore(e)) continue;
    const size = entryBytes(e);
    if (size > perDocument) { stripBefore(e); e.t = 1; e.tr = 'document'; stripped += 1; continue; }
    if (exhausted || size > left) { stripBefore(e); e.t = 1; e.tr = 'job'; stripped += 1; exhausted = true; continue; }
    left -= size;
    bytes += size;
  }
  return { bytes, stripped, exhausted };
}

/** An entry ws_undo can still revert: a create (deleted again), or an update/delete with its before-image. */
const undoableEntry = (e) => e && (e.op === 'create' || (hasBefore(e) && !e.t));

/** Stats of one job's receipts (item 21): key, read under a lock (chunks of one job run one after the other anyway). */
const STAT_TOOL = 'ws_undo_stat';
const statKey = (group) => `undostat:${String(group).slice(0, 80)}`;
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
async function lockStat(strapi, group) {
  const row = await strapi.db.queryBuilder(RECEIPT_UID).select(['id', 'receipt']).where({ key: statKey(group) }).forUpdate().first().execute();
  return row ? { id: row.id, ...(parseJson(row.receipt) || {}) } : null;
}
async function readStat(strapi, group) {
  const row = await strapi.db.query(RECEIPT_UID).findOne({ where: { key: statKey(group) }, select: ['id', 'receipt'] });
  return row ? parseJson(row.receipt) || null : null;
}

/** hooks.afterWrite: add an entry to the running write's collector. Returns undefined (nothing added to the reply). */
async function afterWrite(ctx, info, before, after) {
  const run = als.getStore();
  // dry runs are collected only when asked to measure them (ws_bulk's dry run: the undo byte estimate)
  if (!run || (info.dryRun && !run.measure)) return undefined;
  // Hashes and before-values come from the FULL drafts (info.raw) when the writer passes them (1.0 hardening item 8;
  // fourth review N15): ws_undo compares against the full current draft, so hashing the token's view (hidden fields
  // removed) made every undo of a restricted token's create or component edit conflict. ws_history filters before
  // values through the token's read permissions when it shows them (visibleBefore).
  const raw = info.raw || {};
  const full = (k, v) => (k in raw ? raw[k] : v);
  const e = entryOf(info, full('before', before), full('after', after), { before, after });
  e.i = run.entries.length;
  run.entries.push(e);
  return undefined;
}

/** Inside a write run: mark the receipt (undo_of, group) — for ws_undo and module tools such as ws_bulk. */
function annotate(fields) {
  const run = als.getStore();
  if (run) Object.assign(run.meta, fields);
  return Boolean(run);
}

/**
 * The running write's entry count, and a rewind to it: a bulk chunk rolls one document back to its savepoint (1.0
 * hardening item 22) and must drop what that document recorded, or ws_undo would list a write that never happened.
 */
function entriesMark() {
  const run = als.getStore();
  return run ? run.entries.length : null;
}
function entriesRewind(n) {
  const run = als.getStore();
  if (run && Number.isInteger(n) && run.entries.length > n) run.entries.length = n;
}

/** Inside a write run: add fields to the entry the last write recorded (ws_undo: `uo`, the entry it reverted). */
function tagLast(fields) {
  const run = als.getStore();
  if (!run || !run.entries.length) return false;
  Object.assign(run.entries[run.entries.length - 1], fields);
  return true;
}

const tokenCache = new Map();
/** { id, name } of the admin token that made the request (Strapi does not pass it to tool handlers). */
async function tokenOf(strapi, extra) {
  // The in-Strapi runner (server/runner) has no request: it names the token that asked for the job.
  if (extra && extra.writesafeRunner && extra.writesafeRunner.token) return { id: extra.writesafeRunner.token.id, name: extra.writesafeRunner.token.name || null };
  const auth = extra && extra.requestInfo && extra.requestInfo.headers && extra.requestInfo.headers.authorization;
  if (!auth) return { id: null, name: null };
  const k = M.sha(auth);
  if (tokenCache.has(k)) return tokenCache.get(k);
  let out = { id: `h:${k.slice(0, 12)}`, name: null };
  try {
    // Same lookup as Strapi's admin-token authentication: HMAC-SHA512 of the access key with admin.apiToken.salt.
    const salt = strapi.config.get('admin.apiToken.salt');
    const accessKey = auth.replace(/^Bearer\s+/i, '');
    const hash = crypto.createHmac('sha512', salt).update(accessKey).digest('hex');
    const t = await strapi.db.query('admin::api-token').findOne({ select: ['id', 'name'], where: { accessKey: hash } });
    if (t) out = { id: String(t.id), name: t.name };
  } catch {
    // keep the hash-based id
  }
  if (tokenCache.size > 1000) tokenCache.clear();
  tokenCache.set(k, out);
  return out;
}

/**
 * The agent label of a write: the `agent` argument or the X-Writesafe-Agent / X-Agent-Name header. Only a slug is kept
 * (1.0 hardening item 4; fourth review N20): ws_history shows labels to other agents, so a label must not be able to
 * carry a sentence. The argument is checked by its schema; a header that is not a slug is ignored.
 */
const agentOf = (args, extra) => {
  const h = extra && extra.requestInfo && extra.requestInfo.headers;
  return R.agentSlug(args && args.agent) || (h && (R.agentSlug(h['x-writesafe-agent']) || R.agentSlug(h['x-agent-name']))) || null;
};

const targetsOf = (entries) => `|${[...new Set(entries.map((e) => `${e.uid}~${e.documentId}~${e.locale || ''}`))].join('|')}|`;

/** hooks.aroundWrite: collect entries during the write, then store one receipt row in the same transaction. */
async function aroundWrite(meta, next) {
  if (meta.args && meta.args.dry_run) {
    if (!meta.args._measure_undo) return next();
    // ws_bulk's dry run (item 21): what this write's before-image would cost, for the undo estimate in the preview
    const run = { entries: [], meta: {}, measure: true };
    const result = await als.run(run, next);
    if (result && typeof result === 'object') {
      const sizes = run.entries.filter(hasBefore).map(entryBytes);
      result.undo_bytes = { bytes: sizes.reduce((x, y) => x + y, 0), over_document_cap: sizes.filter((n) => n > OPTS.maxBeforeBytes).length };
    }
    return result;
  }
  const run = { entries: [], meta: {} };
  const result = await als.run(run, next);
  // an undo that reverted entries without writing still records its marks (a marks-only receipt; review L6)
  const marksOnly = !run.entries.length && Array.isArray(run.meta.undo_rows) && run.meta.undo_rows.length;
  if ((!run.entries.length && !marksOnly) || !result || result.replayed) return result;
  return store(meta, run, result);
}

/** Stores one receipt row for a finished run (in the caller's transaction, when there is one). Returns the reply + receipt_id. */
async function store(meta, run, result) {
  // A job (e.g. ws_bulk) groups its chunk receipts: "<job id>~<id>", so ws_undo can take the job id.
  const rid = run.meta.group ? `${String(run.meta.group).slice(0, 80)}~${newId()}` : newId();
  const token = await tokenOf(meta.strapi, meta.extra);
  const { agent: metaAgent, ...meta2 } = run.meta; // a job passes its agent label through annotate()
  const history = { v: 1, e: run.entries, tn: token.name, ...meta2 };
  // Caps per document and per job (item 21). A job's chunks share the job's budget through its stats row.
  const stat = run.meta.group ? await lockStat(meta.strapi, run.meta.group) : null;
  const budgetLeft = run.meta.group ? (stat && stat.exhausted ? 0 : OPTS.maxJobBeforeBytes - ((stat && stat.bytes) || 0)) : Infinity;
  const cap = capEntries(history.e, { perDocument: OPTS.maxBeforeBytes, budgetLeft });
  history.bytes = cap.bytes;
  if (cap.stripped && !history.e.some(undoableEntry)) history.t = 1;
  if (run.meta.group) {
    const next = {
      group: String(run.meta.group).slice(0, 80), bytes: ((stat && stat.bytes) || 0) + cap.bytes, entries: ((stat && stat.entries) || 0) + history.e.length,
      stripped: ((stat && stat.stripped) || 0) + cap.stripped, rows: ((stat && stat.rows) || 0) + 1, exhausted: Boolean((stat && stat.exhausted) || cap.exhausted),
    };
    if (stat) await meta.strapi.db.query(RECEIPT_UID).update({ where: { id: stat.id }, data: { receipt: next } });
    else await meta.strapi.db.query(RECEIPT_UID).create({ data: { key: statKey(run.meta.group), tool: STAT_TOOL, requestHash: '', receipt: next } });
  }
  const out = { ...result, receipt_id: rid };
  const row = { receiptId: rid, tokenId: token.id, agent: metaAgent || agentOf(meta.args, meta.extra), targets: targetsOf(run.entries), moduleData: { history } };
  // With an idempotency key the core has claimed the row in this transaction (moduleData still empty): fill it.
  if (meta.key) {
    const q = meta.strapi.db.query(RECEIPT_UID);
    const claimed = await q.findOne({ where: { key: meta.key }, select: ['id', 'moduleData'] });
    await q.update({ where: { key: meta.key }, data: { ...row, moduleData: withHist(claimed, history) } });
  }
  else {
    await meta.strapi.db.query(RECEIPT_UID).create({
      // The stored reply without documents (1.0 hardening item 5; N16): nothing replays it, and a deleted document's
      // content (`recreate`) or a `return: "full"` copy must not stay for the whole history retention.
      data: { key: `h:${rid}`, tool: meta.tool, receipt: require('../../retention').stripReceipt(out), ...row },
    });
  }
  for (const u of run.meta.undo_rows || []) await markUndone(meta.strapi, u, rid);
  return out;
}

/**
 * Records a write that does not run through api.runWrite (no document transaction), e.g. a Media Library import:
 * entries are { uid, documentId, locale?, op, ... } with an op ws_undo does not revert ('import'). Returns the
 * receipt_id. Called by other modules only when history is enabled.
 */
async function recordWrite(strapi, { tool, args, extra, entries, reply }) {
  if (!entries || !entries.length) return null;
  const run = { entries: entries.map((e, i) => ({ tool, ...e, i })), meta: {} };
  const out = await store({ strapi, extra, tool, args, key: null }, run, reply || { ok: true });
  return out.receipt_id;
}

/**
 * The undone receipt points to its undo (undone_by, or undone_items[i] for a partial undo). Undoing an undo puts the
 * earlier change back, so the marks that undo had set are cleared.
 */
/** A receipt row read IN its locking query (review M1: a read after the lock can be an older snapshot on MySQL). */
async function lockedReceipt(strapi, receiptId) {
  const row = await strapi.db.queryBuilder(RECEIPT_UID).select(['id', 'moduleData']).where({ receiptId }).forUpdate().first().execute();
  if (!row) return null;
  return { id: row.id, moduleData: typeof row.moduleData === 'string' ? JSON.parse(row.moduleData) : row.moduleData };
}

async function markUndone(strapi, { id, items }, byId) {
  const q = strapi.db.query(RECEIPT_UID);
  // Two partial undos of one receipt (different documents, so no shared row lock) must not lose each other's marks.
  const row = await lockedReceipt(strapi, id);
  if (!row || !histOf(row)) return;
  const h = { ...histOf(row) };
  if (items == null) h.undone_by = byId;
  else h.undone_items = { ...(h.undone_items || {}), ...Object.fromEntries(items.map((i) => [i, byId])) };
  await q.update({ where: { id: row.id }, data: { moduleData: withHist(row, h) } });
  if (items != null) {
    // undoing undo entries clears the marks they had set (uo)
    for (const i of items) {
      const ent = (h.e || [])[i];
      if (ent && Array.isArray(ent.uo)) await clearOrigin(strapi, ent.uo[0], ent.uo[1]);
    }
    return;
  }
  for (const u of histOf(row).undo_rows || []) {
    const orig = await lockedReceipt(strapi, u.id);
    if (!orig || !histOf(orig)) continue;
    const oh = { ...histOf(orig) };
    if (u.items == null) delete oh.undone_by;
    else if (oh.undone_items) {
      oh.undone_items = { ...oh.undone_items };
      for (const i of u.items) delete oh.undone_items[i];
    }
    await q.update({ where: { id: orig.id }, data: { moduleData: withHist(orig, oh) } });
  }
}

/** The entry `i` of receipt `rid` is no longer undone (its undo was undone). */
async function clearOrigin(strapi, rid, i) {
  const q = strapi.db.query(RECEIPT_UID);
  const orig = await lockedReceipt(strapi, rid);
  if (!orig || !histOf(orig)) return;
  const oh = { ...histOf(orig) };
  if (oh.undone_items && oh.undone_items[i] !== undefined) {
    oh.undone_items = { ...oh.undone_items };
    delete oh.undone_items[i];
  } else if (oh.undone_by) {
    // the whole receipt was undone; one of its entries is back: the others stay undone, item by item
    oh.undone_items = Object.fromEntries((oh.e || []).map((x) => x.i).filter((x) => String(x) !== String(i)).map((x) => [x, oh.undone_by]));
    delete oh.undone_by;
  } else return;
  await q.update({ where: { id: orig.id }, data: { moduleData: withHist(orig, oh) } });
}

/**
 * Before-images the token may read: whole-field values and list rows are passed through the read sanitizer. `only`
 * limits them to some fields (ws_undo conflicts show the before values of the fields that changed since).
 */
async function visibleBefore(pc, e, only, creator = {}) {
  // Sanitized with the entry's locale, so locale-scoped read permissions apply.
  // `creator` (createdBy/updatedBy of the current entry) lets permission conditions see whose entry it is (item 10a)
  const loc = { ...creator, ...(e.locale ? { locale: e.locale } : {}) };
  const clean = (o) => { if (o) { delete o.locale; delete o.createdBy; delete o.updatedBy; } return o; };
  if (e.op === 'delete') return e.doc ? { doc: clean(await pc.sanitizeOutput({ ...e.doc, ...loc })) } : {};
  const out = {};
  const wanted = (k) => !only || only.includes(k);
  const fields = Object.fromEntries(Object.entries(e.f || {}).filter(([k, v]) => 'b' in v && wanted(k)).map(([k, v]) => [k, v.b]));
  if (Object.keys(fields).length) {
    const safe = await pc.sanitizeOutput({ ...fields, ...loc });
    for (const k of Object.keys(fields)) if (safe && k in safe) (out.fields = out.fields || {})[k] = safe[k];
  }
  for (const [f, img] of Object.entries(e.r || {})) {
    if (!wanted(f)) continue;
    const keys = Object.keys(img.b || {});
    if (!keys.length) continue;
    const safe = await pc.sanitizeOutput({ [f]: keys.map((k) => img.b[k]), ...loc });
    if (!safe || !(f in safe)) continue;
    (out.rows = out.rows || {})[f] = Object.fromEntries(keys.map((k, i) => [k, safe[f][i]]));
  }
  return out;
}

let lastPrune = 0;
/**
 * Retention: receipts older than retentionDays lose their history. Rows that exist only for history (key "h:…") are
 * deleted; rows that also hold an idempotency key keep the key and the receipt (so a late retry is still answered)
 * but their history is cleared. retentionDays 0 keeps everything.
 */
async function prune(strapi, force) {
  if (!OPTS.retentionDays) return 0;
  const now = Date.now();
  if (!force && now - lastPrune < OPTS.pruneEverySeconds * 1000) return 0;
  lastPrune = now;
  const cutoff = new Date(now - OPTS.retentionDays * 86400000);
  const q = strapi.db.query(RECEIPT_UID);
  const del = await q.deleteMany({ where: { key: { $startsWith: 'h:' }, createdAt: { $lt: cutoff } } });
  // Keyed rows keep `targets` (the core's record of what the idempotent write touched); only the history goes.
  const old = await q.findMany({ select: ['id', 'moduleData'], where: { receiptId: { $notNull: true }, createdAt: { $lt: cutoff } }, limit: 1000 });
  for (const r of old) await q.update({ where: { id: r.id }, data: { moduleData: withHist(r, null), receiptId: null } });
  // a job's stats row (item 21) lives as long as the job's history
  const stats = await q.deleteMany({ where: { tool: STAT_TOOL, updatedAt: { $lt: cutoff } } });
  return (del && del.count ? del.count : 0) + old.length + (stats && stats.count ? stats.count : 0);
}

let timer = null;
function startPruning(strapi) {
  if (timer || !OPTS.retentionDays || !OPTS.pruneEverySeconds) return;
  timer = setInterval(() => prune(strapi, true).catch((e) => strapi.log.warn(`[writesafe] history prune failed: ${e.message}`)), OPTS.pruneEverySeconds * 1000);
  if (timer.unref) timer.unref();
}

const expired = (row) => OPTS.retentionDays > 0 && new Date(row.createdAt).getTime() < Date.now() - OPTS.retentionDays * 86400000;

module.exports = {
  configure, opts, aroundWrite, afterWrite, recordWrite, annotate, entriesMark, entriesRewind, tagLast, tokenOf, agentOf, prune, startPruning, expired, entryOf, h16, h16mac, sameHash, stripDoc,
  listImage, RECEIPT_UID, DEFAULTS, histOf, withHist, visibleBefore, capEntries, markUndone, clearOrigin, lockedReceipt, undoableEntry, hasBefore, readStat, statKey, STAT_TOOL,
};
