// Packs the plugin (npm pack --dry-run) and checks what would ship: only the runtime files, no tests, no fixtures,
// no dotfiles, nothing secret-shaped, and package.json fields a Strapi 5 plugin and the Strapi Market need.
//   node ci/check_pack.mjs            exit 1 on any problem; prints the file list
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = path.join(root, 'app/src/plugins/writesafe');
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const [info] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' }));
const problems = [];
const allowed = [/^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/, /^strapi-server\.js$/, /^server\/([a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/, /^admin\/[A-Za-z0-9_-]+\.mjs$/];
for (const f of info.files) {
  if (!allowed.some((rx) => rx.test(f.path))) problems.push(`unexpected file in tarball: ${f.path}`);
  const text = fs.readFileSync(path.join(dir, f.path), 'utf8');
  for (const [name, rx] of Object.entries({
    'token-shaped hex': /\b[0-9a-f]{64,}\b/, bearer: /Bearer [A-Za-z0-9._-]{20,}/, 'anthropic key': /sk-ant-[A-Za-z0-9_-]{10,}/,
    'github token': /gh[pousr]_[A-Za-z0-9]{20,}/, 'npm token': /npm_[A-Za-z0-9]{30,}/, 'private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    'local path': /\/Users\/|\/private\/tmp\//,
  })) if (rx.test(text)) problems.push(`${name} in ${f.path}`);
}
for (const req of ['LICENSE', 'README.md', 'strapi-server.js']) if (!info.files.some((f) => f.path === req)) problems.push(`missing ${req}`);
if (pkg.private) problems.push('package.json has private: true');
if (pkg.license !== 'MIT') problems.push('license is not MIT (Strapi Market requires MIT)');
if (pkg.strapi?.kind !== 'plugin' || !pkg.strapi?.name) problems.push('strapi.kind/name missing');
if (!pkg.peerDependencies?.['@strapi/strapi']) problems.push('@strapi/strapi is not a peerDependency (Strapi Market requires it)');
if (!pkg.exports?.['./strapi-server'] || !pkg.exports?.['./package.json']) problems.push('exports must map ./strapi-server and ./package.json');
if (!pkg.engines?.node) problems.push('engines.node missing');
const unpacked = info.unpackedSize;
// 1.0 with every module (media, l10n/history, bulk): ~400 kB at rc.2, ~480 kB after hardening phase 1, ~525 kB with
// phase 2 stream A (versions and keys: code, README, CHANGELOG), ~700 kB with streams B, C and D, ~750 kB with phase 3
// stream E (the bulk job store, plan tokens and their docs), ~830 kB with phase 3 stream F (undo jobs, ref ops). The cap
// catches fixtures or build output slipping in.
// ~887 kB after the pre-launch trim and phase 4 (long code comments moved to the unshipped docs/internals.md), ~921 kB
// with the admin settings page. Cap 1 MB: it is almost all server code.
if (unpacked > 1_000_000) problems.push(`unpacked size ${unpacked} B is over 1 MB`);

console.log(`${info.name}@${info.version}: ${info.files.length} files, ${info.size} B packed, ${unpacked} B unpacked`);
for (const f of info.files) console.log(`  ${String(f.size).padStart(7)}  ${f.path}`);
if (problems.length) { console.error('PACK CHECK FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('pack check: ok');
