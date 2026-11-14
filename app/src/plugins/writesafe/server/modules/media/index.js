'use strict';

/**
 * Media module (writesafe.modules.media): get files INTO the Media Library and find them again, without putting file
 * bytes in the agent's context.
 *
 *   ws_media_import  import one or many files from URLs (allowlist + SSRF guard + size cap + sniffed MIME types),
 *                    dedup by content hash, idempotency keys, per-item status. Uses Strapi's upload service, so every
 *                    upload provider (local, S3, Cloudinary, ...) works unchanged.
 *   ws_media_find    search existing media by name, alt text, content hash, source URL, folder or MIME type; compact rows.
 *
 * A feature module (server/modules/index.js registry). Off by default; with it off no tool is registered and the import
 * index table (plugin::writesafe.media-import, declared in strapi-server.js) stays empty.
 * Config (config/plugins.js → writesafe.config):
 *   modules: { media: true },
 *   media: { allow: [...], maxBytes, maxPixels, allowedTypes, timeoutMs, maxRedirects, maxItems, concurrency }
 * The media options are validated when the module loads; a bad option stops Strapi with the reason.
 * See docs/tools-media.md.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { z } = require('@strapi/utils');
const NET = require('./net');
const M = require('../../model');
const R = require('../../reply');

const FILE_UID = 'plugin::upload.file';
const FOLDER_UID = 'plugin::upload.folder';
const INDEX_UID = 'plugin::writesafe.media-import';
const RECEIPT_UID = 'plugin::writesafe.receipt';
const ACTION_CREATE = 'plugin::upload.assets.create';
const ACTION_READ = 'plugin::upload.read';

// ---------------------------------------------------------------- config
const DEFAULTS = {
  allow: [], // deny all: an admin must opt in host by host
  maxBytes: 10 * 1024 * 1024,
  allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'],
  timeoutMs: 20000,
  maxRedirects: 3,
  maxPixels: 40000000, // width x height x frames, read from the header before Strapi decodes the image
  maxItems: 50,
  concurrency: 4,
};
// Never accepted, whatever the config says: active content that a browser would run from the media URL.
// Any XML type is refused too: file-type reports an SVG or XHTML document with an <?xml?> prolog as application/xml, and a
// browser runs its scripts (stored XSS on the Strapi origin with the local provider).
const NEVER_TYPES = ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml', 'application/javascript',
  'text/javascript', 'application/x-msdownload', 'application/x-sh', 'application/x-shockwave-flash'];
const isNever = (mime) => matchesType(mime, NEVER_TYPES) || /\+xml$/i.test(mime);
const FORBIDDEN_CONFIG_KEYS = ['allowPrivate', 'allowPrivateNetworks', 'allowLoopback', 'testLoopbackPorts', 'testDns', 'ssrf', 'disableSsrfGuard'];

/** Validates writesafe.config.media (the module switch itself is writesafe.config.modules.media, checked by config.js). */
function validateConfig(cfg) {
  const m = (cfg && cfg.media) || {};
  if (typeof m !== 'object' || Array.isArray(m)) throw new Error('writesafe.media must be an object');
  for (const k of FORBIDDEN_CONFIG_KEYS) {
    if (k in m) throw new Error(`writesafe.media.${k} is not a setting: the SSRF guard cannot be relaxed from config. For local tests see docs/tools-media.md (test override).`);
  }
  if (m.allow !== undefined) {
    if (!Array.isArray(m.allow)) throw new Error('writesafe.media.allow must be an array of hosts or URL prefixes');
    for (const e of m.allow) NET.parseAllowEntry(e); // throws with the bad entry
  }
  for (const k of ['maxBytes', 'timeoutMs', 'maxItems', 'concurrency', 'maxPixels']) {
    if (m[k] !== undefined && !(Number.isInteger(m[k]) && m[k] > 0)) throw new Error(`writesafe.media.${k} must be a positive integer`);
  }
  if (m.maxRedirects !== undefined && !(Number.isInteger(m.maxRedirects) && m.maxRedirects >= 0 && m.maxRedirects <= 10)) throw new Error('writesafe.media.maxRedirects must be an integer from 0 to 10');
  if (m.allowedTypes !== undefined) {
    if (!Array.isArray(m.allowedTypes) || !m.allowedTypes.every((t) => typeof t === 'string' && /^[a-z]+\/[a-z0-9.+*-]+$/i.test(t))) throw new Error('writesafe.media.allowedTypes must be a list of MIME types (wildcards like image/* allowed)');
  }
}

/**
 * The test override is decided once, when the tools are built: env only (see net.js testOverride), NODE_ENV=test, AND Strapi
 * bound to a loopback host. A staging server that listens publicly never gets it, even with NODE_ENV=test.
 */
let OVERRIDE = null;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
function decideOverride(strapi) {
  const o = NET.testOverride();
  if (o && !o.ignored) {
    const host = String(strapi.config.get('server.host') || '');
    if (!LOOPBACK_HOSTS.has(host)) return { ignored: true, reason: `Strapi listens on ${host || '(all interfaces)'}, not loopback` };
    if (strapi.config.get('environment') === 'production') return { ignored: true, reason: 'Strapi environment is production' };
  }
  return o;
}

function settings(strapi) {
  const m = { ...DEFAULTS, ...((strapi.config.get('plugin::writesafe') || {}).media || {}) };
  return { ...m, rules: (m.allow || []).map(NET.parseAllowEntry), override: OVERRIDE, log: (msg) => strapi.log.info(`[writesafe] media: ${msg}`) };
}

const matchesType = (mime, patterns) => (patterns || []).some((p) => {
  const pat = p.toLowerCase();
  if (pat.includes('*')) return new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(mime);
  return pat === mime;
});

// ---------------------------------------------------------------- content types
/** Index of imported files: content hash → file. Used for dedup and for ws_media_find by hash or source. */
const indexContentType = {
  schema: {
    kind: 'collectionType',
    collectionName: 'writesafe_media_imports',
    info: { singularName: 'media-import', pluralName: 'media-imports', displayName: 'Write-safe media import' },
    options: { draftAndPublish: false },
    pluginOptions: { 'content-manager': { visible: false }, 'content-type-builder': { visible: false } },
    attributes: {
      sha256: { type: 'string', required: true },
      fileId: { type: 'integer', required: true },
      sourceUrl: { type: 'text' },
      bytes: { type: 'biginteger' },
      mime: { type: 'string' },
    },
  },
};

let indexReady = null;
/** Index on sha256, created on first use (the module has no bootstrap hook in the registry). */
function ensureIndexOnce(strapi) {
  if (!indexReady) indexReady = ensureIndex(strapi);
  return indexReady;
}

async function ensureIndex(strapi) {
  const meta = strapi.db.metadata.get(INDEX_UID);
  const table = meta.tableName;
  const col = (meta.attributes.sha256 && meta.attributes.sha256.columnName) || 'sha256';
  const name = `${table}_sha_idx`;
  try {
    await strapi.db.connection.schema.alterTable(table, (t) => t.index([col], name));
  } catch (e) {
    if (!/already exists|Duplicate key name/i.test(e.message)) strapi.log.warn(`[writesafe] media: could not create index ${name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- helpers
class MediaError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
const errOf = (e) => {
  if (e instanceof MediaError || e instanceof NET.NetError) return { code: e.code, message: e.message, ...e.extra };
  if (e && e.name === 'ForbiddenError') return { code: 'forbidden', message: e.message || 'Forbidden' };
  if (e && (e.name === 'ValidationError' || e.name === 'ApplicationError')) return { code: 'invalid_file', message: e.message };
  if (e && e.name === 'PayloadTooLargeError') return { code: 'too_large', message: e.message };
  // server or driver text in `detail`, not in the message (phase 1 review, item 8)
  return { code: 'import_failed', message: 'The import failed on the server (see detail). Nothing was stored for this item.', detail: String((e && e.message) || e).slice(0, 2000) };
};
// Error objects (per item too) get retryable/requires_reread like every ws_* reply (server/reply.js).
const ok = (reply) => { const sc = R.typeReply(reply); return { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc }; };
const fail = (reply) => { const sc = R.typeReply(reply); return { isError: true, content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc }; };

const pmFor = (strapi, ctx, action, model) => strapi.service('admin::permission').createPermissionsManager({ ability: ctx.userAbility, action, model });

/**
 * The form a media reference takes: the file's documentId. It is what ws_get shows for media fields (model.js refOf
 * reads documentId first), the same form 0.2 uses for relations, and Strapi 5.62 accepts it for media in REST and in
 * update_<type> (checked in tests/test_media.py t_use_in_content). `id` (numeric) is also returned, for the built-in
 * media_* tools, which take numeric ids.
 * COORDINATION (v1-core): media refs inside components should accept this form. If v1-core settles on another form,
 * change this one function.
 */
const refOf = (file) => file.documentId;

/** A safe stored name: no path parts, no control or reserved characters, the extension of the DETECTED type. */
function safeName(wanted, urlPath, ext, sha) {
  let base = wanted;
  if (!base) {
    const seg = (urlPath || '').split('/').filter(Boolean).pop() || '';
    try { base = decodeURIComponent(seg); } catch { base = seg; }
  }
  base = String(base || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, '') || `import-${sha.slice(0, 12)}`;
  const finalStem = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `_${stem}` : stem;
  return `${finalStem}.${ext}`;
}

async function sniff(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4100);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const { fileTypeFromBuffer } = await import('file-type');
    return await fileTypeFromBuffer(new Uint8Array(buf.subarray(0, bytesRead)));
  } finally {
    await fh.close();
  }
}

/**
 * Process-wide limit on imports in flight (download + decode + upload), across all calls and tokens, so parallel calls
 * cannot multiply memory use. Each call also runs at most `concurrency` items at once.
 */
let slotsFree = null;
const slotQueue = [];
async function withSlot(n, fn) {
  if (slotsFree === null) slotsFree = n;
  if (slotsFree > 0) slotsFree -= 1;
  else await new Promise((r) => slotQueue.push(r));
  try { return await fn(); } finally {
    const next = slotQueue.shift();
    if (next) next(); else slotsFree += 1;
  }
}

/** Header-only image size check (no decode). Images over the pixel budget are refused before Strapi decodes them. */
let sharpLib;
/** sharp as Strapi's upload plugin resolves it (pnpm and nested installs included). Logs once when it is missing. */
function loadSharp(strapi) {
  if (sharpLib !== undefined) return sharpLib;
  sharpLib = null;
  const tries = [];
  try { tries.push(path.dirname(require.resolve('@strapi/upload/package.json'))); } catch { /* not resolvable from here */ }
  tries.push(__dirname);
  for (const base of tries) {
    try { sharpLib = require(require.resolve('sharp', { paths: [base] })); break; } catch { /* next */ }
  }
  if (!sharpLib) strapi.log.error('[writesafe] media: sharp not found, so the maxPixels check (decompression bombs) cannot run: image imports are REFUSED (pixel_check_unavailable) until sharp is installed. Strapi\'s upload plugin normally provides it.');
  return sharpLib;
}
// file-type extension -> sharp input format id. Formats sharp cannot open are not decoded by Strapi either: skipped.
// `jpeg` too (1.0 hardening item 9): an extension spelt that way skipped the pixel check.
const SHARP_FMT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', tif: 'tiff', tiff: 'tiff', avif: 'heif', heic: 'heif' };

async function checkPixels(strapi, filePath, mime, ext, maxPixels) {
  if (!/^image\//.test(mime)) return;
  const fmt = SHARP_FMT[ext];
  if (!fmt) return; // a format sharp never decodes (BMP, ICO, ...): no pixel check, with or without sharp
  const sharp = loadSharp(strapi);
  // Fails closed (phase 2 item 14): rc.2 skipped the check without sharp, so a decompression bomb went to Strapi.
  if (!sharp) {
    throw new MediaError('pixel_check_unavailable', 'Images cannot be imported on this server: the image size check (writesafe.media.maxPixels, the decompression-bomb guard) needs the sharp library, which is not installed. Nothing was stored for this item. An admin must install sharp (Strapi\'s upload plugin normally provides it).');
  }
  if (!(sharp.format && sharp.format[fmt] && sharp.format[fmt].input && sharp.format[fmt].input.file)) return;
  let meta;
  try { meta = await sharp(filePath, { limitInputPixels: false }).metadata(); } catch (e) {
    throw new MediaError('invalid_file', 'The file is not a readable image (see detail).', { detail: String(e.message).slice(0, 500) });
  }
  const px = (meta.width || 0) * (meta.pageHeight || meta.height || 0) * (meta.pages || 1);
  if (px > maxPixels) {
    throw new MediaError('too_large', `The image is ${meta.width}x${meta.height}${meta.pages > 1 ? ` x ${meta.pages} frames` : ''} (${px} pixels); the limit is ${maxPixels} (config writesafe.media.maxPixels).`, { pixels: px, max_pixels: maxPixels });
  }
}

/** Run fn over items with a fixed concurrency, keeping order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Per content hash, one import at a time across every Strapi process that shares the database (phase 2 item 14): a claim
 * row "claim:media-sha:<sha256>" in the receipts table, whose `key` has a unique index (engine.ensureReceiptIndex), so
 * a second replica's insert fails and it waits for the first import to finish, then finds its file (status "existing").
 * rc.2 used a map in process memory, which two replicas do not share, so both uploaded the file. A claim older than
 * staleMs (a process that died mid-import) is taken over; a live claim is refreshed while its import runs, and the
 * receipts retention deletes old claims. A caller that waits longer than waitMs (default 10 minutes) gets `in_progress`
 * (retryable) instead of a duplicate. Without the unique index it falls back to a per-process lock and logs it.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warnedNoIndex = false;
async function withShaClaim(strapi, sha, fn, o = {}) {
  // Without the receipts table's unique index two claims could both be inserted: fall back to the per-process lock (and
  // say so once) rather than pretend the database serialises imports (review finding 5).
  const keys = o.keys || require('../../engine').KEYS;
  if (keys && keys.indexed === false) {
    if (!warnedNoIndex) { warnedNoIndex = true; strapi.log.warn('[writesafe] media: the receipts unique index is missing, so dedup is per process only (two Strapi processes may store the same file twice)'); }
    return withShaLock(sha, () => fn(async () => {}));
  }
  const q = strapi.db.query(RECEIPT_UID);
  const key = `claim:media-sha:${sha}`;
  const waitMs = o.waitMs ?? CLAIM_STALE_MS;
  const staleMs = o.staleMs ?? CLAIM_STALE_MS;
  const poll = o.pollMs ?? 100;
  const t0 = Date.now();
  let id = null;
  for (;;) {
    try {
      id = (await q.create({ data: { key, tool: 'claim', receipt: null } })).id;
      break;
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
    const cur = await q.findOne({ where: { key } });
    if (cur && Date.now() - new Date(cur.updatedAt || cur.createdAt || 0).getTime() > staleMs) {
      // re-checked in the delete itself, so a claim refreshed meanwhile is not taken
      await q.deleteMany({ where: { id: cur.id, updatedAt: { $lt: new Date(Date.now() - staleMs) } } });
      continue;
    }
    if (Date.now() - t0 > waitMs) {
      throw new MediaError('in_progress', 'Another import of the same file content is still running (on this or another server). Nothing was stored for this item. Retry it in a moment.', { retryable: true, requires_reread: false });
    }
    await sleep(poll + Math.random() * poll);
  }
  const refresh = async () => { try { await q.update({ where: { id }, data: { tool: 'claim' } }); } catch { /* next time */ } };
  // kept fresh while the import runs, so a long upload (a large file to S3) is never taken over as stale
  const timer = setInterval(refresh, Math.max(1000, Math.floor(staleMs / 3)));
  if (timer.unref) timer.unref();
  try { return await fn(refresh); } finally {
    clearInterval(timer);
    await q.delete({ where: { id } }).catch(() => {});
  }
}

/** The per-process fallback when the unique index is missing: one import per content hash at a time in this process. */
const shaLocks = new Map();
async function withShaLock(sha, fn) {
  const prev = shaLocks.get(sha) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chained = prev.then(() => mine);
  shaLocks.set(sha, chained);
  await prev;
  try { return await fn(); } finally {
    release();
    if (shaLocks.get(sha) === chained) shaLocks.delete(sha);
  }
}

/**
 * Upload a new file, then record it in the import index. If the index insert fails, the uploaded file is removed again
 * (phase 2 item 14): rc.2 left it in the library, unindexed, and a retry uploaded a second copy. `upload` wraps the
 * upload call (concurrency slots, claim refresh).
 */
async function storeNew(strapi, ctx, { fileObj, fileInfo, sha256, finalUrl, bytes, mime }, upload = (fn) => fn()) {
  const svc = strapi.plugin('upload').service('upload');
  const [created] = await upload(() => svc.upload({ data: { fileInfo }, files: fileObj }, { user: ctx.user }));
  try {
    await strapi.db.query(INDEX_UID).create({ data: { sha256, fileId: created.id, sourceUrl: finalUrl, bytes, mime } });
  } catch (e) {
    let removed = true;
    try { await svc.remove(created); } catch (e2) {
      removed = false;
      strapi.log.error(`[writesafe] media: file ${created.id} was uploaded but neither indexed nor removed (${e2.message}); delete it in the Media Library`);
    }
    throw new MediaError('index_failed', removed
      ? 'The file was uploaded but could not be recorded in the import index, so it was removed again. Nothing was stored for this item. Retry it.'
      : 'The file was uploaded but could not be recorded in the import index, and removing it failed: it is in the Media Library without an index entry (file_id). Retry the item; an admin can delete the stray file.', {
      detail: String(e && e.message).slice(0, 500), retryable: removed, requires_reread: false, ...(removed ? {} : { file_id: created.id }),
    });
  }
  return created;
}

// ---------------------------------------------------------------- folders
async function folderById(strapi, id) {
  const f = await strapi.db.query(FOLDER_UID).findOne({ where: { id }, select: ['id', 'name', 'path'] });
  if (!f) throw new MediaError('folder_not_found', `No Media Library folder with id ${id}.`);
  return f;
}

/** "Screens/Home" → folder id, creating missing folders when create is true. */
async function folderByPath(strapi, ctx, p, create) {
  const segs = String(p).split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  let parent = null;
  for (const name of segs) {
    if (name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new MediaError('invalid', `Folder name "${name.slice(0, 40)}" is not allowed.`);
    let f = await strapi.db.query(FOLDER_UID).findOne({ where: { name, parent: parent ? parent.id : null }, select: ['id', 'name', 'path'] });
    if (!f) {
      if (!create) throw new MediaError('folder_not_found', `No Media Library folder "${segs.join('/')}" (missing: "${name}").`);
      f = await strapi.plugin('upload').service('folder').create({ name, parent: parent ? parent.id : null }, { user: ctx.user });
    }
    parent = f;
  }
  return parent;
}

// ---------------------------------------------------------------- idempotency (stored in the plugin's receipt table)
// Per-token scope and the unique index, as for the core's keys (engine.tokenScope / requireUniqueIndex; 1.0 hardening item 7).
const who = (ctx, extra) => {
  const E = require('../../engine');
  E.requireUniqueIndex();
  return E.tokenScope(ctx, extra);
};
const CLAIM_STALE_MS = 10 * 60 * 1000;
const isUnique = (e) => /23505|SQLITE_CONSTRAINT|ER_DUP_ENTRY|UNIQUE constraint|duplicate key/i.test(`${e && e.code} ${e && e.message} ${e && e.cause && e.cause.code}`);

async function claimKey(strapi, key, rh) {
  const q = strapi.db.query(RECEIPT_UID);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prior = await q.findOne({ where: { key } });
    if (prior) {
      if (prior.requestHash !== rh) return { reused: true };
      if (prior.receipt) return { replay: { ...prior.receipt, replayed: true } };
      const age = Date.now() - new Date(prior.updatedAt || prior.createdAt || 0).getTime();
      if (age < CLAIM_STALE_MS) return { inProgress: true };
      await q.delete({ where: { id: prior.id } }); // abandoned claim (process died mid-import)
      continue;
    }
    try {
      const row = await q.create({ data: { key, requestHash: rh, tool: 'ws_media_import', receipt: null } });
      return { claimed: true, id: row.id };
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  return { inProgress: true };
}

// ---------------------------------------------------------------- import
/** File URLs signed for private providers (S3 private buckets etc.); unchanged for public ones. */
async function signed(strapi, file) {
  try { return await strapi.plugin('upload').service('file').signFileUrls(file); } catch { return file; }
}

function view(file, extra = {}) {
  return {
    status: extra.status,
    id: file.id,
    ref: refOf(file),
    name: file.name,
    mime: file.mime,
    bytes: file.sizeInBytes != null ? Number(file.sizeInBytes) : Math.round(Number(file.size || 0) * 1024),
    url: file.url,
    folder: file.folder && typeof file.folder === 'object' ? file.folder.id : (file.folder ?? null),
    ...extra,
  };
}

async function findReadableExisting(strapi, ctx, sha) {
  const rows = await strapi.db.query(INDEX_UID).findMany({ where: { sha256: sha }, orderBy: { id: 'asc' }, select: ['id', 'fileId'] });
  if (!rows.length) return null;
  const pmRead = pmFor(strapi, ctx, ACTION_READ, FILE_UID);
  for (const r of rows) {
    const exists = await strapi.db.query(FILE_UID).findOne({ where: { id: r.fileId }, select: ['id'] });
    if (!exists) { await strapi.db.query(INDEX_UID).delete({ where: { id: r.id } }); continue; } // file deleted since
    // Only reuse a file this token may read (permission conditions such as "own files only" apply); otherwise a new
    // copy is uploaded, so the token never learns about a file it cannot see.
    if (!pmRead.isAllowed) continue;
    const q = await pmRead.addPermissionsQueryTo({ filters: { id: r.fileId }, page: 1, pageSize: 1, populate: { folder: { fields: ['id'] } } });
    const { results } = await strapi.plugin('upload').service('upload').findPage(q);
    if (results.length) return results[0];
  }
  return null;
}

async function importOne(strapi, ctx, extra, item, idx, shared, S) {
  const base = { i: idx };
  const source = () => { try { return NET.redact(new URL(item.url)); } catch { return String(item.url).slice(0, 200); } };
  // Idempotency: per item, scoped to the token. A call-level key is applied to each item with its URL.
  const ikey = item.idempotency_key || (shared.idempotency_key ? `${shared.idempotency_key}|${idx}|${item.url}` : null);
  const rh = M.sha(M.canonical({ url: item.url, name: item.name ?? null, alt: item.alt ?? null, caption: item.caption ?? null, folder: shared.folderId ?? null }));
  let key = null;
  let claimId = null;
  let tmpDir = null;
  try {
    if (ikey && !shared.dry_run) {
      let principal;
      try { principal = who(ctx, extra); } catch (e) { throw new MediaError(e.payload ? e.payload.code : 'invalid', e.payload ? e.payload.message : e.message); }
      const k = M.sha(`${principal}|ws_media_import|${ikey}`);
      const c = await claimKey(strapi, k, rh);
      if (c.reused) return { ...base, status: 'failed', source: source(), error: { code: 'idempotency_key_reused', message: 'This idempotency_key was already used for a different import. Use a new key.' } };
      if (c.replay) return { ...c.replay, i: idx };
      if (c.inProgress) return { ...base, status: 'failed', source: source(), error: { code: 'in_progress', message: 'An import with this idempotency_key is still running. Retry in a moment.' } };
      key = k; // claimed by this call: released on failure below, by row id (never another caller's claim)
      claimId = c.id;
    }
    if (shared.dry_run) {
      const p = await NET.precheck(item.url, S);
      return { ...base, status: 'valid', ...p };
    }
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'writesafe-media-'));
    const tmpFile = path.join(tmpDir, 'download');
    // A claim waiting for a slot is not abandoned: refresh it before and after each wait, so a retry does not take it over.
    const touch = () => (claimId ? strapi.db.query(RECEIPT_UID).update({ where: { id: claimId }, data: { requestHash: rh } }).catch(() => {}) : null);
    await touch();
    const got = await withSlot(S.concurrency, async () => { await touch(); return NET.download(item.url, tmpFile, S); });
    const type = await sniff(tmpFile);
    if (!type) {
      // The remote server's Content-Type stays out of the message (server text only); declared_type holds it (N20).
      throw new MediaError('mime_not_allowed', 'The content type could not be detected from the file\'s bytes (declared_type is what the remote server sent). Only files whose bytes identify an allowed type are imported.', { declared_type: got.declaredType || null, allowed_types: S.allowedTypes });
    }
    const mime = type.mime;
    const uploadCfg = strapi.config.get('plugin::upload') || {};
    const sec = uploadCfg.security || {};
    if (isNever(mime) || !matchesType(mime, S.allowedTypes)
      || (Array.isArray(sec.deniedTypes) && matchesType(mime, sec.deniedTypes))
      || (Array.isArray(sec.allowedTypes) && !matchesType(mime, sec.allowedTypes))) {
      throw new MediaError('mime_not_allowed', `The file's bytes are ${mime}, which is not an allowed type.`, { detected_type: mime, declared_type: got.declaredType || null, allowed_types: S.allowedTypes });
    }
    await checkPixels(strapi, tmpFile, mime, type.ext, S.maxPixels);
    const result = await withShaClaim(strapi, got.sha256, async (refresh) => {
      const existing = await findReadableExisting(strapi, ctx, got.sha256);
      if (existing) {
        const differs = (item.alt != null && item.alt !== existing.alternativeText) || (item.caption != null && item.caption !== existing.caption);
        return view(await signed(strapi, existing), { status: 'existing', sha256: got.sha256.slice(0, 16), ...(differs ? { note: 'Same content already in the library; reused as is. Its alt text and caption were not changed: they belong to the file and show wherever it is used, so changing them (built-in media_update_asset) changes them on every page that uses it.' } : {}) });
      }
      const name = safeName(item.name, new URL(got.finalUrl).pathname, type.ext, got.sha256);
      const fileObj = { filepath: tmpFile, originalFilename: name, mimetype: mime, detectedMimeType: mime, size: got.bytes };
      const fileInfo = { name, alternativeText: item.alt ?? null, caption: item.caption ?? null, folder: shared.folderId ?? null };
      await touch();
      const created = await storeNew(strapi, ctx, { fileObj, fileInfo, sha256: got.sha256, finalUrl: got.finalUrl, bytes: got.bytes, mime },
        (up) => withSlot(S.concurrency, async () => { await touch(); await refresh(); return up(); }));
      return view({ ...(await signed(strapi, created)), folder: shared.folderId ?? null }, { status: 'created', sha256: got.sha256.slice(0, 16), ...(got.hops.length > 1 ? { redirects: got.hops.length - 1 } : {}) });
    });
    if (got.testExempt) shared.testExempt = true;
    const out = { ...base, ...result };
    // History module on: an import is a write, so it gets a receipt (listed by ws_history; ws_undo does not delete files).
    if (result.status === 'created' && require('../index').enabled().includes('history')) {
      // The file is stored already: a failure to record it is logged, never reported as a failed import.
      const rid = await require('../history').recordWrite(strapi, {
        tool: 'ws_media_import', args: shared.agent ? { agent: shared.agent } : {}, extra,
        entries: [{ uid: FILE_UID, documentId: result.ref, locale: null, op: 'import', ref: idx, src: source() }],
        reply: { ok: true, i: idx, ref: result.ref, status: 'created' },
      }).catch((e) => { strapi.log.warn(`[writesafe] media: history receipt for import item ${idx} not stored: ${e.message}`); return null; });
      if (rid) out.receipt_id = rid;
    }
    if (key) {
      const stored = { ...out, idempotency_key: ikey };
      await strapi.db.query(RECEIPT_UID).update({ where: { id: claimId }, data: { receipt: stored } });
      return stored;
    }
    return out;
  } catch (e) {
    if (claimId) await strapi.db.query(RECEIPT_UID).delete({ where: { id: claimId } }).catch(() => {});
    const err = errOf(e);
    if (err.code === 'import_failed') strapi.log.warn(`[writesafe] media import item ${idx} failed: ${(e && e.stack) || e}`);
    return { ...base, status: 'failed', source: source(), error: err };
  } finally {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runImport(strapi, ctx, extra, args) {
  const S = settings(strapi);
  await ensureIndexOnce(strapi);
  const pm = pmFor(strapi, ctx, ACTION_CREATE, FILE_UID);
  if (!pm.isAllowed) throw new MediaError('forbidden', 'This token cannot upload files (needs Media Library "create", plugin::upload.assets.create).');
  if (!S.rules.length) throw new MediaError('host_not_allowed', 'Media import is on but the allowlist is empty, so no URL can be imported. An admin must list allowed hosts in config writesafe.media.allow.');
  const items = args.items || [];
  if (items.length > S.maxItems) throw new MediaError('invalid', `At most ${S.maxItems} items per call (config writesafe.media.maxItems); send the rest in another call.`);
  if (args.folder !== undefined && args.folder_path !== undefined) throw new MediaError('invalid', 'Give folder or folder_path, not both.');
  let folderId = null;
  let folderWouldBeCreated = false;
  if (typeof args.folder === 'number') folderId = (await folderById(strapi, args.folder)).id;
  else if (args.folder_path) {
    if (args.dry_run) {
      // A dry run creates nothing: report whether the folder exists or would be created.
      try { folderId = (await folderByPath(strapi, ctx, args.folder_path, false))?.id ?? null; } catch (e) {
        if (!(e instanceof MediaError && e.code === 'folder_not_found') || args.create_folders === false) throw e;
        folderWouldBeCreated = true;
      }
    } else {
      const f = await folderByPath(strapi, ctx, args.folder_path, args.create_folders !== false);
      folderId = f ? f.id : null;
    }
  }
  const shared = { folderId, idempotency_key: args.idempotency_key, dry_run: Boolean(args.dry_run), agent: args.agent };
  const results = await pool(items, S.concurrency, (it, i) => importOne(strapi, ctx, extra, it, i, shared, S));
  const counts = { created: 0, existing: 0, failed: 0, ...(args.dry_run ? { valid: 0 } : {}) };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return {
    ok: counts.failed === 0,
    ...(counts.failed && counts.failed < results.length ? { partial: true } : {}),
    ...(args.dry_run ? { dry_run: true, written: false } : {}),
    counts,
    folder: folderId,
    ...(folderWouldBeCreated ? { folder_would_be_created: args.folder_path } : {}),
    ...(shared.testExempt ? { test_override: true } : {}),
    items: results,
    ...(results.some((r) => r.status === 'created' || r.status === 'existing')
      ? { use: 'Put an item\'s `ref` in a media field with ws_patch (set, or ops data inside components). Failed items were not imported; retry only those.' } : {}),
  };
}

// ---------------------------------------------------------------- find
/** A URL without its query and fragment: a parsed URL as net.redact stores it, else the text before ? or #. */
function stripQuery(raw) {
  try { return NET.redact(new URL(raw)); } catch { return String(raw).replace(/[?#].*$/, ''); }
}

async function runFind(strapi, ctx, args) {
  await ensureIndexOnce(strapi);
  const pm = pmFor(strapi, ctx, ACTION_READ, FILE_UID);
  if (!pm.isAllowed) throw new MediaError('forbidden', 'This token cannot read the Media Library (plugin::upload.read).');
  const and = [];
  if (args.name) and.push({ name: { $containsi: args.name } });
  if (args.alt) and.push({ alternativeText: { $containsi: args.alt } });
  if (args.mime) and.push(args.mime.includes('/') ? { mime: { $eqi: args.mime } } : { mime: { $startsWithi: `${args.mime}/` } });
  if (args.ids) and.push({ id: { $in: args.ids } });
  if (args.folder === null) and.push({ folder: null });
  else if (typeof args.folder === 'number') and.push({ folder: { id: args.folder } });
  else if (args.folder_path) {
    const f = await folderByPath(strapi, ctx, args.folder_path, false);
    and.push(f ? { folder: { id: f.id } } : { folder: null });
  }
  if (args.sha256 || args.source_url) {
    const w = {};
    if (args.sha256) w.sha256 = { $startsWith: args.sha256.toLowerCase() };
    if (args.source_url) {
      // Imports store the URL without query and fragment (net.redact), so a URL copied with them is stripped the same
      // way before matching (1.0 hardening item 9; Gemini review: it silently found nothing).
      const prefix = args.source_url.endsWith('*');
      const u = prefix ? args.source_url.slice(0, -1).replace(/[?#].*$/, '') : stripQuery(args.source_url);
      w.sourceUrl = prefix ? { $startsWith: u } : u;
    }
    const HIT_CAP = 5000;
    const hits = await strapi.db.query(INDEX_UID).findMany({ where: w, select: ['fileId'], limit: HIT_CAP + 1 });
    if (hits.length > HIT_CAP) {
      throw new MediaError('invalid', `More than ${HIT_CAP} imported files match this sha256/source_url filter; make it more specific.`);
    }
    and.push({ id: { $in: [...new Set(hits.map((h) => h.fileId))] } });
  }
  const limit = args.limit ?? 20;
  const page = args.page ?? 1;
  const q = await pm.addPermissionsQueryTo({ filters: and.length ? { $and: and } : {}, sort: 'createdAt:DESC', page, pageSize: limit, populate: { folder: { fields: ['id'] } } });
  const page0 = await strapi.plugin('upload').service('upload').findPage(q);
  const { pagination } = page0;
  const results = await Promise.all(page0.results.map((f) => signed(strapi, f)));
  const ids = results.map((r) => r.id);
  const idx = ids.length ? await strapi.db.query(INDEX_UID).findMany({ where: { fileId: { $in: ids } }, select: ['fileId', 'sha256', 'sourceUrl'] }) : [];
  const byId = new Map(idx.map((r) => [r.fileId, r]));
  return {
    total: pagination.total, page: pagination.page, pages: pagination.pageCount,
    items: results.map((f) => {
      const ix = byId.get(f.id);
      const v = view(f);
      delete v.status;
      return { ...v, alt: f.alternativeText ?? null, ...(ix ? { sha256: ix.sha256.slice(0, 16), source: ix.sourceUrl } : {}) };
    }),
  };
}

// ---------------------------------------------------------------- tools
/** Registry entry: tool definitions, built when config.modules.media is true (server/modules/index.js). */
function tools(strapi, api) {
  validateConfig(strapi.config.get('plugin::writesafe') || {});
  const L = (api && api.lenient) || { bool: (x) => x, int: (x) => x, arr: (x) => x };
  OVERRIDE = decideOverride(strapi);
  const S = settings(strapi);
  if (S.override && S.override.ignored) {
    strapi.log.warn(`[writesafe] media: WRITESAFE_MEDIA_TEST_* variables are set but IGNORED (${S.override.reason}). The SSRF guard is fully on.`);
  } else if (S.override) {
    strapi.log.warn(`[writesafe] media: TEST OVERRIDE ACTIVE (NODE_ENV=test): loopback on ports ${[...S.override.ports].join(',') || '-'} is fetchable${S.override.dnsServer ? `, *.ws-test resolved by ${S.override.dnsServer}` : ''}. Never run production like this.`);
  }
  strapi.log.info(`[writesafe] media module on: ${S.rules.length} allowlist entr${S.rules.length === 1 ? 'y' : 'ies'}, maxBytes ${S.maxBytes}, types ${S.allowedTypes.join(' ')}`);

  const item = z.object({
    url: z.string().min(1).max(2048).describe('http(s) URL of the file. Must be on the admin\'s allowlist; private and internal addresses are always refused.'),
    name: z.string().max(200).optional().describe('File name to store (the extension is set from the detected type). Default: the URL\'s last path segment.'),
    alt: z.string().max(1000).optional().describe('Alternative text.'),
    caption: z.string().max(1000).optional().describe('Caption.'),
    idempotency_key: z.string().min(8).max(200).optional().describe('Per item: a retry with the same key returns the first result instead of importing again.'),
  }).strict();

  const importTool = {
    name: 'ws_media_import',
    title: 'Write-safe: import files into the Media Library from URLs',
    description: 'Import one or more files into the Media Library by URL (the server downloads them; never send file bytes). '
      + 'Only URLs on the admin\'s allowlist; size and type limits apply and the type is detected from the bytes. '
      + 'A file whose content is already in the library is reused (status "existing") instead of duplicated. '
      + 'Each item gets a status (created, existing, failed with an error code); failed items were not imported, retry only those. '
      + 'Each imported item returns `ref`: put it in a media field with ws_patch (set, or ops data inside components). '
      + 'dry_run checks the URLs (allowlist, address) without downloading. Use ws_media_find first to reuse files already there.',
    auth: { policies: [{ action: ACTION_CREATE }] },
    resolveInputSchema: () => z.object({
      items: L.arr(z.array(item).min(1).max(S.maxItems)).describe(`1 to ${S.maxItems} files.`),
      folder: L.int(z.number().int().positive()).optional().describe('Media Library folder id to put the files in.'),
      folder_path: z.string().max(500).optional().describe('Folder by names, e.g. "Screens/Home"; missing folders are created unless create_folders is false.'),
      create_folders: L.bool(z.boolean()).optional().describe('folder_path: create missing folders (default true).'),
      idempotency_key: z.string().min(8).max(200).optional().describe('For the whole call: applied to each item together with its index and URL.'),
      dry_run: L.bool(z.boolean()).optional().describe('Check every URL (scheme, allowlist, resolved address) without downloading or storing.'),
      ...require('../index').writeArgs(z), // e.g. `agent` (history module)
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try {
        const r = await runImport(strapi, context, extra, args);
        return r.counts.failed === r.items.length ? fail(r) : ok(r);
      } catch (e) {
        return fail({ ok: false, error: errOf(e) });
      }
    },
  };

  const findTool = {
    name: 'ws_media_find',
    title: 'Write-safe: find files already in the Media Library',
    description: 'Search the Media Library before importing, to reuse a file instead of uploading it again. Filters: name, alt text, '
      + 'mime ("image" or "image/png"), folder id or folder_path, ids, sha256 (prefix of the content hash returned by ws_media_import) '
      + 'and source_url (exact, or a prefix ending in *). Returns compact rows with `ref` for media fields. Read-only.',
    auth: { policies: [{ action: ACTION_READ }] },
    resolveInputSchema: () => z.object({
      name: z.string().max(200).optional().describe('Part of the file name (case-insensitive).'),
      alt: z.string().max(200).optional().describe('Part of the alternative text.'),
      mime: z.string().max(100).optional().describe('"image" or a full type such as "image/png".'),
      folder: L.int(z.number().int().positive().nullable()).optional().describe('Folder id; null = the library root.'),
      folder_path: z.string().max(500).optional().describe('Folder by names, e.g. "Screens/Home".'),
      ids: L.arr(z.array(z.number().int().positive()).max(100)).optional().describe('File ids.'),
      sha256: z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional().describe('Content hash or a prefix of at least 8 hex characters (files imported by ws_media_import).'),
      source_url: z.string().max(2048).optional().describe('URL the file was imported from; a query or fragment is ignored (imports store the URL without them). End with * for a prefix.'),
      limit: L.int(z.number().int().min(1).max(100)).optional().describe('Default 20.'),
      page: L.int(z.number().int().min(1)).optional().describe('Page number (default 1).'),
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args }) => {
      try { return ok(await runFind(strapi, context, args)); } catch (e) { return fail({ ok: false, error: errOf(e) }); }
    },
  };
  return [importTool, findTool];
}

module.exports = {
  name: 'media',
  tools,
  // Declared by strapi-server.js (content types are static; the registry has no content-type hook).
  contentTypes: { 'media-import': indexContentType },
  validateConfig, settings,
  // for unit tests
  _internal: { safeName, matchesType, isNever, refOf, decideOverride, DEFAULTS, NEVER_TYPES, SHARP_FMT, stripQuery, checkPixels, storeNew, withShaClaim },
};
