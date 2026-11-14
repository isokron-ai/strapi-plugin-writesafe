// Restricted admin tokens for the media tests, added to $SPIKE_TOKENS (mode 600). Nothing secret is printed.
//   agent-nomedia:   every permission of the admin EXCEPT plugin::upload.* (no Media Library access at all)
//   agent-mediaread: plugin::upload.read only (may search, may not upload)
import fs from 'node:fs';
const BASE = process.env.SPIKE_BASE ?? 'http://127.0.0.1:2037';
const root = new URL('..', import.meta.url).pathname;
const admin = JSON.parse(fs.readFileSync(process.env.SPIKE_ADMIN ?? root + '.secrets/admin.json', 'utf8'));
const file = process.env.SPIKE_TOKENS;
const toks = JSON.parse(fs.readFileSync(file, 'utf8'));
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};
const jwt = (await j('POST', '/admin/login', { email: admin.email, password: admin.password })).data.token;
const mine = (await j('GET', '/admin/users/me/permissions', null, jwt)).data
  .map(({ action, subject, properties, conditions }) => ({ action, subject, properties, conditions }));
const sets = {
  'agent-nomedia': mine.filter((p) => !p.action.startsWith('plugin::upload.')),
  'agent-mediaread': mine.filter((p) => p.action === 'plugin::upload.read'),
};
const stamp = Date.now();
for (const [name, perms] of Object.entries(sets)) {
  const t = await j('POST', '/admin/admin-tokens', { name: `media-${name}-${stamp}`, description: 'isokron-strapi-1-0-media', adminPermissions: perms, lifespan: null }, jwt);
  toks.admin[name] = t.data.accessKey;
  console.log('admin token', name, 'perms', perms.length);
}
fs.writeFileSync(file, JSON.stringify(toks), { mode: 0o600 });
