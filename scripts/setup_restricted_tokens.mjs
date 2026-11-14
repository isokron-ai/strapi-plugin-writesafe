// Two restricted admin tokens for the RBAC tests: agent-ro (content-manager read only on api::page.page) and
// agent-nonote (read + update on api::page.page, without the `note` field). Added to .secrets/tokens.json.
import fs from 'node:fs';
const BASE = process.env.SPIKE_BASE ?? 'http://127.0.0.1:1337';
const root = new URL('..', import.meta.url).pathname;
const admin = JSON.parse(fs.readFileSync(process.env.SPIKE_ADMIN ?? root + '.secrets/admin.json', 'utf8'));
const toks = JSON.parse(fs.readFileSync((process.env.SPIKE_TOKENS ?? root + '.secrets/tokens.json'), 'utf8'));
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};
const jwt = (await j('POST', '/admin/login', { email: admin.email, password: admin.password })).data.token;
const mine = (await j('GET', '/admin/users/me/permissions', null, jwt)).data;
const page = mine.filter((p) => p.subject === 'api::page.page').map(({ action, subject, properties, conditions }) => ({ action, subject, properties, conditions }));
const ro = page.filter((p) => p.action === 'plugin::content-manager.explorer.read');
const nonote = page.filter((p) => ['plugin::content-manager.explorer.read', 'plugin::content-manager.explorer.update'].includes(p.action))
  .map((p) => (p.action.endsWith('.update') ? { ...p, properties: { ...p.properties, fields: (p.properties.fields || []).filter((f) => f !== 'note') } } : p));
const stamp = Date.now();
for (const [name, perms] of [['agent-ro', ro], ['agent-nonote', nonote]]) {
  const t = await j('POST', '/admin/admin-tokens', { name: `spike-${name}-${stamp}`, description: 'isokron-strapi-spike-2026-11', adminPermissions: perms, lifespan: null }, jwt);
  toks.admin[name] = t.data.accessKey;
  console.log('admin token', name, 'perms', perms.length);
}
fs.writeFileSync((process.env.SPIKE_TOKENS ?? root + '.secrets/tokens.json'), JSON.stringify(toks), { mode: 0o600 });
