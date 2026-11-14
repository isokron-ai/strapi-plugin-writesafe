'use strict';

/**
 * Where admin API tokens are accepted (config writesafe.adminTokens; stream G re-review A1).
 *
 * Strapi 5.47+ admin API tokens ("Admin tokens") are what MCP clients use, and Strapi also accepts them on every
 * admin route ("programmatically access the admin features", its Settings page says): /content-manager (edits,
 * bulkPublish, bulkDelete), /admin/users, /admin/admin-tokens, and this plugin's own routes. Admin tokens authenticate
 * on every admin route by default; restricting agent tokens to the MCP endpoint keeps them inside writesafe's
 * guarantees (least privilege: an agent needs MCP, not the rest of the admin API).
 *
 *   'any'      (default)  Strapi's behaviour: admin tokens work on every admin route. Admin tokens have uses outside
 *                         MCP (scripts calling the admin API), so the plugin does not take that away by itself.
 *   'mcp-only'            admin-token authentication is refused (403) on every admin route; Strapi's MCP endpoint
 *                         authenticates tokens itself (not through the admin auth strategies) and keeps working.
 *                         Recommended whenever the tokens are held by agents.
 *
 * How: the admin-token strategy is identified after authentication by its name (`admin-token`, the strategy Strapi
 * records in ctx.state.auth), by wrapping strapi.get('auth').authenticate, which every admin route calls per request
 * (compose-endpoint, 5.47.1 to 5.62.0). Asked for and not installable, it stops Strapi (fail closed).
 */
const C = require('./index');

const MODES = ['any', 'mcp-only'];
const STATE = { mode: 'any', installed: false };

function refuse(ctx) {
  ctx.state.isAuthenticated = false;
  ctx.state.auth = undefined;
  ctx.status = 403;
  ctx.body = { data: null, error: { status: 403, name: 'ForbiddenError', message: 'Admin API tokens are accepted only by the MCP endpoint on this server (writesafe.adminTokens: "mcp-only"). Sign in to the admin panel instead.', details: { code: 'admin_token_mcp_only' } } };
}

function install(strapi, mode = 'any') {
  if (!MODES.includes(mode)) throw new Error(`writesafe.adminTokens must be one of ${MODES.join(', ')} (got ${JSON.stringify(mode)})`);
  STATE.mode = mode;
  if (mode === 'any') return false;
  let auth = null;
  try { auth = strapi.get('auth'); } catch { auth = null; }
  if (!auth || typeof auth.authenticate !== 'function') {
    C.note('admin.token_restriction', false, "strapi.get('auth').authenticate not found");
    throw new Error('[writesafe] adminTokens is "mcp-only" but the admin authentication service cannot be wrapped on this Strapi: refusing to start rather than accept admin tokens everywhere');
  }
  if (auth.__writesafeAdminTokens) return true;
  const original = auth.authenticate;
  auth.authenticate = async function authenticate(ctx, next) {
    return original.call(this, ctx, async () => {
      const name = ctx.state && ctx.state.auth && ctx.state.auth.strategy && ctx.state.auth.strategy.name;
      if (STATE.mode === 'mcp-only' && name === 'admin-token') return refuse(ctx);
      return next();
    });
  };
  auth.__writesafeAdminTokens = true;
  STATE.installed = true;
  C.note('admin.token_restriction', true, 'admin-token authentication refused on admin routes (mcp-only)');
  strapi.log.info('[writesafe] adminTokens "mcp-only": admin API tokens work only on the MCP endpoint');
  return true;
}

const mode = () => STATE.mode;

module.exports = { install, mode, MODES };
