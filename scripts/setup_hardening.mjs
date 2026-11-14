// Fixtures for the 0.2 hardening tests (run after setup_tokens.mjs and setup_restricted_tokens.mjs):
// - adds the `fr` locale (i18n) if it is missing;
// - gives agent-a and agent-b the owner's current permissions again (admin tokens keep a snapshot of the permissions
//   they were created with, so content types added later are not covered until the token is updated);
// - creates agent-noread: update and publish on every api:: type, but read on api::page.page WITHOUT `note` and
//   `seo.metaDescription` or any `items.*` field (for the "conflict replies hide fields the token cannot read" tests);
// - creates agent-noauthor: page read, and update without `credits.author` (a relation inside a component).
// Token values go to .secrets/tokens*.json (mode 600). Nothing secret is printed.
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

const locales = await j('GET', '/i18n/locales', null, jwt);
if (!locales.some((l) => l.code === 'fr')) {
  await j('POST', '/i18n/locales', { name: 'French (fr)', code: 'fr', isDefault: false }, jwt);
  console.log('locale fr created');
} else console.log('locale fr present');

const mine = (await j('GET', '/admin/users/me/permissions', null, jwt)).data
  .map(({ action, subject, properties, conditions }) => ({ action, subject, properties, conditions }));
const list = (await j('GET', '/admin/admin-tokens', null, jwt)).data;
for (const name of ['agent-a', 'agent-b']) {
  const t = list.find((x) => x.name === 'spike-' + name);
  if (!t) throw new Error(`token spike-${name} not found`);
  await j('PUT', `/admin/admin-tokens/${t.id}`, { name: t.name, description: t.description, adminPermissions: mine }, jwt);
  console.log('admin token', name, 'perms synced', mine.length);
}

const hidden = (f) => f === 'note' || f === 'seo.metaDescription' || f === 'items' || f.startsWith('items.');
const noread = mine
  .filter((p) => p.subject && p.subject.startsWith('api::') && /explorer\.(read|update|publish)$/.test(p.action))
  .map((p) => (p.subject === 'api::page.page' && p.action.endsWith('.read')
    ? { ...p, properties: { ...p.properties, fields: (p.properties.fields || []).filter((f) => !hidden(f)) } }
    : p));
const t = await j('POST', '/admin/admin-tokens', { name: `spike-agent-noread-${Date.now()}`, description: 'isokron-strapi-spike-2026-11', adminPermissions: noread, lifespan: null }, jwt);
toks.admin['agent-noread'] = t.data.accessKey;
console.log('admin token agent-noread perms', noread.length);

// agent-noauthor: read everything on pages, update every page field except credits.author (relation inside a component).
const noauthor = mine
  .filter((p) => p.subject === 'api::page.page' && /explorer\.(read|update)$/.test(p.action))
  .map((p) => (p.action.endsWith('.update') ? { ...p, properties: { ...p.properties, fields: (p.properties.fields || []).filter((f) => f !== 'credits.author') } } : p))
  .concat(mine.filter((p) => p.subject === 'api::author.author' && p.action.endsWith('.read')));
const t2 = await j('POST', '/admin/admin-tokens', { name: `spike-agent-noauthor-${Date.now()}`, description: 'isokron-strapi-spike-2026-11', adminPermissions: noauthor, lifespan: null }, jwt);
toks.admin['agent-noauthor'] = t2.data.accessKey;
console.log('admin token agent-noauthor perms', noauthor.length);
fs.writeFileSync(tokFile, JSON.stringify(toks), { mode: 0o600 });
