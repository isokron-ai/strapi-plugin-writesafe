'use strict';

/**
 * The plugin's Settings page API (Settings > Write-safe MCP in the admin panel), mounted at /writesafe/settings.
 *   GET  /settings            the effective configuration and where each value comes from (view.js)
 *   PUT  /settings/overrides  the runtime tightenings (overrides.js); { values: {} } goes back to the config file only
 * Both need an admin panel SESSION (admin API tokens are refused, as on the jobs page: an agent's token cannot read or
 * change these) and the RBAC action settings.read / settings.update (Settings > Roles > Write-safe MCP).
 */
const O = require('./overrides');
const V = require('./view');
const T = require('../approval/tiers');
const CFG = require('../config');

const ACTIONS = { read: 'plugin::writesafe.settings.read', update: 'plugin::writesafe.settings.update' };
let USER; // writesafe.config from the app's files, read once (it cannot change without a restart)

const user = (strapi) => {
  if (USER === undefined) USER = V.userConfig(strapi);
  return USER;
};
const fileState = (strapi) => {
  const cfg = CFG.get(strapi);
  return { approvals: T.settings(cfg.approvals, require('../modules/_bulk/util').settings(strapi).bulk.maxDocuments), mediaAllow: (cfg.media && cfg.media.allow) || [] };
};
const view = async (strapi) => ({ data: { ...(await V.build(strapi, { user: user(strapi) })), overrides: O.state(), refresh_seconds: O.REFRESH_MS / 1000 } });

const controller = {
  async get(ctx) {
    await O.load(strapi);
    ctx.body = await view(strapi);
  },
  async update(ctx) {
    const body = ctx.request.body || {};
    await O.load(strapi);
    // based_on (required; null when nothing was saved yet): the `at` the page showed, so another admin's save since
    // then is not overwritten unseen. Load and save are not one transaction: two saves in the same instant can race.
    if (!Object.prototype.hasOwnProperty.call(body, 'based_on')) {
      ctx.status = 400;
      ctx.body = { error: { code: 'invalid_override', message: 'based_on is required: the overrides `at` the page was loaded with (null if never changed)', key: null } };
      return;
    }
    if (body.based_on !== O.state().at) {
      ctx.status = 409;
      ctx.body = { error: { code: 'stale', message: 'Another admin changed these settings since the page was loaded. Reload and try again.' } };
      return;
    }
    let values;
    try {
      values = O.validate(body.values, fileState(strapi));
    } catch (e) {
      if (!(e instanceof O.OverrideError)) throw e;
      ctx.status = 400;
      ctx.body = { error: { code: e.code, message: e.message, key: e.key || null } };
      return;
    }
    const u = ctx.state.user;
    // the admin's name, else username; never the email (the log and the history are shown to read-only admins)
    const name = [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username || 'admin';
    await O.save(strapi, values, `${name} (${u.id})`);
    ctx.body = await view(strapi);
  },
};

const pol = (action) => ['admin::isAuthenticatedAdmin', 'plugin::writesafe.session-only', { name: 'admin::hasPermissions', config: { actions: [action] } }];
const routes = {
  type: 'admin',
  routes: [
    { method: 'GET', path: '/settings', handler: 'settings.get', config: { policies: pol(ACTIONS.read) } },
    { method: 'PUT', path: '/settings/overrides', handler: 'settings.update', config: { policies: pol(ACTIONS.update) } },
  ],
};

/** Registers the two RBAC actions and loads the overrides (plugin bootstrap). */
async function bootstrap(strapi) {
  const p = strapi.admin && strapi.admin.services && strapi.admin.services.permission;
  if (p && p.actionProvider && typeof p.actionProvider.registerMany === 'function') {
    await p.actionProvider.registerMany([
      { section: 'settings', category: 'write-safe mcp', displayName: 'Access the settings page', uid: 'settings.read', pluginName: 'writesafe' },
      { section: 'settings', category: 'write-safe mcp', displayName: 'Tighten settings at runtime', uid: 'settings.update', pluginName: 'writesafe' },
    ]);
  } else {
    strapi.log.error('[writesafe] could not register the settings permissions: the settings page is unreachable');
  }
  await O.start(strapi);
}

module.exports = { routes, controller, bootstrap, stop: O.stop, ACTIONS };
