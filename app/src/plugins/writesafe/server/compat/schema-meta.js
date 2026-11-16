'use strict';

/**
 * Argument descriptions in tools/list when the MCP SDK's zod is another copy than @strapi/utils' (#41, second symptom).
 *
 * `.describe()` stores a description in the global registry of the zod copy that built the schema. zod 4 keeps that
 * registry on globalThis, so every zod 4 copy shares it; zod 3.25's `zod/v4` build (the `z` of @strapi/utils 5.47.0 to
 * 5.52.1) keeps its own. Strapi's MCP SDK converts input schemas with the zod it resolves itself, which on those
 * minors is typically a hoisted zod 4: its toJSONSchema reads its own registry, finds nothing, and every argument
 * description disappears from tools/list. copyMeta() adds the metadata of every node of a schema to the registries
 * that differ from ours. It runs once per built schema (server/tools.js caches them), changes nothing where the
 * registries are one, and never throws: without it the tools work, only their argument descriptions are missing.
 */
const path = require('path');
const { z } = require('@strapi/utils');

let foreign = null;

/** Global registries of the zod copies the MCP SDK may use, other than ours (resolved once found; probed again while none is). */
function registries() {
  if (foreign && foreign.length) return foreign;
  const ours = z.globalRegistry;
  const found = new Set();
  const add = (r) => { if (r && r !== ours && typeof r.add === 'function' && typeof r.has === 'function') found.add(r); };
  add(globalThis.__zod_globalRegistry); // zod 4's shared registry, when ours is zod 3.25's own
  try {
    const coreDir = path.dirname(require.resolve('@strapi/core'));
    // the SDK as compat/mcp.js loads it: @modelcontextprotocol/server (5.5x+) or @modelcontextprotocol/sdk (5.47 to 5.4x)
    for (const id of ['@modelcontextprotocol/server', '@modelcontextprotocol/sdk/server/mcp.js']) {
      let sdk;
      try { sdk = require.resolve(id, { paths: [coreDir] }); } catch { continue; }
      for (const zid of ['zod/v4/core', 'zod/v4-mini']) {
        try { add(require(require.resolve(zid, { paths: [path.dirname(sdk)] })).globalRegistry); } catch { /* not this copy */ }
      }
    }
  } catch { /* no @strapi/core here (unit tests): only globalThis */ }
  foreign = [...found];
  return foreign;
}

/** Visit every zod node of `schema` (object shapes, wrappers, pipes, unions, arrays, records, catchall). */
function walk(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (node._zod) {
    visit(node);
    const def = node._zod.def || {};
    for (const k of Object.keys(def)) walk(def[k], visit, seen);
    return;
  }
  if (Array.isArray(node)) { for (const v of node) walk(v, visit, seen); return; }
  if (Object.getPrototypeOf(node) === Object.prototype) for (const k of Object.keys(node)) walk(node[k], visit, seen);
}

/** Copy our registry's metadata of every node of `schema` into `targets` (default: the foreign registries). */
function copyMeta(schema, targets = registries(), source = z.globalRegistry) {
  if (!targets.length || !source || typeof source.get !== 'function') return schema;
  try {
    walk(schema, (s) => {
      const meta = source.get(s);
      if (!meta) return;
      for (const r of targets) if (!r.has(s)) r.add(s, meta);
    });
  } catch { /* descriptions are best effort; the schema itself is unchanged */ }
  return schema;
}

module.exports = { copyMeta, registries, walk };
