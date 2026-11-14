// For tests/test_l10n_history.py: adds the `de` locale (i18n) if it is missing. Nothing secret is printed.
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
const jwt = (await j('POST', '/admin/login', { email: admin.email, password: admin.password })).data.token;
const locales = await j('GET', '/i18n/locales', null, jwt);
for (const [code, name] of [['fr', 'French (fr)'], ['de', 'German (de)']]) {
  if (!locales.some((l) => l.code === code)) {
    await j('POST', '/i18n/locales', { name, code, isDefault: false }, jwt);
    console.log('locale', code, 'created');
  } else console.log('locale', code, 'present');
}
// agent-en-only: read + update on api::article.article limited to the en locale (locale-scoped permission tests).
const TOKENS = process.env.SPIKE_TOKENS ?? root + '.secrets/tokens.json';
const toks = JSON.parse(fs.readFileSync(TOKENS, 'utf8'));
const mine = (await j('GET', '/admin/users/me/permissions', null, jwt)).data;
const enOnly = mine.filter((p) => p.subject === 'api::article.article' && ['plugin::content-manager.explorer.read', 'plugin::content-manager.explorer.update'].includes(p.action))
  .map(({ action, subject, properties, conditions }) => ({ action, subject, conditions, properties: { ...properties, locales: ['en'] } }));
const t = await j('POST', '/admin/admin-tokens', { name: `l10n-agent-en-only-${Date.now()}`, description: 'isokron-strapi-1-0 l10n tests', adminPermissions: enOnly, lifespan: null }, jwt);
toks.admin['agent-en-only'] = t.data.accessKey;
fs.writeFileSync(TOKENS, JSON.stringify(toks), { mode: 0o600 });
console.log('admin token agent-en-only perms', enOnly.length);
