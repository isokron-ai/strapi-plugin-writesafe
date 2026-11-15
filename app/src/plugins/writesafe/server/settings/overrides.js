'use strict';

/**
 * Runtime overrides set on the admin Settings page (plugin store). Tighten-only: config/plugins stays the source of
 * truth, and an override can only make an effective setting stricter than the file, never looser. The merge below is
 * min/max/or/and, so a stored value (even a tampered or stale one) cannot loosen anything.
 *
 *   approvals.escalate.publish / .relations   may be turned on (one approval for every bulk publish / relation edit)
 *   approvals.requesterMayApprove              may be turned off (the token's owner cannot approve its own job)
 *   approvals.approverQuietHours               may be raised, up to the hard limit
 *   approvals.automaticMax / .twoApproverAbove / .maxDocuments   may be lowered
 *   media.disabled                             entries of the config file's media.allow that are switched off
 *
 * While approvals are off in the config file (approvals.enabled false) only approvals.automaticMax is enforced (it is the
 * ceiling then), so the other approval keys are refused here and a stored one is not applied: the page never shows a
 * tightening that does not run.
 *
 * A tightening applies to jobs requested after it: a request already waiting keeps the tier and approvals it was
 * created with (an admin still has to approve it).
 *
 * Every replica re-reads the store every REFRESH_MS; the one that saved applies the change at once.
 */
const T = require('../approval/tiers');

const KEY = { type: 'plugin', name: 'writesafe', key: 'settings-overrides' };
const REFRESH_MS = 10000;
const SPEC = {
  'approvals.escalate.publish': { strict: true },
  'approvals.escalate.relations': { strict: true },
  'approvals.requesterMayApprove': { strict: false },
  'approvals.approverQuietHours': { dir: 1, min: 0, max: T.HARD.approverQuietHoursMax },
  'approvals.automaticMax': { dir: -1, min: 0 },
  'approvals.twoApproverAbove': { dir: -1, min: 0 },
  'approvals.maxDocuments': { dir: -1, min: 1 },
  'media.disabled': { list: true },
};
const isInt = Number.isSafeInteger;
// own keys only: an inherited name (constructor, toString, __proto__) is not a setting
const specOf = (key) => (Object.prototype.hasOwnProperty.call(SPEC, key) ? SPEC[key] : null);
const ST = { values: {}, by: null, at: null, log: [], timer: null, warned: false, loaded: false };
// keys that take effect while approvals are off in the config file (tierFor and ceiling use automaticMax only then)
const LIVE_WHEN_OFF = new Set(['approvals.automaticMax']);
/** Whether a key takes effect with these file approval settings (approvals.enabled false: only automaticMax). */
const applies = (key, fileApprovals) => !key.startsWith('approvals.') || !fileApprovals || fileApprovals.enabled !== false || LIVE_WHEN_OFF.has(key);

class OverrideError extends Error {
  constructor(message, key) { super(message); this.code = 'invalid_override'; this.key = key; this.status = 400; }
}

/** The file's value of a key: `file` = { approvals: T.settings(file config), mediaAllow: [...] }. */
function fileValue(file, key) {
  if (key === 'media.disabled') return [];
  return key.split('.').slice(1).reduce((o, k) => (o == null ? o : o[k]), file.approvals);
}

/** The stricter of a file value and an override value for one key. */
function stricter(key, a, b) {
  const s = specOf(key);
  if (!s || b === undefined || b === null) return a;
  if ('strict' in s) return typeof b === 'boolean' && b === s.strict ? s.strict : a;
  if (s.dir && isInt(b)) return s.dir > 0 ? Math.min(s.max, Math.max(a, b)) : Math.max(s.min, Math.min(a, b));
  return a;
}

/**
 * Checks a full set of overrides against the file config. Returns the ones that tighten (a value equal to the file's is
 * dropped as a no-op); throws OverrideError on an unknown key, a bad type or a value looser than the file.
 */
function validate(values, file) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new OverrideError('values must be an object');
  const out = {};
  for (const [key, v] of Object.entries(values)) {
    const s = specOf(key);
    if (!s) throw new OverrideError(`${key} cannot be changed at runtime (only in config/plugins)`, key);
    if (v === null || v === undefined) continue;
    if (!applies(key, file.approvals)) throw new OverrideError(`${key} has no effect while approvals are off in the config file (approvals.enabled: false); only approvals.automaticMax applies then`, key);
    if (s.list) {
      if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) throw new OverrideError(`${key} must be a list of strings`, key);
      const unknown = v.filter((e) => !file.mediaAllow.includes(e));
      if (unknown.length) throw new OverrideError(`media.disabled may only list entries of the config file's media.allow (not ${unknown.join(', ')}); hosts cannot be added at runtime`, key);
      if (v.length) out[key] = [...new Set(v)];
      continue;
    }
    const f = fileValue(file, key);
    if ('strict' in s) {
      if (typeof v !== 'boolean') throw new OverrideError(`${key} must be a boolean`, key);
      if (v !== s.strict && f === s.strict) throw new OverrideError(`${key} is ${f} in the config file; it cannot be loosened at runtime`, key);
      if (v === s.strict && f !== s.strict) out[key] = v;
      continue;
    }
    if (!isInt(v) || v < s.min || (s.max !== undefined && v > s.max)) throw new OverrideError(`${key} must be an integer from ${s.min}${s.max !== undefined ? ` to ${s.max}` : ''}`, key);
    if (s.dir < 0 ? v > f : v < f) throw new OverrideError(`${key} is ${f} in the config file; at runtime it can only be ${s.dir < 0 ? 'lowered' : 'raised'}`, key);
    if (v !== f) out[key] = v;
  }
  // two approvers above a size the automatic tier already covers would be raised back to automaticMax by the merge:
  // refuse it instead of saving a value that does not apply
  const two = out['approvals.twoApproverAbove'];
  if (two !== undefined) {
    const auto = out['approvals.automaticMax'] !== undefined ? out['approvals.automaticMax'] : fileValue(file, 'approvals.automaticMax');
    if (two < auto) throw new OverrideError(`approvals.twoApproverAbove (${two}) cannot be below approvals.automaticMax (${auto}); lower automaticMax too`, 'approvals.twoApproverAbove');
  }
  return out;
}

/** Effective approval settings: the file's (T.settings) with the overrides applied. Never throws, never loosens. */
function approvals(s, values = ST.values) {
  try {
    if (!values || !Object.keys(values).length) return s;
    // approvals off in the file: only the automatic limit is enforced, so only it is applied (and shown)
    if (!s.enabled) return { ...s, automaticMax: stricter('approvals.automaticMax', s.automaticMax, values['approvals.automaticMax']) };
    const r = { ...s, escalate: { ...s.escalate } };
    r.escalate.publish = stricter('approvals.escalate.publish', s.escalate.publish, values['approvals.escalate.publish']);
    r.escalate.relations = stricter('approvals.escalate.relations', s.escalate.relations, values['approvals.escalate.relations']);
    for (const k of ['requesterMayApprove', 'approverQuietHours', 'automaticMax', 'twoApproverAbove', 'maxDocuments']) r[k] = stricter(`approvals.${k}`, s[k], values[`approvals.${k}`]);
    // the tiers stay ordered as T.settings leaves them; never above the file's own value
    r.twoApproverAbove = Math.min(s.twoApproverAbove, Math.max(r.automaticMax, r.twoApproverAbove));
    return r;
  } catch {
    return s;
  }
}

/** The config file's media.allow without the entries switched off on the Settings page. */
function mediaAllow(allow, values = ST.values) {
  const off = (values && Array.isArray(values['media.disabled'])) ? values['media.disabled'] : [];
  return off.length ? (allow || []).filter((e) => !off.includes(e)) : (allow || []);
}

async function load(strapi) {
  try {
    const v = await strapi.store.get(KEY);
    ST.values = (v && v.values && typeof v.values === 'object' && !Array.isArray(v.values)) ? v.values : {};
    ST.by = (v && typeof v.by === 'string') ? v.by : null;
    ST.at = (v && Number.isFinite(v.at)) ? v.at : null;
    // a stored entry without a valid time is dropped (it would break the page and the periodic re-read)
    ST.log = (v && Array.isArray(v.log)) ? v.log.filter((e) => e && typeof e === 'object' && Number.isFinite(e.at)) : [];
    ST.warned = false;
    ST.loaded = true;
  } catch (e) {
    // keep the last values read: a store that cannot be read does not drop an admin's tightening. Before the first
    // successful read there are none, so this replica runs with the config file's values only until a re-read works.
    if (!ST.loaded) strapi.log.error(`[writesafe] settings overrides could not be read at startup: running with the config file's values only until a re-read (every ${REFRESH_MS / 1000} s) succeeds: ${e.message}`);
    else if (!ST.warned) strapi.log.warn(`[writesafe] settings overrides could not be read (keeping the last ones): ${e.message}`);
    ST.warned = true;
  }
  return state();
}

async function save(strapi, values, by) {
  const at = Date.now();
  const log = [...ST.log, { by, at, values }].slice(-20);
  await strapi.store.set({ ...KEY, value: { values, by, at, log } });
  Object.assign(ST, { values, by, at, log });
  strapi.log.warn(`[writesafe] settings overrides set by ${JSON.stringify(by)}: ${Object.keys(values).length ? JSON.stringify(values) : 'none (config file only)'}`);
  return state();
}

async function start(strapi) {
  await load(strapi);
  stop();
  ST.timer = setInterval(() => { load(strapi).catch(() => {}); }, REFRESH_MS);
  if (ST.timer.unref) ST.timer.unref();
}
function stop() {
  if (ST.timer) clearInterval(ST.timer);
  ST.timer = null;
}

const iso = (t) => { const d = new Date(t); return Number.isFinite(t) && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
const state = () => ({ values: ST.values, by: ST.by, at: iso(ST.at), log: ST.log.slice(-5).reverse().map((e) => ({ ...e, at: iso(e.at) })) });
/** Test hook. */
const setForTests = (values) => { ST.values = values || {}; };

module.exports = { SPEC, KEY, REFRESH_MS, OverrideError, validate, approvals, applies, mediaAllow, fileValue, load, save, start, stop, state, setForTests };
