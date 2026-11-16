'use strict';

/**
 * Plugin configuration (config/plugins.js → writesafe.config). Every key is optional.
 *
 * builtinUpdates: what happens to Strapi's own update_<type>, write_<type> and publish_<type> MCP tools for the
 *   content types this plugin covers (api:: collection and single types). Agents see those tools next to ws_patch and
 *   ws_publish and can pick the unsafe one.
 *   - 'keep':  unchanged.
 *   - 'guide': unchanged behaviour; their descriptions say what they do to lists and point to ws_patch /
 *              ws_publish.
 *   - 'guard': (default since 1.0 hardening) update_<type>/write_<type> stay listed but refuse a write that would replace a list or component
 *              field (dynamic zone, repeatable component, blocks, single component) on an existing document, and
 *              point to ws_patch; scalar, relation and media fields still go through. publish_<type> is not listed.
 *   - 'hide':  update_<type> and publish_<type> are not listed at all. write_<type> (single types) stays, but only
 *              creates: on a single type that already has content it refuses and points to ws_patch.
 * serverInstructions: true (default) adds MCP server instructions (sent in the initialize reply) that tell agents
 *   to use the ws_* tools for edits and publishes. Uses a Strapi-internal hook (see server/compat).
 * baseVersion: 'auto' (default) passes the version precondition through to Strapi's own Document Service check when
 *   the running Strapi has one (strapi/strapi#27506); 'off' never does. The plugin's own check always runs.
 * modules: { <name>: true } turns on feature modules from server/modules/<name> (their tools, hooks and row ops).
 *   history and find are on unless turned off with { history: false } / { find: false } (1.0 hardening, phase 4).
 * lenientArgs: false (default since the MWS self-test, D4; MWS-IN-6) refuses a string sent where a boolean, integer,
 *   object or array is declared, naming the argument, the type and the value. true (opt-in) accepts those values sent
 *   as strings ("true", "5", "{...}"), which some MCP clients do. The advertised schemas are the same either way.
 * retention: { keyHours: 72, jobHours: 72, claimMinutes: 60, implicitClaimMinutes: 10, pruneEverySeconds: 3600 }: how
 *   long idempotency keys, bulk jobs, unanswered claims and the implicit retry records of versioned writes stay in the
 *   receipts table (server/retention.js).
 * documentServiceLock: true (default): the Document Service lock (compat/document-lock.js); false: not registered.
 * staleFormGuard: true (default) | false | { enabled: true, otherWriters: true }: a Content Manager Save (or publish,
 *   discard) whose form was loaded before a writesafe write is merged with it, or refused with HTTP 409 when both changed
 *   the same thing, instead of overwriting the agent's change (compat/stale-form.js, rebase.js). Needs
 *   documentServiceLock. otherWriters (default true) also makes an older form refuse (409) after a write by REST,
 *   GraphQL, other plugins or review workflows; otherWriters: false gives Strapi's last-write-wins for them. false:
 *   Saves behave as in Strapi.
 * allowForce: whether agents may send `force: true` (skip the version check: last write wins) to ws_patch, ws_batch,
 *   ws_delete, ws_localize and ws_undo (server/force.js). Default: false in guard and hide, true in keep and guide (their
 *   built-in update tools already overwrite without a check). Off, the argument is not offered and is refused.
 * bulk, replace: settings of the bulk and replace modules (server/modules/_bulk/util.js). bulk.maxDocuments is 5,000 by
 *   default and may be raised up to 100,000 (a code constant); a larger value stops the start.
 * approvals: admin approval of bulk jobs above the automatic tier (server/approval/tiers.js; on by default):
 *   { enabled: true, automaticMax: null (= bulk.maxDocuments), twoApproverAbove: 25000, maxDocuments: 20000,
 *     requestTtlSeconds: 86400, approvalTtlSeconds: 3600, pendingPerToken: 5, samples: 5,
 *     escalate: { publish: false, relations: false }, requesterMayApprove: true }
 *   Hard limits (code constants): maxDocuments <= 100000; two distinct approvers always above 50000.
 * adminTokens: 'any' (default) | 'mcp-only': where Strapi accepts admin API tokens (server/compat/admin-tokens.js).
 * runner: the in-Strapi job runner (server/runner; OFF by default):
 *   { enabled: false, workers: 1, pollMs: 2000, leaseMs: 60000, heartbeatMs: 15000, chunkPauseMs: 250, killSwitch: false }
 */
const MODES = ['keep', 'guide', 'guard', 'hide'];

const defaults = {
  // guard (1.0 hardening item 4, owner decision): with guide the headline guarantee rested on the model obeying a
  // description; hide would leave no way to create a locale when the localize module is off.
  builtinUpdates: 'guard',
  serverInstructions: true,
  baseVersion: 'auto',
  lenientArgs: false,
  // 1.0 hardening item 11 (owner decision, 14 Nov): on by default.
  documentServiceLock: true,
  // bench X4: refuse a stale admin form (409) instead of letting it overwrite an agent's write; needs the lock above
  staleFormGuard: true,
  // stream G re-review A1: 'any' (Strapi's behaviour) or 'mcp-only' (admin API tokens refused on every admin route
  // but the MCP endpoint). 'any' by default: admin tokens have uses outside MCP; agents should get 'mcp-only'.
  adminTokens: 'any',
  modules: {},
};

/** The module names config.modules may use: the folders of server/modules (a leading _ marks shared code). */
const moduleFolders = () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, 'modules');
  return fs.readdirSync(dir).filter((n) => !n.startsWith('_') && fs.existsSync(path.join(dir, n, 'index.js'))).sort();
};

function validator(cfg) {
  if (cfg.builtinUpdates !== undefined && !MODES.includes(cfg.builtinUpdates)) {
    throw new Error(`writesafe.builtinUpdates must be one of ${MODES.join(', ')} (got ${JSON.stringify(cfg.builtinUpdates)})`);
  }
  if (cfg.adminTokens !== undefined && !['any', 'mcp-only'].includes(cfg.adminTokens)) {
    throw new Error(`writesafe.adminTokens must be 'any' or 'mcp-only' (got ${JSON.stringify(cfg.adminTokens)})`);
  }
  if (cfg.baseVersion !== undefined && !['auto', 'off'].includes(cfg.baseVersion)) {
    throw new Error(`writesafe.baseVersion must be 'auto' or 'off' (got ${JSON.stringify(cfg.baseVersion)})`);
  }
  if (cfg.modules !== undefined && (typeof cfg.modules !== 'object' || cfg.modules === null || Object.values(cfg.modules).some((v) => typeof v !== 'boolean'))) {
    throw new Error('writesafe.modules must be an object of booleans, e.g. { bulk: true }');
  }
  if (cfg.modules !== undefined) {
    // MWS-CFG-2 / CFG-4: a misspelled name (histroy: false, bulkk: true) refuses the start instead of being ignored
    const known = moduleFolders();
    const unknown = Object.keys(cfg.modules).filter((n) => !known.includes(n));
    if (unknown.length) {
      throw new Error(`writesafe.modules names unknown module(s): ${unknown.join(', ')} (known: ${known.join(', ')}). Fix the name; Strapi does not start with an unknown module in the list.`);
    }
  }
  if (cfg.retention !== undefined) {
    if (!cfg.retention || typeof cfg.retention !== 'object') throw new Error('writesafe.retention must be an object');
    require('./retention').configure(cfg.retention); // throws on a bad value
  }
  // bulk/replace settings (1.0 hardening item 18): the job ceiling may be raised up to the hard 100,000, not past it
  if (cfg.bulk !== undefined || cfg.replace !== undefined) require('./modules/_bulk/util').validate(cfg);
  if (cfg.approvals !== undefined) {
    if (!cfg.approvals || typeof cfg.approvals !== 'object') throw new Error('writesafe.approvals must be an object');
    const T = require('./approval/tiers');
    T.validate({ ...T.DEFAULTS, ...cfg.approvals, escalate: { ...T.DEFAULTS.escalate, ...(cfg.approvals.escalate || {}) } }, cfg.bulk && cfg.bulk.maxDocuments); // throws on a bad value
  }
  {
    // a waiting job must not be pruned before its request can expire (review finding 3)
    const T = require('./approval/tiers');
    const jobHours = cfg.retention && cfg.retention.jobHours !== undefined ? cfg.retention.jobHours : require('./retention').DEFAULTS.jobHours;
    const ttl = cfg.approvals && cfg.approvals.requestTtlSeconds !== undefined ? cfg.approvals.requestTtlSeconds : T.DEFAULTS.requestTtlSeconds;
    if (jobHours > 0 && ttl > jobHours * 3600) throw new Error(`writesafe.approvals.requestTtlSeconds (${ttl}) must be at most retention.jobHours (${jobHours} h = ${jobHours * 3600} s)`);
  }
  if (cfg.runner !== undefined) {
    if (!cfg.runner || typeof cfg.runner !== 'object') throw new Error('writesafe.runner must be an object');
    require('./runner/runner').settings(cfg.runner); // throws on a bad value
  }
  if (cfg.staleFormGuard !== undefined && typeof cfg.staleFormGuard !== 'boolean') {
    const g = cfg.staleFormGuard;
    const keys = g && typeof g === 'object' && !Array.isArray(g) ? Object.keys(g) : null;
    if (!keys || keys.some((k) => !['enabled', 'otherWriters'].includes(k)) || keys.some((k) => typeof g[k] !== 'boolean')) {
      throw new Error('writesafe.staleFormGuard must be a boolean or { enabled?: boolean, otherWriters?: boolean }');
    }
  }
  for (const k of ['serverInstructions', 'lenientArgs', 'documentServiceLock', 'allowForce']) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'boolean') throw new Error(`writesafe.${k} must be a boolean`);
  }
}

/**
 * allowForce when the config does not set it (1.0 hardening, phase 4): off where the built-in update tools are guarded
 * or hidden, so `force` would be the only unchecked overwrite left; on in keep and guide, where update_<type> overwrites
 * without a check anyway and refusing force would only push agents to it.
 */
const forceDefault = (mode) => !['guard', 'hide'].includes(mode);

/** The effective configuration (defaults filled in; allowForce resolved from builtinUpdates when not set). */
function get(strapi) {
  const c = (strapi && strapi.config && strapi.config.get('plugin::writesafe')) || {};
  const out = { ...defaults, ...c };
  out.allowForce = typeof c.allowForce === 'boolean' ? c.allowForce : forceDefault(out.builtinUpdates);
  return out;
}

module.exports = { defaults, validator, get, MODES, forceDefault };
