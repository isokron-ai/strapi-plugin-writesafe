// Creates throwaway local tokens for the spike: two admin tokens (MCP agents A and B) and one
// full-access Content API token (REST control). Writes them to .secrets/tokens.json (mode 600).
// Nothing is printed except token names.
import fs from 'node:fs';
const BASE = process.env.SPIKE_BASE ?? 'http://127.0.0.1:1337';
const root = new URL('..', import.meta.url).pathname;
const admin = JSON.parse(fs.readFileSync(process.env.SPIKE_ADMIN ?? root + '.secrets/admin.json', 'utf8'));
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};
const login = await j('POST', '/admin/login', { email: admin.email, password: admin.password });
const jwt = login.data.token;
const owner = await j('GET', '/admin/users/me/permissions', null, jwt);
const perms = (owner.data ?? owner).map(({ action, subject, properties, conditions }) => ({ action, subject, properties, conditions }));
const out = { admin: {}, rest: {} };
for (const name of ['agent-a', 'agent-b']) {
  const t = await j('POST', '/admin/admin-tokens', { name: 'spike-' + name, description: 'isokron-strapi-spike-2026-11', adminPermissions: perms, lifespan: null }, jwt);
  out.admin[name] = t.data.accessKey;
  console.log('admin token', name, 'perms', perms.length);
}
for (const name of ['rest-a', 'rest-b']) {
  const t = await j('POST', '/admin/api-tokens', { name: 'spike-' + name, description: 'isokron-strapi-spike-2026-11', type: 'full-access', lifespan: null }, jwt);
  out.rest[name] = t.data.accessKey;
  console.log('api token', name);
}
fs.writeFileSync((process.env.SPIKE_TOKENS ?? root + '.secrets/tokens.json'), JSON.stringify(out), { mode: 0o600 });
