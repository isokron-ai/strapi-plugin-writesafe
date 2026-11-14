'use strict';

/**
 * baseVersion compatibility path.
 *
 * Strapi's draft PR strapi/strapi#27506 adds an optional `baseVersion` (an updatedAt ISO string) to
 * `strapi.documents(uid).update()`. On a draft & publish type, the update locks the row, compares, and throws
 * `errors.ConflictError` (HTTP 409) when the row's updatedAt differs. Types without draft & publish ignore it.
 *
 * This adapter feature-detects that check at bootstrap and, when present, passes the version the plugin has just
 * verified under its own row lock through to Strapi, so both checks agree, and maps Strapi's ConflictError to the
 * plugin's `version_conflict`. The plugin's own check (updatedAt plus a content hash) always runs first: it also
 * covers changes that keep updatedAt, which Strapi's timestamp-only check cannot see. Nothing here is required: on
 * Strapi 5.62.0 the probe finds no support and update() is called exactly as before.
 *
 * Detection: a no-op update (a documentId that cannot exist) with an invalid baseVersion, inside a transaction that is
 * always rolled back. A Strapi with the check refuses it with "baseVersion must be a valid ISO timestamp"; one without
 * ignores the key (or, with api.documents.strictParams, refuses it as an unknown key, which also means "no support").
 */
const { errors } = require('@strapi/utils');
const C = require('./index');

const state = { supported: false, reason: 'not probed' };

class BaseVersionConflict extends Error {
  constructor(cause) {
    super('Strapi reported a base version conflict');
    this.name = 'BaseVersionConflict';
    this.cause = cause;
    this.details = cause?.details || {};
  }
}

const isConflictError = (e) => Boolean(e) && (e.name === 'ConflictError' || (typeof errors.ConflictError === 'function' && e instanceof errors.ConflictError));

class Rollback extends Error {}

/** Probe the running Strapi. mode: 'auto' | 'off'. Sets and returns the state. */
async function detect(strapi, mode = 'auto') {
  if (mode === 'off') return set(false, 'disabled by config (baseVersion: off)');
  // No ConflictError in @strapi/utils means no #27506: skip the probe, so a Strapi without the check never sees the
  // probe call (it runs the Document Service middleware chain, whose side effects a rollback cannot undo).
  if (typeof errors.ConflictError !== 'function') return set(false, '@strapi/utils has no ConflictError (no baseVersion support); not probed');
  const dp = Object.values(strapi.contentTypes || {}).find((ct) => ct.uid.startsWith('api::') && ct.options?.draftAndPublish);
  if (!dp) return set(false, 'no draft & publish content type to probe with');
  let outcome;
  try {
    await strapi.db.transaction(async () => {
      try {
        await strapi.documents(dp.uid).update({ documentId: '__writesafe_probe_does_not_exist__', baseVersion: 'not-a-timestamp', data: {} });
        outcome = { supported: false, reason: 'baseVersion ignored by the Document Service' };
      } catch (e) {
        if (/baseVersion/.test(e?.message || '') && /valid ISO|timestamp/i.test(e?.message || '')) outcome = { supported: true, reason: 'Document Service validates baseVersion' };
        else outcome = { supported: false, reason: `baseVersion not accepted (${e?.name || 'error'}: ${String(e?.message || e).slice(0, 120)})` };
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) outcome = { supported: false, reason: `probe failed: ${e.message}` };
  }
  return set(outcome.supported, outcome.reason);
}

function set(supported, reason) {
  state.supported = supported;
  state.reason = reason;
  C.note('documents.base_version', true, `${supported ? 'supported' : 'not supported'}: ${reason}`);
  return { ...state };
}

/** Turn the passthrough off at runtime (Strapi's check disagreed with a version verified under the plugin's lock). */
const disable = (reason) => set(false, reason);

/** Test hook: force the detected state (unit tests with a stub Document Service). */
const force = (supported, reason = 'forced') => set(supported, reason);

/**
 * strapi.documents(uid).update(params), with `baseVersion` added when the running Strapi supports it and the type has
 * draft & publish. A ConflictError from Strapi is rethrown as BaseVersionConflict (the engine turns it into
 * version_conflict with the current state).
 */
async function update(strapi, uid, params, { baseVersion, draftAndPublish } = {}) {
  const p = state.supported && baseVersion && draftAndPublish ? { ...params, baseVersion } : params;
  try {
    return await strapi.documents(uid).update(p);
  } catch (e) {
    if (isConflictError(e)) throw new BaseVersionConflict(e);
    throw e;
  }
}

module.exports = { detect, update, force, disable, state, isConflictError, BaseVersionConflict };
