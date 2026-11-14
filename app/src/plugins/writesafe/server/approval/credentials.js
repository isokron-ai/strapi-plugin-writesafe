'use strict';

/**
 * When an admin's CREDENTIALS last changed (third review B4): email, password hash, active/blocked and roles. Name,
 * language and other profile edits do not count. The plugin keeps a hash of those per admin in its store
 * (key approver-credentials:<id>, the hash and the time it was first seen):
 *  - first observation (at bootstrap for every admin, on an admin's creation, or the first time an admin decides):
 *    the time is the admin's createdAt, so on a fresh install nobody waits for the plugin's own age;
 *  - every write to admin::user is observed as it happens (lifecycles, subscribe());
 *  - a different hash later: the time is now.
 * The approver quiet period and the "changed after the request" check use this time.
 * A change made between two observations is dated at the later observation (never earlier than it happened).
 */
const M = require('../model');

const KEY = (id) => ({ type: 'plugin', name: 'writesafe', key: `approver-credentials:${id}` });

function credentialHash(u) {
  const roles = (u.roles || []).map((r) => (r && typeof r === 'object' ? r.id : r)).map(String).sort();
  return M.sha(M.canonical({ e: String(u.email || '').toLowerCase(), p: u.password || null, a: u.isActive === true, b: u.blocked === true, r: roles }));
}

async function credentialsSince(strapi, userId, now = Date.now()) {
  const id = Number.isNaN(Number(userId)) ? userId : Number(userId);
  const u = await strapi.db.query('admin::user').findOne({ where: { id }, select: ['id', 'email', 'password', 'isActive', 'blocked', 'createdAt'], populate: ['roles'] });
  if (!u) return now;
  const hash = credentialHash(u);
  const prev = await strapi.store.get(KEY(u.id));
  if (!prev || !prev.hash) {
    const since = u.createdAt ? new Date(u.createdAt).getTime() : now;
    await strapi.store.set({ ...KEY(u.id), value: { hash, since } });
    return since;
  }
  if (prev.hash !== hash) {
    await strapi.store.set({ ...KEY(u.id), value: { hash, since: now } });
    return now;
  }
  return Number(prev.since);
}

/** Records every admin once (bootstrap), so later credential changes are dated from here on. */
async function observeAll(strapi) {
  const users = await strapi.db.query('admin::user').findMany({ select: ['id'], limit: 1000 });
  for (const u of users) await credentialsSince(strapi, u.id);
  return users.length;
}

/**
 * Dates credential changes as they happen: every write to admin::user (create, update, a password change, a role
 * change), however it is made, re-reads the hash. Without this an admin first seen after a change would be dated from
 * createdAt.
 */
function subscribe(strapi) {
  const lc = strapi.db && strapi.db.lifecycles;
  if (!lc || typeof lc.subscribe !== 'function') return false;
  const one = async (event) => {
    const id = event && event.result && event.result.id;
    if (id != null) { try { await credentialsSince(strapi, id); } catch { /* the next observation dates it */ } }
  };
  lc.subscribe({
    models: ['admin::user'],
    afterCreate: one,
    afterUpdate: one,
    async afterUpdateMany() { try { await observeAll(strapi); } catch { /* idem */ } },
  });
  return true;
}

module.exports = { credentialsSince, credentialHash, observeAll, subscribe };
