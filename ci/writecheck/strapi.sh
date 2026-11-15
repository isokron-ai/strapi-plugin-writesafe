#!/usr/bin/env bash
# The writesafe test app for one CI job: Strapi 5 with the plugin installed from its packed tarball, on
# SQLite, on 127.0.0.1:4812. Every credential is generated here, masked, and never printed.
#
#   ci/writecheck/strapi.sh prepare   build the app from this repository
#   ci/writecheck/strapi.sh start     write .env, start Strapi, register the first admin, make the
#                                          tokens (exported masked through GITHUB_ENV), seed test data
#   ci/writecheck/strapi.sh stop
#
# Env: STRAPI_VERSION (default 5.62.0), RUNNER_TEMP, GITHUB_ENV.
set -euo pipefail
WS=$(cd "$(dirname "$0")/../.." && pwd)
APP=${RUNNER_TEMP:?}/ws-app
SECRETS=$RUNNER_TEMP/ws-secrets
PORT=4812
BASE=http://127.0.0.1:$PORT
LOG=$RUNNER_TEMP/ws-strapi.log
PIDFILE=$RUNNER_TEMP/ws-strapi.pid

rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("base64url"))' "$1"; }

case "${1:?prepare, start or stop}" in
  prepare)
    "$WS/ci/prepare_app.sh" "${STRAPI_VERSION:-5.62.0}" "$APP"
    ;;

  start)
    mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
    umask 077
    {
      echo "HOST=127.0.0.1"
      echo "PORT=$PORT"
      echo "APP_KEYS=$(rnd 24),$(rnd 24),$(rnd 24),$(rnd 24)"
      echo "API_TOKEN_SALT=$(rnd 24)"
      echo "ADMIN_JWT_SECRET=$(rnd 24)"
      echo "TRANSFER_TOKEN_SALT=$(rnd 24)"
      echo "JWT_SECRET=$(rnd 24)"
      echo "ENCRYPTION_KEY=$(rnd 24)"
      echo "STRAPI_TELEMETRY_DISABLED=true"
      echo "DO_NOT_TRACK=1"
      echo "DATABASE_CLIENT=sqlite"
      # The documented defaults (builtinUpdates guard, allowForce off), with the optional modules on.
      echo "WRITESAFE_MODULES=create,delete,bulk,replace,copy,localize"
    } > "$APP/.env"
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ email: "ci-admin@example.test", password: "Ci9" + require("crypto").randomBytes(18).toString("base64url") }), { mode: 0o600 })' "$SECRETS/admin.json"
    umask 022
    rm -rf "$APP/.tmp"
    : > "$LOG"
    ( cd "$APP" && HOST=127.0.0.1 PORT=$PORT STRAPI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 SERVE_ADMIN_PANEL=false NODE_ENV=test \
        nohup node --max-old-space-size=6144 node_modules/@strapi/strapi/bin/strapi.js start >> "$LOG" 2>&1 & echo $! > "$PIDFILE" )
    for _ in $(seq 1 180); do
      curl -s -o /dev/null -w '%{http_code}' "$BASE/_health" 2>/dev/null | grep -q 204 && break
      kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "::error::Strapi exited during start"; tail -40 "$LOG"; exit 1; }
      sleep 1
    done
    curl -s -o /dev/null -w '%{http_code}' "$BASE/_health" | grep -q 204 || { echo "::error::Strapi not healthy after 180 s"; tail -40 "$LOG"; exit 1; }
    echo "Strapi is up on $PORT"

    # The first admin (registration endpoint), then the plugin repository's own token script: two tokens
    # for the MCP endpoint and two full-access REST tokens, written to a mode-600 file.
    export SPIKE_BASE=$BASE SPIKE_ADMIN=$SECRETS/admin.json SPIKE_TOKENS=$SECRETS/tokens.json
    node -e '
      const a = JSON.parse(require("fs").readFileSync(process.env.SPIKE_ADMIN, "utf8"));
      fetch(process.env.SPIKE_BASE + "/admin/register-admin", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstname: "CI", lastname: "Admin", email: a.email, password: a.password }) })
        .then(async (r) => { if (!r.ok) { console.error("register-admin", r.status); process.exit(1); } console.log("admin registered"); });
    '
    node "$WS/scripts/setup_tokens.mjs" > /dev/null
    # Mask before anything can print them, then hand them to later steps.
    node -e '
      const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const fs = require("fs");
      const all = [t.admin["agent-a"], t.admin["agent-b"], t.rest["rest-a"], t.rest["rest-b"]];
      // Values from the server: refuse anything that is not a plain token (a newline would inject into GITHUB_ENV).
      if (!all.every((v) => typeof v === "string" && /^[A-Za-z0-9._~+\/=-]+$/.test(v))) { console.error("a token has an unexpected form"); process.exit(1); }
      for (const v of all) console.log("::add-mask::" + v);
      fs.appendFileSync(process.env.GITHUB_ENV, "WS_MCP_TOKEN=" + t.admin["agent-a"] + "\nWS_REST_TOKEN=" + t.rest["rest-a"] + "\n");
    ' "$SECRETS/tokens.json"

    # Test data the tester did not create: the guard page and bystanders (pages and one article).
    node - "$SECRETS/tokens.json" <<'EOF'
const fs = require('fs');
const rest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).rest['rest-a'];
const base = process.env.SPIKE_BASE;
async function post(path, data) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + rest }, body: JSON.stringify({ data }) });
  if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status}`);
}
(async () => {
  await post('/api/pages', { title: 'mwsws-guard', summary: 'guard page' });
  for (const n of [1, 2, 3]) await post('/api/pages', { title: `mwsws-by-${n}`, summary: `bystander ${n}`, note: 'do not touch' });
  await post('/api/articles?locale=en', { title: 'mwsws-by-article', slug: 'mwsws-by-article', code: 'by-code', level: 'basic' });
  console.log('seeded the guard page and the bystanders');
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
    ;;

  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; fi
    rm -rf "$SECRETS"
    ;;
esac
