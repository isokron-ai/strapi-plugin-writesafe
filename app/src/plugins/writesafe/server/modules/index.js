'use strict';

/**
 * Module registry: optional feature modules (bulk, l10n, media, ...) plug into the core without editing it.
 * Design notes: docs/internals.md, section "server/modules/index.js".
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
