'use strict';

/**
 * `force` as a privileged capability (1.0 hardening, phase 4; ChatGPT's review: "force as a privileged capability, not
 * a boolean"). `force: true` skips the version check of ws_patch (whole-list set), ws_batch items, ws_delete,
 * ws_localize (existing target) and ws_undo (changed since): last write wins. An admin turns it on with
 * config.allowForce; the default follows builtinUpdates (config.js): off in guard and hide, on in keep and guide,
 * where the built-in update tools already overwrite without a check.
 *
 * Off: the argument is not in any schema and no description or instruction mentions it, so agents are never offered
 * it. A call that sends it anyway is refused by the schema (the validation error says why) and, for clients that skip
 * validation, by the handler wrapper in tools.js (error.code force_disabled). Nothing is written either way.
 */
const R = require('./reply');

let ALLOWED = false;

/** Called once from tools.register with the effective config (config.get resolves the default). */
function configure(cfg) {
  ALLOWED = Boolean(cfg && cfg.allowForce === true);
  return ALLOWED;
}
const allowed = () => ALLOWED;

const DISABLED_MESSAGE = 'force is turned off on this server (writesafe config allowForce: false). Read the document with ws_get and '
  + 'send its version as expected_version (row ops need none). Overwriting someone else\'s later change needs an admin to turn '
  + 'allowForce on. Nothing was written.';

/** The `force` argument (zod shape) when allowed, {} when not. `text` says what it skips. */
function arg(z, L, text) {
  if (!ALLOWED) return {};
  return { force: L.bool(z.boolean()).optional().describe(`${text} Use only when a person asked to overwrite: it skips the check that protects other writers' changes.`) };
}

/**
 * z.object(shape).strict(), whose refusal of an unknown `force` key explains that it is turned off (zod 4: `error`;
 * zod 3, used by @strapi/utils on older Strapi 5 minors: `errorMap`).
 */
function strict(z, shape) {
  if (ALLOWED) return z.object(shape).strict();
  const why = (code, keys) => (code === 'unrecognized_keys' && Array.isArray(keys) && keys.includes('force') ? DISABLED_MESSAGE : undefined);
  if (typeof z.toJSONSchema === 'function') return z.object(shape, { error: (iss) => why(iss.code, iss.keys) }).strict();
  return z.object(shape, { errorMap: (iss, ctx) => ({ message: why(iss.code, iss.keys) || ctx.defaultError }) }).strict();
}

const truthy = (v) => v === true || v === 'true';
/** The refusal payload when `args` (or one of its batch items) asks for force while it is off; otherwise null. */
function refusal(args) {
  if (ALLOWED || !args || typeof args !== 'object') return null;
  let items = args.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = null; } }
  const asked = truthy(args.force) || (Array.isArray(items) && items.some((it) => it && typeof it === 'object' && truthy(it.force)));
  if (!asked) return null;
  return R.typed({ code: 'force_disabled', message: DISABLED_MESSAGE, retryable: false, requires_reread: true });
}

module.exports = { configure, allowed, arg, strict, refusal, DISABLED_MESSAGE };
