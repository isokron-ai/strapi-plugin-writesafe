'use strict';

/**
 * MCP server internals: built-in tool interception, server instructions, the request's Authorization header.
 * See compat/index.js for the version table.
 */
const path = require('path');
const C = require('./index');

// create and delete since phase 2 item 13 (fourth review N21): with ws_create / ws_delete on, the unversioned built-ins
// were listed with no word about them.
const BUILTIN_OPS = ['update', 'write', 'publish', 'discard_draft', 'unpublish', 'create', 'delete'];
const READ_OPS = ['list', 'get'];
const FAIL_CLOSED = new Set(['guard', 'hide']);

/**
 * A definition that comes from content-manager: its telemetry says so, or (telemetry gone in some Strapi minor) it has
 * no telemetry, a content-manager permission and content-manager's naming (<op>_<type>, discard_<type>_draft). Other
 * plugins' tools that reuse content-manager permissions (they carry their own telemetry, or another name) and the
 * plugin's own ws_* tools never count (review finding 2).
 */
const CM_NAME = /^(list|get|create|update|write|delete|publish|unpublish)_[a-z0-9_-]+$|^discard_[a-z0-9_-]+_draft$/;
const isCmDef = (def) => {
  if (!def || /^ws_/.test(def.name || '')) return false;
  if (def.telemetry) return def.telemetry.source === 'content-manager';
  return CM_NAME.test(def.name || '') && ((def.auth && def.auth.policies) || []).some((p) => typeof p.action === 'string' && p.action.startsWith('plugin::content-manager.explorer.'));
};
const subjectsOf = (def) => [...new Set(((def && def.auth && def.auth.policies) || []).map((p) => p.subject))];

/**
 * { uid, op } when `def` is one of content-manager's update_/write_/publish_<type> tools for a covered uid.
 * Matched on the definition's own metadata (telemetry and auth subject), never on the tool name alone.
 */
function matchBuiltin(def, coveredUids) {
  const t = def && def.telemetry;
  if (!t || t.source !== 'content-manager' || !BUILTIN_OPS.includes(t.name)) return null;
  const subjects = [...new Set(((def.auth && def.auth.policies) || []).map((p) => p.subject))];
  if (subjects.length !== 1 || !coveredUids.includes(subjects[0])) return null;
  return { uid: subjects[0], op: t.name };
}

/**
 * Wrap strapi.ai.mcp.registerTool so content-manager's definitions pass through `rewrite(def, match)` first.
 * rewrite returns the definition to register (the same, or a changed copy) or null to leave the tool out.
 * Must run in the plugin's register(): content-manager registers its tools in bootstrap, after every register().
 * Returns the list of intercepted tools (filled during bootstrap); seen.cm counts every content-manager definition of a
 * covered type that came through, seen.unknown names those whose operation this adapter does not know.
 * Fails closed (phase 2 item 13): in guard and hide, a wrap that does not hold is an error that stops Strapi, not a
 * silent fallback to keep.
 */
function interceptBuiltinTools(strapi, coveredUids, rewrite, mode) {
  const seen = [];
  // counters kept off the list itself (non-enumerable): the list is what the compat report and the log show
  Object.defineProperty(seen, 'cm', { value: 0, writable: true, enumerable: false });
  Object.defineProperty(seen, 'unknown', { value: [], enumerable: false });
  const mcp = strapi.ai && strapi.ai.mcp;
  if (!mcp || typeof mcp.registerTool !== 'function') {
    // No MCP server at all: no built-in tool is exposed either, so there is nothing to guard.
    C.note('mcp.intercept_builtin_tools', false, 'strapi.ai.mcp.registerTool missing');
    return seen;
  }
  const original = mcp.registerTool;
  const wrapped = function registerTool(def) {
    const covered = typeof coveredUids === 'function' ? coveredUids() : coveredUids;
    const m = matchBuiltin(def, covered);
    if (!m && isCmDef(def) && subjectsOf(def).some((u) => covered.includes(u))) {
      seen.cm += 1;
      const op = def.telemetry && def.telemetry.name;
      if (!READ_OPS.includes(op)) seen.unknown.push(def.name);
    }
    if (!m) return original.call(this, def);
    seen.cm += 1;
    const out = rewrite(def, m);
    seen.push({ name: def.name, uid: m.uid, op: m.op, result: out == null ? 'hidden' : out === def ? 'unchanged' : 'changed' });
    if (out == null) return undefined;
    return original.call(this, out);
  };
  mcp.registerTool = wrapped;
  C.intercepted = seen;
  // strapi.ai.mcp is resolved from the container on every access: check it is one object, or the wrap is lost.
  const same = strapi.ai.mcp.registerTool === wrapped;
  C.note('mcp.intercept_builtin_tools', same, same ? 'registerTool wrapped' : 'strapi.ai.mcp is not a stable object; wrap lost');
  if (!same && FAIL_CLOSED.has(mode)) {
    throw new Error(`[writesafe] builtinUpdates=${mode} cannot be enforced on this Strapi: strapi.ai.mcp.registerTool could not be wrapped, so Strapi's `
      + 'update_/publish_/delete_<type> tools would be listed unguarded. Strapi was stopped instead (fail closed). Set builtinUpdates to \'guide\' or '
      + '\'keep\' to run without the guard, and see the compat report (scripts/compat_check.mjs).');
  }
  return seen;
}

/**
 * Fail closed before the MCP server starts (phase 2 item 13): in guard and hide, if no content-manager tool of a covered
 * type came through the intercept (content-manager registers them some other way now), or one came through with an
 * operation this adapter does not know, the guard cannot be what it says. Then the MCP server is not started (Strapi's
 * MCP provider logs the error; the rest of Strapi runs), instead of serving the built-in tools unguarded.
 * Strapi starts the MCP server in its provider bootstrap, after every plugin's bootstrap (content-manager's included).
 */
function failClosedStart(strapi, seen, mode, coveredUids) {
  const mcp = strapi.ai && strapi.ai.mcp;
  if (!FAIL_CLOSED.has(mode) || !mcp || typeof mcp.start !== 'function') return false;
  const original = mcp.start;
  mcp.start = async function start(...args) {
    const covered = typeof coveredUids === 'function' ? coveredUids() : coveredUids;
    let problem = null;
    if (covered.length && !seen.cm) problem = 'no content-manager MCP tool of a covered content type came through registerTool (registration moved?)';
    else if (seen.unknown.length) problem = `content-manager tool(s) ${seen.unknown.join(', ')} have an operation this version of writesafe does not know`;
    if (problem) {
      C.note('mcp.intercept_builtin_tools', false, `${problem}; MCP server not started (builtinUpdates=${mode})`);
      const msg = `[writesafe] MCP server not started: builtinUpdates=${mode} cannot be enforced (${problem}). Serving the built-in tools unguarded `
        + 'would break what guard/hide promise. Set builtinUpdates to \'guide\' or \'keep\' to serve them anyway, and see the compat report.';
      strapi.log.error(msg);
      throw new Error(msg);
    }
    return original.apply(this, args);
  };
  return strapi.ai.mcp.start === mcp.start;
}

/** After bootstrap: did content-manager's tools come through the wrapper? */
function confirmIntercept(strapi, seen, mode) {
  if (!strapi.ai?.mcp?.isEnabled?.()) return;
  if (C.status['mcp.intercept_builtin_tools'] && C.status['mcp.intercept_builtin_tools'].ok === false && /not started/.test(C.status['mcp.intercept_builtin_tools'].detail)) return;
  const ok = seen.length > 0;
  C.note('mcp.intercept_builtin_tools', ok, ok ? `${seen.length} built-in tools matched (${mode})` : 'no content-manager tool came through registerTool (registration moved?)');
  if (!ok && mode !== 'keep') strapi.log.warn(`[writesafe] builtinUpdates=${mode} had no effect: content-manager's MCP tools were not seen (see compat report)`);
}

let sdkModule = null;
function loadSdk() {
  if (sdkModule) return sdkModule;
  const coreDir = path.dirname(require.resolve('@strapi/core'));
  // Strapi 5.5x+ builds its server from @modelcontextprotocol/server; 5.47 to 5.4x from the older
  // @modelcontextprotocol/sdk (server/mcp.js). Both read McpServer from the module object per request (CI matrix).
  try {
    sdkModule = require(require.resolve('@modelcontextprotocol/server', { paths: [coreDir] }));
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e; // a module that fails to load is reported, not silently swapped
    try {
      sdkModule = require(require.resolve('@modelcontextprotocol/sdk/server/mcp.js', { paths: [coreDir] }));
    } catch (e2) {
      throw new Error(`${e.message}; fallback: ${e2.message}`);
    }
  }
  return sdkModule;
}

/**
 * Give every MCP server Strapi builds the given instructions (unless Strapi sets its own). Strapi builds a new
 * McpServer per POST from the SDK module's export, so replacing that export with a subclass is enough.
 */
function installServerInstructions(strapi, getText) {
  let sdk;
  try {
    sdk = loadSdk();
  } catch (e) {
    C.note('mcp.server_instructions', false, `neither @modelcontextprotocol/server nor @modelcontextprotocol/sdk resolvable from @strapi/core: ${e.message}`);
    return false;
  }
  const desc = Object.getOwnPropertyDescriptor(sdk, 'McpServer');
  if (!desc || typeof sdk.McpServer !== 'function' || !(desc.writable || desc.set)) {
    C.note('mcp.server_instructions', false, 'McpServer export missing or read-only');
    return false;
  }
  const Base = sdk.McpServer.__writesafeBase || sdk.McpServer;
  class McpServerWithInstructions extends Base {
    constructor(info, options) {
      const text = options && options.instructions ? null : getText();
      super(info, text ? { ...(options || {}), instructions: text } : options);
      if (text) observeInitialize(this, text);
    }
  }
  McpServerWithInstructions.__writesafeBase = Base;
  sdk.McpServer = McpServerWithInstructions;
  // Not ok yet (fourth review N22): replacing the export proves nothing until an initialize reply carries the text.
  C.note('mcp.server_instructions', null, 'McpServer export replaced; no initialize reply seen yet');
  return true;
}

/**
 * Watch the initialize replies of one server (phase 2 item 13, N22): the probe is ok only once a reply really carried
 * the instructions, and fails when a reply goes out without them. Both SDK lines (@modelcontextprotocol/server and
 * @modelcontextprotocol/sdk) answer initialize from Server._oninitialize, looked up on the instance at call time.
 */
function observeInitialize(server, text) {
  const low = server && server.server;
  if (!low || typeof low._oninitialize !== 'function') {
    C.note('mcp.server_instructions', false, 'cannot observe initialize replies (MCP SDK Server._oninitialize not found)');
    return;
  }
  const orig = low._oninitialize;
  low._oninitialize = async function oninitialize(...args) {
    const reply = await orig.apply(this, args);
    const ok = Boolean(reply && reply.instructions === text);
    const st = C.status['mcp.server_instructions'];
    if (!st || st.ok !== ok) C.note('mcp.server_instructions', ok, ok ? 'an initialize reply carried the instructions' : 'an initialize reply went out WITHOUT the instructions');
    return reply;
  };
}

/**
 * End-to-end instructions probe, in process (compat_check): build an MCP server the way Strapi does (from the SDK
 * module's export) and answer one initialize request. ok when the reply carries the instructions.
 */
async function probeInstructions() {
  try {
    const sdk = loadSdk();
    const server = new sdk.McpServer({ name: 'writesafe-compat-probe', version: '0' }, { capabilities: { tools: {} } });
    if (!server.server || typeof server.server._oninitialize !== 'function') return { ok: false, detail: 'MCP SDK Server._oninitialize not found' };
    const reply = await server.server._oninitialize({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'writesafe-compat-probe', version: '0' } } });
    const ok = Boolean(reply && typeof reply.instructions === 'string' && reply.instructions.length);
    return { ok, detail: ok ? 'initialize reply carries the instructions' : 'initialize reply has no instructions' };
  } catch (e) {
    return { ok: false, detail: `initialize probe failed: ${e.message}` };
  }
}

let warnedAuth = false;
/** The Bearer header of the MCP request (for per-token idempotency scope), or null. */
function authHeader(strapi, extra) {
  const a = extra && extra.requestInfo && extra.requestInfo.headers && extra.requestInfo.headers.authorization;
  if (a) {
    if (!C.status['mcp.request_auth_header']) C.note('mcp.request_auth_header', true, 'authorization header seen');
    return a;
  }
  if (!warnedAuth) {
    warnedAuth = true;
    C.note('mcp.request_auth_header', false, 'extra.requestInfo.headers.authorization missing');
    // Callers pass strapi = null; Strapi sets global.strapi. Since phase 1 (item 7) keys and jobs are refused, not
    // scoped per user, when there is no header.
    const log = (strapi || global.strapi)?.log;
    log?.warn('[writesafe] MCP handler context has no Authorization header: idempotency_key and jobs are refused (no per-token identity)');
  }
  return null;
}

module.exports = {
  loadSdk, matchBuiltin, interceptBuiltinTools, failClosedStart, confirmIntercept, installServerInstructions, probeInstructions, authHeader, BUILTIN_OPS,
};
