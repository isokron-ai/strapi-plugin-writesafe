'use strict';

/**
 * Admin API tokens, outside an MCP request (1.0 hardening, Phase 4 stream G): who asked for a job, and what that token
 * may do now. Strapi internals used (all present and identical in 5.47.1 to 5.62.0):
 *   strapi.admin.services['api-token-admin'].hash(accessKey)        HMAC-SHA512 with admin.apiToken.salt
 *   strapi.admin.services['api-token-admin'].getById(id)            kind 'admin' only; adminPermissions, adminUserOwner
 *   strapi.admin.services.permission.engine.generateTokenAbility(permissions, owner)
 * That is exactly what Strapi's MCP authentication does per request (authenticateAdminToken), minus the secret: the
 * runner never holds the token's secret, only its id, and rebuilds the same ability from the database before every
 * chunk. Never a superuser, never the approver's ability.
 */
const crypto = require('crypto');
const C = require('./index');
const M = require('../model');

const CM = ['read', 'create', 'update', 'delete', 'publish'].map((a) => `plugin::content-manager.explorer.${a}`);

function svc(strapi) {
  const t = strapi.admin && strapi.admin.services && strapi.admin.services['api-token-admin'];
  const engine = strapi.admin && strapi.admin.services && strapi.admin.services.permission && strapi.admin.services.permission.engine;
  return { t, engine };
}

function probe(strapi) {
  const { t, engine } = svc(strapi);
  const ok = Boolean(t && typeof t.getById === 'function' && engine && typeof engine.generateTokenAbility === 'function');
  C.note('admin.token_ability', ok, ok ? 'api-token-admin.getById + permission.engine.generateTokenAbility present'
    : 'api-token-admin.getById or permission.engine.generateTokenAbility missing: the job runner cannot rebuild a token\'s permissions');
  return ok;
}

function hashKey(strapi, accessKey) {
  const { t } = svc(strapi);
  if (t && typeof t.hash === 'function') return t.hash(accessKey);
  return crypto.createHmac('sha512', strapi.config.get('admin.apiToken.salt')).update(accessKey).digest('hex');
}

/** { tokenId, tokenName, ownerUserId } of the admin token behind an MCP request, or null. */
async function identify(strapi, extra) {
  const auth = extra && extra.requestInfo && extra.requestInfo.headers && extra.requestInfo.headers.authorization;
  if (!auth) return null;
  const accessKey = String(auth).replace(/^Bearer\s+/i, '');
  const row = await strapi.db.query('admin::api-token').findOne({ select: ['id', 'name', 'kind'], where: { accessKey: hashKey(strapi, accessKey) }, populate: ['adminUserOwner'] });
  if (!row || (row.kind && row.kind !== 'admin')) return null;
  const owner = row.adminUserOwner && typeof row.adminUserOwner === 'object' ? row.adminUserOwner.id : row.adminUserOwner;
  return { tokenId: String(row.id), tokenName: row.name || null, ownerUserId: owner == null ? null : String(owner) };
}

/**
 * The rules an ability gives on one content type, canonical: a change to any of them (an action or field removed, a
 * condition added, the role changed) changes the fingerprint, and the runner pauses the job.
 */
function fingerprint(ability, uid) {
  const rules = [];
  for (const action of CM) {
    let list = [];
    try { list = ability.rulesFor(action, uid) || []; } catch { list = []; }
    for (const r of list) rules.push({ a: action, f: r.fields || null, c: r.conditions || null, i: Boolean(r.inverted) });
  }
  return M.sha(M.canonical(rules));
}

/**
 * The token's ability now: { ok: true, ctx: { userAbility, user }, fingerprint, token } or { ok: false, reason }
 * (token_revoked, token_expired, not_admin_token, owner_missing, owner_inactive, unsupported).
 */
async function check(strapi, tokenId, uid) {
  const { t, engine } = svc(strapi);
  if (!t || !engine) return { ok: false, reason: 'unsupported' };
  const tok = await t.getById(Number.isNaN(Number(tokenId)) ? tokenId : Number(tokenId));
  if (!tok) return { ok: false, reason: 'token_revoked' };
  if (tok.kind && tok.kind !== 'admin') return { ok: false, reason: 'not_admin_token' };
  if (tok.expiresAt != null && new Date(tok.expiresAt) < new Date()) return { ok: false, reason: 'token_expired' };
  const ownerRef = tok.adminUserOwner;
  const ownerId = ownerRef && typeof ownerRef === 'object' ? ownerRef.id : ownerRef;
  if (ownerId == null) return { ok: false, reason: 'owner_missing' };
  const user = await strapi.db.query('admin::user').findOne({ where: { id: ownerId }, populate: ['roles'] });
  if (!user) return { ok: false, reason: 'owner_missing' };
  if (user.isActive !== true || user.blocked === true) return { ok: false, reason: 'owner_inactive' };
  const ability = await engine.generateTokenAbility(tok.adminPermissions || [], user);
  return { ok: true, ctx: { userAbility: ability, user: { id: user.id } }, fingerprint: fingerprint(ability, uid), token: { id: String(tok.id), name: tok.name || null } };
}

module.exports = { probe, identify, check, fingerprint, hashKey };
