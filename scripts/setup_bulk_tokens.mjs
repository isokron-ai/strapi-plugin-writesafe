// Tokens for tests/test_bulk_create.py (run after setup_tokens.mjs, setup_restricted_tokens.mjs, setup_hardening.mjs):
// - agent-cnn: read every api:: type; create and update api::page.page WITHOUT the `note` field; no delete.
//   (ws_create must refuse a create that sets a field the token may not write, instead of dropping it.)
// Token values go to the tokens file (mode 600). Nothing secret is printed.
import fs from 'node:fs';
const BASE = process.env.SPIKE_BASE ?? 'http://127.0.0.1:1337';
const root = new URL('..', import.meta.url).pathname;
const tokFile = process.env.SPIKE_TOKENS ?? root + '.secrets/tokens.json';
const admin = JSON.parse(fs.readFileSync(process.env.SPIKE_ADMIN ?? root + '.secrets/admin.json', 'utf8'));
const toks = JSON.parse(fs.readFileSync(tokFile, 'utf8'));
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};
const jwt = (await j('POST', '/admin/login', { email: admin.email, password: admin.password })).data.token;
const mine = (await j('GET', '/admin/users/me/permissions', null, jwt)).data
  .map(({ action, subject, properties, conditions }) => ({ action, subject, properties, conditions }));
const cnn = mine
  .filter((p) => p.subject && p.subject.startsWith('api::') && (p.action.endsWith('.read')
    || (p.subject === 'api::page.page' && /explorer\.(create|update)$/.test(p.action))))
  .map((p) => (p.subject === 'api::page.page' && /explorer\.(create|update)$/.test(p.action)
    ? { ...p, properties: { ...p.properties, fields: (p.properties.fields || []).filter((f) => f !== 'note') } } : p));
const t = await j('POST', '/admin/admin-tokens', { name: `bulk-agent-cnn-${Date.now()}`, description: 'isokron-strapi-1-0-bulk', adminPermissions: cnn, lifespan: null }, jwt);
toks.admin['agent-cnn'] = t.data.accessKey;
console.log('admin token agent-cnn perms', cnn.length);
// agent-nometa: read, update and create on api::page.page, but read WITHOUT the nested items.meta.note
// (copy must refuse a row whose nested sub-field it cannot read, instead of copying it unseen).
const nometa = mine
  .filter((p) => p.subject === 'api::page.page' && /explorer\.(read|update|create)$/.test(p.action))
  .map((p) => (p.action.endsWith('.read') ? { ...p, properties: { ...p.properties, fields: (p.properties.fields || []).filter((f) => f !== 'items.meta.note') } } : p));
const t2 = await j('POST', '/admin/admin-tokens', { name: `bulk-agent-nometa-${Date.now()}`, description: 'isokron-strapi-1-0-bulk', adminPermissions: nometa, lifespan: null }, jwt);
toks.admin['agent-nometa'] = t2.data.accessKey;
console.log('admin token agent-nometa perms', nometa.length);
fs.writeFileSync(tokFile, JSON.stringify(toks), { mode: 0o600 });
