'use strict';

/**
 * The effective configuration for the admin Settings page: every value as the plugin uses it, and where it comes from:
 *   config   set in config/plugins (or config/env/<NODE_ENV>/plugins)
 *   default  not set; the plugin's default
 *   derived  not set; follows another setting (allowForce from builtinUpdates, automaticMax from bulk.maxDocuments),
 *            or set (or defaulted) but adjusted to fit the other limits (twoApproverAbove between automaticMax and
 *            maxDocuments); the value before the adjustment is shown next to it
 *   runtime  tightened on this page (overrides.js); the config file's value is shown next to it
 * Values are read from the same functions the plugin runs with, not re-computed here.
 */
const fs = require('fs');
const path = require('path');
const CFG = require('../config');
const T = require('../approval/tiers');
const O = require('./overrides');

const merge = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
};

/** writesafe.config as the app's config files set it (Strapi's own lookup: get-user-plugins-config), or null. */
function userConfig(strapi) {
  try {
    const dir = strapi.dirs && strapi.dirs.dist && strapi.dirs.dist.config;
    if (!dir) return null;
    const { env } = require('@strapi/utils');
    const read = (f) => {
      if (!fs.existsSync(f)) return {};
      const m = require(f);
      const v = m && m.__esModule ? m.default : m;
      return (typeof v === 'function' ? v({ env }) : v) || {};
    };
    const all = merge(read(path.join(dir, 'plugins.js')), read(path.join(dir, 'env', process.env.NODE_ENV || 'development', 'plugins.js')));
    return (all.writesafe && all.writesafe.config) || {};
  } catch {
    return null;
  }
}

// media.allow is validated (no credentials, query or fragment) only when the media module is on: with it off, an entry
// that could carry a secret (user:password@, a query or a fragment) and would not parse is hidden from settings readers
const NET = require('../modules/media/net');
const validEntry = (e) => { try { NET.parseAllowEntry(e); return true; } catch { return false; } };
const HIDDEN = '(invalid entry hidden)';
const mayHoldSecret = (e) => typeof e !== 'string' || /[@?#]/.test(e);
const shownAllow = (list) => (Array.isArray(list) ? list : []).map((e) => (mayHoldSecret(e) && !validEntry(e) ? HIDDEN : e));

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const moduleNames = () => fs.readdirSync(path.join(__dirname, '..', 'modules'))
  .filter((n) => !n.startsWith('_') && fs.existsSync(path.join(__dirname, '..', 'modules', n, 'index.js'))).sort();

const SECTIONS = [
  ['agents', 'Agents and Strapi\'s own tools', ['builtinUpdates', 'allowForce', 'serverInstructions', 'lenientArgs', 'baseVersion', 'documentServiceLock', 'staleFormGuard']],
  ['tokens', 'Admin API tokens', ['adminTokens']],
  ['modules', 'Modules', null],
  ['approvals', 'Bulk job approvals', ['approvals.enabled', 'approvals.automaticMax', 'approvals.twoApproverAbove', 'approvals.maxDocuments', 'approvals.escalate.publish', 'approvals.escalate.relations',
    'approvals.requesterMayApprove', 'approvals.approverQuietHours', 'approvals.requestTtlSeconds', 'approvals.approvalTtlSeconds', 'approvals.pendingPerToken', 'approvals.samples']],
  ['bulk', 'Bulk and replace limits', ['bulk.maxDocuments', 'bulk.chunkSize', 'bulk.maxChunkSize', 'bulk.timeBudgetMs', 'bulk.chunkTimeMs', 'bulk.paceMs', 'bulk.previewMax', 'bulk.planTtlSeconds', 'bulk.paused',
    'replace.maxScanDocuments', 'replace.regexTimeoutMs', 'replace.totalRegexMs', 'replace.chunkRegexMs', 'replace.maxPatternLength', 'replace.maxReplaceLength', 'replace.maxOutputLength', 'replace.samples']],
  ['runner', 'Job runner', ['runner.enabled', 'runner.workers', 'runner.pollMs', 'runner.leaseMs', 'runner.heartbeatMs', 'runner.chunkPauseMs', 'runner.killSwitch']],
  ['media', 'Media import', ['media.allow', 'media.allowedTypes', 'media.maxBytes', 'media.maxPixels', 'media.timeoutMs', 'media.maxRedirects', 'media.maxItems', 'media.concurrency']],
  ['history', 'History and undo', ['history.retentionDays', 'history.maxBeforeBytes', 'history.maxJobBeforeBytes', 'history.pruneEverySeconds', 'history.undo']],
  ['retention', 'Receipts retention', ['retention.keyHours', 'retention.jobHours', 'retention.claimMinutes', 'retention.implicitClaimMinutes', 'retention.longHorizonDays', 'retention.pruneEverySeconds', 'retention.journalHours']],
];
// hard limits (code constants) shown next to the values they bound
const HARD = {
  'approvals.maxDocuments': T.HARD.maxDocuments, 'approvals.twoApproverAbove': T.HARD.twoApproverAboveMax, 'approvals.approverQuietHours': T.HARD.approverQuietHoursMax,
  'approvals.requestTtlSeconds': T.HARD.requestTtlSecondsMax, 'approvals.approvalTtlSeconds': T.HARD.approvalTtlSecondsMax, 'approvals.pendingPerToken': T.HARD.pendingPerTokenMax,
  'approvals.samples': T.HARD.samplesMax, 'bulk.maxDocuments': 100000, 'replace.maxScanDocuments': 100000,
};

/**
 * deps (all optional, for tests): { control, bulk, media, history, retention, modulesOn, killSwitch, user }.
 * Returns { sections: [{ id, title, rows: [{ key, value, source, file?, hard?, editable? }] }], approvals_state, ... }.
 */
async function build(strapi, deps = {}) {
  const C = deps.control || require('../approval/control');
  const cfg = CFG.get(strapi);
  const user = deps.user !== undefined ? deps.user : userConfig(strapi);
  const bulk = deps.bulk || require('../modules/_bulk/util').settings(strapi);
  const mediaDefaults = deps.media || require('../modules/media')._internal.DEFAULTS;
  const historyDefaults = deps.history || require('../modules/history/capture').DEFAULTS;
  const fileApprovals = T.settings(cfg.approvals, bulk.bulk.maxDocuments);
  const on = deps.modulesOn || require('../modules').enabled();
  const eff = {
    ...cfg,
    approvals: C.approvalSettings(strapi),
    bulk: bulk.bulk,
    replace: bulk.replace,
    runner: C.runnerSettings(),
    media: { ...mediaDefaults, ...(cfg.media || {}), allow: shownAllow(O.mediaAllow((cfg.media && cfg.media.allow) || [])) },
    history: { ...historyDefaults, ...(cfg.history || {}) },
    retention: deps.retention || require('../retention').opts(),
  };
  const file = { approvals: fileApprovals, media: { allow: shownAllow((cfg.media && cfg.media.allow) || []) } };
  const isSet = (k) => (user ? get(user, k) !== undefined : null);
  const derived = { allowForce: () => isSet('allowForce') === false, 'approvals.automaticMax': () => get(user || cfg, 'approvals.automaticMax') == null };
  const row = (key) => {
    const value = get(eff, key);
    const fileV = get(file, key);
    const r = { key, value };
    const set = isSet(key);
    if (fileV !== undefined && JSON.stringify(fileV) !== JSON.stringify(value)) { r.source = 'runtime'; r.file = fileV; } else if (derived[key] && derived[key]()) r.source = 'derived';
    else r.source = set === null ? 'config or default' : (set ? 'config' : 'default');
    // an approval value T.settings clamped: the configured (or default) value differs from the one the plugin runs with
    if (key.startsWith('approvals.') && r.source !== 'derived') {
      const sub = key.slice('approvals.'.length);
      const raw = set ? get(user, key) : (set === false ? get(T.DEFAULTS, sub) : undefined);
      if (raw != null && fileV !== undefined && JSON.stringify(raw) !== JSON.stringify(fileV)) {
        r.adjusted = { from: raw, source: set ? 'config' : 'default' };
        if (r.source !== 'runtime') r.source = 'derived';
      }
    }
    if (HARD[key] !== undefined) r.hard = HARD[key];
    if ((O.SPEC[key] && O.applies(key, fileApprovals)) || key === 'media.allow') r.editable = true;
    return r;
  };
  const modRows = moduleNames().map((n) => {
    const set = user ? get(user, `modules.${n}`) : get(cfg, `modules.${n}`);
    return { key: `modules.${n}`, value: on.includes(n), source: set !== undefined ? 'config' : (user ? 'default' : 'config or default'), default_on: require('../modules').DEFAULT_ON.includes(n) };
  });
  const kill = deps.killSwitch !== undefined ? deps.killSwitch : await C.killSwitchState(strapi);
  return {
    sections: SECTIONS.map(([id, title, keys]) => ({ id, title, rows: keys ? keys.map(row) : modRows })),
    approvals_state: C.approvalsState(strapi),
    runner_active: C.runnerActive(),
    kill_switch: kill,
    media_file_allow: file.media.allow.filter((e) => e !== HIDDEN),
    provenance: user ? 'files' : 'unknown',
  };
}

module.exports = { build, userConfig, SECTIONS, merge };
