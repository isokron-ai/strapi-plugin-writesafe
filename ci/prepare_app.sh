#!/usr/bin/env bash
# Builds a throwaway copy of the test app for one Strapi version, with the plugin installed from its packed tarball
# (the same files `npm publish` would ship), so CI tests the package and not the source folder.
#
#   ci/prepare_app.sh <strapi-version|latest|experimental|next> <out-dir>
#
# Reproducibility: every @strapi/* dependency is pinned to the exact version, and the rest of the tree is resolved
# with `npm install --before=<resolve_before>` from ci/strapi-versions.json, so a re-run resolves the same tree.
# For dist-tags (latest, experimental, next), and with FREEZE=0, nothing is frozen: the nightly job wants today's tree.
# The resolved lockfile is copied to <out-dir>/resolved-package-lock.json so CI can upload it as a record.
set -euo pipefail
VER=${1:?strapi version}
OUT=${2:?out dir}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN="$ROOT/app/src/plugins/writesafe"

case "$VER" in
  latest|experimental|next|beta|rc) RESOLVED=$(npm view "@strapi/strapi@$VER" version); BEFORE="" ;;
  *) RESOLVED="$VER"; BEFORE=$(node -e 'console.log(require(process.argv[1]).resolve_before)' "$ROOT/ci/strapi-versions.json") ;;
esac
# FREEZE=0 (the nightly job) installs today's tree for an exact version too, e.g. a release newer than resolve_before
[ "${FREEZE:-1}" = 0 ] && BEFORE=""
echo "strapi $VER -> $RESOLVED${BEFORE:+ (resolve before $BEFORE)}"

rm -rf "$OUT"; mkdir -p "$OUT/vendor"
# app without node_modules, build output, local db and the plugin source (the plugin comes from the tarball)
tar -C "$ROOT/app" --exclude=./node_modules --exclude=./.tmp --exclude=./dist --exclude=./build --exclude=./.strapi \
  --exclude=./.cache --exclude=./.env --exclude=./src/plugins/writesafe --exclude=./package-lock.json -cf - . | tar -C "$OUT" -xf -

mkdir -p "$OUT/public/uploads"   # git-ignored in the repo; the local upload provider refuses to start without it

TGZ=$(cd "$PLUGIN" && npm pack --silent --pack-destination "$OUT/vendor" | tail -1)
echo "plugin tarball: vendor/$TGZ"

node - "$OUT" "$RESOLVED" "$TGZ" <<'EOF'
const fs = require('fs'); const path = require('path');
const [out, ver, tgz] = process.argv.slice(2);
const pj = path.join(out, 'package.json');
const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
for (const k of Object.keys(p.dependencies)) if (k.startsWith('@strapi/')) p.dependencies[k] = ver;
// #42: the plugin's @strapi/utils peer (>=5.47.0 <6) is not an app dependency, so npm hoisted the newest release to the
// top of node_modules and the plugin ran on it (5.62.0, zod 4.4.3) in every cell. Pinned like the other @strapi/*
// packages, the plugin loads the cell's own utils and the zod that version ships (zod 3.25 up to 5.52.1).
p.dependencies['@strapi/utils'] = ver;
p.dependencies['strapi-plugin-writesafe-mcp'] = 'file:vendor/' + tgz;
// a CI copy must not phone home or carry the dev machine's install ids
p.strapi = { telemetryDisabled: true };
fs.writeFileSync(pj, JSON.stringify(p, null, 2) + '\n');
// installed npm plugins are auto-detected by package.json strapi.kind: keep the test app's whole plugin config (modules,
// media, history options from env) and drop only the writesafe `resolve` (it points at the source folder)
const cfgFile = path.join(out, 'config', 'plugins.js');
const cfg = fs.readFileSync(cfgFile, 'utf8');
const stripped = cfg.replace(/^\s*resolve: '\.\/src\/plugins\/writesafe',\n/m, '');
if (stripped === cfg) { console.error('config/plugins.js: writesafe resolve line not found'); process.exit(1); }
fs.writeFileSync(cfgFile, stripped);
EOF

cd "$OUT"
# a prerelease tag (0.0.0-experimental.*) is outside the plugin's peer range on purpose; install it anyway
case "$RESOLVED" in 0.0.0-*) PEER=--legacy-peer-deps ;; *) PEER= ;; esac
npm install --no-audit --no-fund --loglevel=error $PEER ${BEFORE:+--before="$BEFORE"}
cp package-lock.json resolved-package-lock.json
INSTALLED=$(node -p 'require("@strapi/strapi/package.json").version')
[ "$INSTALLED" = "$RESOLVED" ] || { echo "installed @strapi/strapi $INSTALLED, expected $RESOLVED" >&2; exit 1; }
# #42: the @strapi/utils the plugin itself resolves (from its own folder, as Strapi loads it), and the zod that utils
# resolves. The prepare step fails unless the plugin's utils is the cell's version.
DEPS_LINE=$(node -e '
  const r = (id, from) => require.resolve(id, { paths: [from] });
  const plugin = require("path").dirname(r("strapi-plugin-writesafe-mcp/package.json", process.cwd()));
  const utilsPkg = r("@strapi/utils/package.json", plugin);
  const zodPkg = r("zod/package.json", require("path").dirname(utilsPkg));
  console.log(require(utilsPkg).version, require(zodPkg).version);') || { echo "could not resolve the plugin's @strapi/utils and zod (see above)" >&2; exit 1; }
read -r PLUGIN_UTILS PLUGIN_ZOD <<< "$DEPS_LINE"
echo "plugin resolves @strapi/utils $PLUGIN_UTILS (zod $PLUGIN_ZOD)"
[ "$PLUGIN_UTILS" = "$RESOLVED" ] || { echo "the plugin resolves @strapi/utils $PLUGIN_UTILS, expected $RESOLVED" >&2; exit 1; }
echo "$RESOLVED" > .strapi-version
printf '@strapi/utils %s zod %s\n' "$PLUGIN_UTILS" "$PLUGIN_ZOD" > .plugin-deps
echo "prepared $OUT with @strapi/strapi $INSTALLED, @strapi/utils $PLUGIN_UTILS (zod $PLUGIN_ZOD) and $(node -p 'require("strapi-plugin-writesafe-mcp/package.json").version')"
