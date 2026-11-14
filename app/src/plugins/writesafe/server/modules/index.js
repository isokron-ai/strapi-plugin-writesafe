'use strict';

/**
 * Module registry: optional feature modules (bulk, l10n, media, ...) plug into the core without editing it.
 *
 * A module is a folder `server/modules/<name>/index.js` exporting:
 *
 *   {
 *     name: 'bulk',                                   // must equal the folder name; config.modules.<name> turns it on
 *     tools: (strapi, api) => [definition, ...],      // MCP tool definitions (same shape as tools.js uses for
 *                                                     // strapi.ai.mcp.registerTool); registered only when enabled
 *     hooks: {                                        // all optional; called for every ws_patch/ws_publish/ws_batch item
 *       beforeWrite: async (ctx, info) => {},         // inside the write transaction, after the version check and before
 *                                                     // the write; throw api.WsError({code, message}) to refuse
 *       afterWrite: async (ctx, info, before, after) => data,   // inside the transaction, after the write; `before` and
 *                                                     // `after` are the normalized drafts (relations as documentIds).
 *                                                     // A non-undefined return is put in receipt.modules[<name>]
 *     },
 *     ops: {                                          // extra row ops for ws_patch `ops` (e.g. copy)
 *       copy: {
 *         schema: { from: z.string().optional() },    // extra op properties (zod shape), merged into the op schema
 *         apply: (opCtx) => {},                       // see engine.applyRowOps: mutate opCtx.work, push keys to opCtx.summary
 *       },
 *     },
 *   }
 *
 * ctx is the MCP handler context ({ userAbility, user }). info is
 *   { tool, action: 'patch' | 'publish', uid, documentId, locale, args, dryRun,
 *     data,               // patch: the sanitized payload about to be written (beforeWrite may inspect, not change it)
 *     sanitize(doc),      // the token's read view of a raw document (hidden fields removed)
 *     raw: { before, after } }  // the FULL normalized drafts, hidden fields included: for data a module keeps to itself
 *   afterWrite's `before`/`after` arguments are the token's view (hidden fields removed), because whatever afterWrite
 *   returns is shown to the caller in receipt.modules and replayed on idempotent retries. Never copy info.raw into the
 *   return value.
 *   Batches: hooks run per item (info.tool 'ws_batch'); their returns are in the reply's items[].modules (and so in a
 *   stored idempotent receipt).
 *   Module tools that write documents (ws_localize, ws_undo, ws_create, ws_delete, ws_bulk, ...) run through
 *   api.runWrite and report each write with MOD.afterWrite(ctx, { action: 'patch' | 'create' | 'delete' | 'publish',
 *   tool, uid, documentId, locale, args, dryRun }, before, after) (before null = created, after null = deleted), so the
 *   history module records them like the core's own writes.
 * opCtx is { strapi, uid, field, attr, kind, work, op, index, where, refs, summary, find(key) -> i,
 *   resolvePos(pos) -> i, newKey() -> 'new:n', checkComponentData(cuid, data), WsError }.
 *   `work` is the list being edited: entries { key, row, isNew }. A new row must be pushed with isNew: true and a
 *   key from newKey() (the receipt maps it to its final key). After all ops the core strips `id` from new rows, refuses
 *   an existing row that appears twice, and checks field permissions on every changed sub-field, so a copy op cannot
 *   share or leak a row.
 *
 * `api` (second argument of tools) exposes the engine so module tools reuse its transaction, idempotency, version and
 * permission handling: see apiFor() below.
 *
 * Optional module exports besides tools/hooks/ops:
 *   hooks.aroundWrite(meta, next)  wraps every write run (inside its transaction); must return await next() (possibly
 *                                  extended). meta = { strapi, ctx, extra, tool, args, key }. Used by history.
 *   writeArgs(z) -> zod shape      extra top-level arguments for ws_patch, ws_publish, ws_batch (e.g. history's `agent`)
 *   contentTypes                   { <singularName>: { schema } }, declared for every module folder, on or off
 *
 * Receipts (plugin::writesafe.receipt, one schema for the core and every module; see strapi-server.js):
 *   key, requestHash, tool, receipt   the core's idempotency record (rows exist for writes with an idempotency_key)
 *   targets                          "|<uid>~<documentId>~<locale>|...|" of every document the write touched
 *   receiptId, tokenId, agent         filled by the history module, which adds a row ("h:<receiptId>" key) for every
 *                                    write without an idempotency key, in the write's own transaction
 *   moduleData                       modules' own records keyed by module name, e.g. moduleData.history
 */
const fs = require('fs');
const path = require('path');

let loaded = [];
let extraForTests = null;

function discover() {
  const dir = __dirname;
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'index.js');
    if (!fs.existsSync(file)) continue;
    const mod = require(file);
    if (!mod || mod.name !== name) throw new Error(`[writesafe] module folder ${name} must export name: '${name}'`);
    out.push(mod);
  }
  return out;
}

/**
 * Modules that are on unless config.modules turns them off by name (`history: false`). Every other module is off unless
 * config.modules turns it on. history (1.0 hardening, phase 4; reviews: "history on by default, or its opt-in made
 * unmissable"): every ws_* write gets a receipt_id and ws_undo works without a config change first. find (phase 4,
 * Design H): read-only and stores nothing; it replaces the built-in list_<type> call every job started with.
 */
const DEFAULT_ON = ['history', 'find'];
const isOn = (on, name) => on[name] === true || (DEFAULT_ON.includes(name) && on[name] !== false);

/** Load the modules that config.modules turns on (and the DEFAULT_ON ones it does not turn off). Returns their names. */
function load(strapi, cfg) {
  const on = (cfg && cfg.modules) || {};
  const all = extraForTests || discover();
  loaded = all.filter((m) => isOn(on, m.name));
  ops(); // fail at startup, not at the first request, on a clashing op name or schema key
  // also for `false`: a typo in an opt-out (history: false spelled wrong) would otherwise leave the module on silently
  const unknown = Object.keys(on).filter((n) => !all.some((m) => m.name === n));
  if (unknown.length && strapi) strapi.log.warn(`[writesafe] config.modules names unknown module(s): ${unknown.join(', ')} (known: ${all.map((m) => m.name).join(', ')})`);
  return loaded.map((m) => m.name);
}

/** Tool definitions of every enabled module. */
function tools(strapi, api) {
  return loaded.flatMap((m) => (typeof m.tools === 'function' ? m.tools(strapi, api) || [] : []));
}

/**
 * [l10n/history] Wraps one write run (runOnce, inside its transaction): every enabled module with
 * hooks.aroundWrite(meta, next) is called with meta = { ctx, extra, tool, args, key, strapi } and must return
 * await next() (possibly changed). Used by the history module to collect before-images for every ws_* write and store
 * one receipt row per write. Without such modules this is just fn().
 */
function aroundWrite(meta, fn) {
  const chain = loaded.filter((m) => m.hooks && m.hooks.aroundWrite)
    .reduceRight((next, m) => () => m.hooks.aroundWrite(meta, next), fn);
  return chain();
}

/** [l10n/history] Extra top-level arguments (zod shape) that enabled modules add to ws_patch, ws_publish and ws_batch. */
function writeArgs(z) {
  return Object.assign({}, ...loaded.map((m) => (typeof m.writeArgs === 'function' ? m.writeArgs(z) || {} : {})));
}

async function beforeWrite(ctx, info) {
  for (const m of loaded) if (m.hooks && m.hooks.beforeWrite) await m.hooks.beforeWrite(ctx, info);
}

/** Runs afterWrite of every module; returns { <name>: data } for the receipt, or undefined. */
async function afterWrite(ctx, info, before, after) {
  let out;
  for (const m of loaded) {
    if (!m.hooks || !m.hooks.afterWrite) continue;
    const r = await m.hooks.afterWrite(ctx, info, before, after);
    if (r !== undefined) (out = out || {})[m.name] = r;
  }
  return out;
}

/** Extra row ops: name -> { schema, apply }. Built-in names cannot be overridden. */
const BUILTIN_OPS = ['add', 'update', 'remove', 'move'];
const CORE_OP_KEYS = ['op', 'field', 'key', 'component', 'data', 'position'];
function ops() {
  const out = {};
  for (const m of loaded) {
    for (const [name, def] of Object.entries(m.ops || {})) {
      if (BUILTIN_OPS.includes(name)) throw new Error(`[writesafe] module ${m.name} cannot redefine row op ${name}`);
      if (out[name]) throw new Error(`[writesafe] row op ${name} defined by two modules`);
      const clash = Object.keys(def.schema || {}).filter((k) => CORE_OP_KEYS.includes(k)
        || Object.values(out).some((o) => o.schema && k in o.schema));
      if (clash.length) throw new Error(`[writesafe] row op ${name} (module ${m.name}) redefines op properties ${clash.join(', ')}`);
      if (typeof def.apply !== 'function') throw new Error(`[writesafe] row op ${name} (module ${m.name}) has no apply()`);
      out[name] = { ...def, module: m.name };
    }
  }
  return out;
}

/**
 * Content types declared by modules (`contentTypes: { <singularName>: { schema } }`), from every module folder whether
 * it is on or not: Strapi needs them before config decides which modules run, and a table of a module that is off
 * stays empty. Names are plugin-scoped (plugin::writesafe.<name>); two modules may not declare the same one.
 */
function contentTypes() {
  const out = {};
  for (const m of discover()) {
    for (const [name, ct] of Object.entries(m.contentTypes || {})) {
      if (name === 'receipt' || out[name]) throw new Error(`[writesafe] content type ${name} declared twice (module ${m.name})`);
      out[name] = ct;
    }
  }
  return out;
}

/** Test hook: use these module objects instead of the folders. */
function setModulesForTests(mods) { extraForTests = mods; }

const enabled = () => loaded.map((m) => m.name);
/** Does an enabled module have an afterWrite hook? Writers skip building the module views otherwise (find has none). */
const hasAfterWrite = () => loaded.some((m) => m.hooks && typeof m.hooks.afterWrite === 'function');

module.exports = { load, tools, contentTypes, aroundWrite, writeArgs, beforeWrite, afterWrite, ops, enabled, hasAfterWrite, setModulesForTests, BUILTIN_OPS, DEFAULT_ON };
