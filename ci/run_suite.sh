#!/usr/bin/env bash
# Runs every functional suite against one prepared app (ci/prepare_app.sh) and one database, with every module on:
# tests/test_plugin.py (core), test_media.py, test_l10n_history.py, test_bulk_create.py, test_locking.py (lock order),
# test_versions_keys.py (versions and keys), test_phase2_c.py (modules); then tests/test_mcp_probe.py once per
# builtinUpdates mode (Strapi restarted per mode) and scripts/compat_check.mjs, both of which fail the run on a failed
# probe (hardening phase 2, item 13); then tests/test_phase4d.py in three restarts (phase 4: ws_find, allowForce,
# history on by default).
# Every credential is generated here, per run, and never printed: app keys, salts, the admin user and all tokens.
#
#   APP_DIR=<prepared app> DB=sqlite|postgres|mysql ci/run_suite.sh
#
# Env:
#   PORT            Strapi port (default 1337; local runs use 1537). HOST is always 127.0.0.1.
#   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD   for postgres/mysql
#   DB_CONTAINER    docker container of the database (the suite inspects component rows with psql/mysql inside it)
#   WORK            scratch dir for generated secrets, logs and results (default $APP_DIR/.ci)
#   OUT_JSON        where to write the per-check results (default $WORK/results.json)
#   RACE_ROUNDS IDEM_ROUNDS ONLY LOCK_ROUNDS   passed through to the suite
#   SUITES          the suites to run, in order (default: all of the above); e.g. SUITES=stress/lock_soak runs the lock
#                   stress job (tests/stress/lock_soak.py) on the same freshly set-up app, SUITES=test_row_key_import the
#                   export/import row-key scenarios (1.0 hardening item 16b; a second Strapi on PORT2, default PORT+5).
#   PROBE_MODES     the builtinUpdates modes test_mcp_probe runs in (default "keep guide guard hide"; empty skips them)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR=$(cd "${APP_DIR:?APP_DIR}" && pwd)
DB=${DB:?DB}
PORT=${PORT:-1337}
mkdir -p "${WORK:-$APP_DIR/.ci}"; WORK=$(cd "${WORK:-$APP_DIR/.ci}" && pwd)
OUT_JSON=${OUT_JSON:-$WORK/results.json}
BASE="http://127.0.0.1:$PORT"
mkdir -p "$WORK/secrets"; chmod 700 "$WORK/secrets"
LOG="$WORK/strapi-$DB.log"

# media test servers (tests/test_media.py): files, internal canary, DNS
MP=${MEDIA_TEST_PORTS:-2047,2048,2049}; MF=${MP%%,*}; MR=${MP#*,}; MI=${MR%%,*}; MD=${MR#*,}
export MEDIA_TEST_PORTS=$MP

rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("base64url"))' "$1"; }

# 1. throwaway secrets for this run only
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
  echo "DATABASE_CLIENT=$DB"
  # 1.0: every module on, the test probe (boundary tests), history pruning on demand, admin login rate limit off
  echo "WRITESAFE_MODULES=media,localize,history,bulk,create,delete,replace,copy"
  # the suites check force: true paths; allowForce is off by default in guard mode (phase 4 D; test_phase4d checks that)
  echo "WRITESAFE_ALLOW_FORCE=true"
  echo "WRITESAFE_TEST_PROBE=true"
  echo "WRITESAFE_HISTORY_PRUNE_EVERY_SECONDS=0"
  echo "WRITESAFE_RETENTION_PRUNE_EVERY_SECONDS=0"
  # stream F (tests/test_undo_refops.py): a small job byte budget (its 1,050-document bulk job fits the default ceiling)
  echo "WRITESAFE_HISTORY_MAX_JOB_BEFORE_BYTES=${WRITESAFE_HISTORY_MAX_JOB_BEFORE_BYTES:-1000000}"
  echo "ADMIN_RATE_LIMIT=false"
  # media module test override (docs/tools-media.md): NODE_ENV=test (exported below) and Strapi on loopback only
  echo "WRITESAFE_MEDIA_MAX_BYTES=300000"
  echo "WRITESAFE_MEDIA_TIMEOUT_MS=4000"
  echo "WRITESAFE_MEDIA_MAX_PIXELS=10000000"
  echo "WRITESAFE_MEDIA_TYPES=image/jpeg,image/png,image/gif,image/webp,image/avif,application/*"
  echo "WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS=$MF"
  echo "WRITESAFE_MEDIA_TEST_DNS=127.0.0.1:$MD"
  echo "WRITESAFE_MEDIA_ALLOW=http://127.0.0.1:$MF/files/,http://127.0.0.1:$MF/slow/,http://127.0.0.1:$MI/,http://localhost:$MI/,http://[::1]:$MI/,http://169.254.169.254/,http://10.0.0.5:$MF/,http://loopback.ws-test:$MI/,http://private.ws-test:$MF/,http://meta.ws-test/,http://mixed.ws-test:$MF/,http://pin.ws-test:$MF/files/,http://[::ffff:7f00:1]:$MI/,http://[::ffff:a9fe:a9fe]/,http://0.0.0.0:$MI/"
  if [ "$DB" != sqlite ]; then
    echo "DATABASE_HOST=${DB_HOST:-127.0.0.1}"
    echo "DATABASE_PORT=${DB_PORT:?DB_PORT}"
    echo "DATABASE_NAME=${DB_NAME:-strapi}"
    echo "DATABASE_USERNAME=${DB_USER:?DB_USER}"
    echo "DATABASE_PASSWORD=${DB_PASSWORD:?DB_PASSWORD}"
    echo "DATABASE_SSL=false"
  fi
} > "$APP_DIR/.env"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({email:"ci-admin@example.test",password:"Ci9"+require("crypto").randomBytes(18).toString("base64url")}),{mode:0o600})' "$WORK/secrets/admin.json"
[ "$DB" = mysql ] && node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({password:process.env.DB_PASSWORD}),{mode:0o600})' "$WORK/secrets/mysql.json"
umask 022
rm -rf "$APP_DIR/.tmp"

# 2. start Strapi (no admin panel build needed: the suite uses the admin API and /mcp only)
cd "$APP_DIR"
export HOST=127.0.0.1 PORT STRAPI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 SERVE_ADMIN_PANEL=false NODE_ENV=test
export STRAPI_LOG="$LOG"   # tests/test_plugin.py reads the deadlock-retry lines from it
VER=$(node -p 'require("@strapi/strapi/package.json").version')
echo "== strapi $VER, $DB, port $PORT"
# a Strapi left over from an earlier run would answer instead of this one
if curl -s -o /dev/null "$BASE/_health" 2>/dev/null; then echo "port $PORT is already serving; refusing to run against a stale Strapi"; exit 3; fi
# run the CLI with node directly (not npx), so $SPID is Strapi itself and stop() really stops it
SPID=
start() {
  START=$(date +%s)
  # STRAPI_HEAP_MB (default 6144): Strapi 5.51.x keeps memory per MCP request; Node's default heap ran out mid-suite.
  # 4096 held until the hardening phase 1 checks (322 in test_plugin) took 5.51.2 past it at the suite's last test.
  # 5120 held until phase 3 stream F: the ref-op fields (in the ws_patch and ws_batch schemas) and the undo job arguments
  # took 5.51.2 past it at test_plugin's last tests (OOM on SQLite, Postgres and MySQL; main at 946e8b9 still passed).
  # Other minors do not grow, so the higher cap costs them nothing.
  nohup node --max-old-space-size="${STRAPI_HEAP_MB:-6144}" node_modules/@strapi/strapi/bin/strapi.js start >> "$LOG" 2>&1 &
  SPID=$!
  for i in $(seq 1 180); do
    curl -s -o /dev/null -w '%{http_code}' "$BASE/_health" 2>/dev/null | grep -q 204 && break
    if ! kill -0 "$SPID" 2>/dev/null; then echo "strapi exited during start; log tail:"; tail -40 "$LOG"; exit 3; fi
    sleep 1
  done
  curl -s -o /dev/null -w '%{http_code}' "$BASE/_health" | grep -q 204 || { echo "strapi not healthy after 180s"; tail -40 "$LOG"; exit 3; }
  echo "strapi up after $(( $(date +%s) - START ))s"
}
# tests/test_undo_refops.py kills Strapi in the middle of an undo job and starts it again: it gets a restart command
# and the pid file; after the suite the pid file names the Strapi to stop.
write_restart() {
  cat > "$WORK/restart-strapi.sh" <<RS
#!/usr/bin/env bash
cd "$APP_DIR"
export HOST=127.0.0.1 PORT=$PORT STRAPI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 SERVE_ADMIN_PANEL=false NODE_ENV=test STRAPI_LOG="$LOG"
nohup node --max-old-space-size="${STRAPI_HEAP_MB:-6144}" node_modules/@strapi/strapi/bin/strapi.js start >> "$LOG" 2>&1 &
echo \$! > "$WORK/strapi.pid"
for i in \$(seq 1 180); do curl -s -o /dev/null -w '%{http_code}' "$BASE/_health" 2>/dev/null | grep -q 204 && exit 0; sleep 1; done
echo "strapi not healthy after restart" >&2; exit 3
RS
  chmod +x "$WORK/restart-strapi.sh"
}
stop() {
  [ -n "$SPID" ] || return 0
  kill "$SPID" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$SPID" 2>/dev/null || break; sleep 1; done
  kill -9 "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null
  for _ in $(seq 1 15); do curl -s -o /dev/null "$BASE/_health" 2>/dev/null || break; sleep 1; done
  SPID=
}
trap stop EXIT
: > "$LOG"
start
grep -q '\[writesafe\] registering' "$LOG" || echo "WARNING: no [writesafe] registration line in the log"

# 3. admin user (first-admin registration endpoint, no prompt), then tokens and fixtures
cd "$ROOT"
export SPIKE_BASE="$BASE" SPIKE_ADMIN="$WORK/secrets/admin.json" SPIKE_TOKENS="$WORK/secrets/tokens.json"
node -e '
const a = JSON.parse(require("fs").readFileSync(process.env.SPIKE_ADMIN, "utf8"));
fetch(process.env.SPIKE_BASE + "/admin/register-admin", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ firstname: "CI", lastname: "Admin", email: a.email, password: a.password }) })
  .then(async (r) => { if (!r.ok) { console.error("register-admin", r.status, (await r.text()).slice(0, 300)); process.exit(1); } console.log("admin registered"); });
' || exit 4
# order: locales first, then setup_hardening re-syncs agent-a/b to the owner's permissions (a token created before a locale exists never gets that locale)
node scripts/setup_tokens.mjs && node scripts/setup_restricted_tokens.mjs && node scripts/setup_l10n.mjs && node scripts/setup_hardening.mjs \
  && node scripts/setup_media_tokens.mjs && node scripts/setup_bulk_tokens.mjs || { echo "fixture setup failed"; tail -40 "$LOG"; exit 4; }

# 4. the suite
case "$DB" in
  postgres) export SPIKE_PG=1 SPIKE_PG_CONTAINER="${DB_CONTAINER:?DB_CONTAINER}" SPIKE_PG_USER="$DB_USER" SPIKE_DB_NAME="${DB_NAME:-strapi}" ;;
  mysql) export SPIKE_MYSQL=1 SPIKE_MYSQL_CONTAINER="${DB_CONTAINER:?DB_CONTAINER}" SPIKE_MYSQL_USER="$DB_USER" SPIKE_DB_NAME="${DB_NAME:-strapi}" SPIKE_MYSQL_SECRET="$WORK/secrets/mysql.json" ;;
  sqlite) export SPIKE_SQLITE_DB="$APP_DIR/.tmp/data.db" ;;
esac
mkdir -p "$(dirname "$OUT_JSON")"
T0=$(date +%s)
RC=0; PASS=0; FAIL=0
export DB_LABEL="$DB" RESULT_TAG="$DB" PYTHONUNBUFFERED=1 BY_GROUP=1
# Approvals and the job runner (Phase 4 stream G): four phases (approvals, runner, retention: adminTokens mcp-only; anymode), each on a fresh Strapi with its own config (JSON in
# the environment, read by app/config/plugins.js). The runner phase kills Strapi hard and starts it again itself
# (JOBS_RESTART_CMD), so the pid of the Strapi to stop afterwards is read back from JOBS_PID_FILE.
JOBS_APPROVALS='{"automaticMax":4,"twoApproverAbove":8,"maxDocuments":30,"requestTtlSeconds":10,"approvalTtlSeconds":10,"pendingPerToken":20,"samples":3,"approverQuietHours":0}'
JOBS_RUNNER='{"enabled":true,"workers":3,"pollMs":200,"leaseMs":3000,"heartbeatMs":1000,"chunkPauseMs":50}'
export JOBS_PID_FILE="$WORK/strapi-jobs.pid" JOBS_RESTART_CMD="$WORK/jobs-start.sh"
cat > "$JOBS_RESTART_CMD" <<EOS
#!/usr/bin/env bash
# started by tests/test_jobs_approval.py after it killed Strapi: same app, same environment
cd "$APP_DIR" || exit 1
# not "cd && nohup ... &": that backgrounds a subshell, and \$! would be the subshell, not Strapi
nohup node --max-old-space-size="\${STRAPI_HEAP_MB:-6144}" node_modules/@strapi/strapi/bin/strapi.js start >> "$LOG" 2>&1 &
echo \$! > "$JOBS_PID_FILE"
for i in \$(seq 1 180); do curl -s -o /dev/null -w '%{http_code}' "$BASE/_health" 2>/dev/null | grep -q 204 && exit 0; sleep 1; done
exit 1
EOS
chmod +x "$JOBS_RESTART_CMD"
run_jobs_phase() {
  local phase=$1
  cd "$APP_DIR"; stop
  if [ "$phase" = runner ]; then export WRITESAFE_APPROVALS_JSON='{"automaticMax":4,"twoApproverAbove":8,"maxDocuments":40,"pendingPerToken":20,"samples":3,"approverQuietHours":0}' WRITESAFE_RUNNER_JSON="$JOBS_RUNNER" WRITESAFE_ADMIN_TOKENS=mcp-only
  elif [ "$phase" = anymode ]; then export WRITESAFE_APPROVALS_JSON='{"automaticMax":4,"twoApproverAbove":8,"maxDocuments":30,"approverQuietHours":0}' WRITESAFE_ADMIN_TOKENS=any; unset WRITESAFE_RUNNER_JSON
  elif [ "$phase" = retention ]; then export WRITESAFE_APPROVALS_JSON='{"automaticMax":4,"twoApproverAbove":8,"maxDocuments":30,"requestTtlSeconds":2,"approvalTtlSeconds":2,"pendingPerToken":20,"samples":1,"approverQuietHours":1}' WRITESAFE_RETENTION_JOB_HOURS=0.001 WRITESAFE_RETENTION_LONG_DAYS=0.00005 WRITESAFE_ADMIN_TOKENS=mcp-only WRITESAFE_BULK_JSON='{"planTtlSeconds":5}'; unset WRITESAFE_RUNNER_JSON
  else export WRITESAFE_APPROVALS_JSON="$JOBS_APPROVALS" WRITESAFE_ADMIN_TOKENS=mcp-only; unset WRITESAFE_RUNNER_JSON; fi
  start; echo "$SPID" > "$JOBS_PID_FILE"; cd "$ROOT"
  JOBS_PHASE=$phase TEST_RESULTS="$OUT_JSON" python3 tests/test_jobs_approval.py
  local r=$?
  SPID=$(cat "$JOBS_PID_FILE" 2>/dev/null || echo "$SPID")
  unset WRITESAFE_APPROVALS_JSON WRITESAFE_RUNNER_JSON WRITESAFE_RETENTION_JOB_HOURS WRITESAFE_RETENTION_LONG_DAYS WRITESAFE_ADMIN_TOKENS WRITESAFE_BULK_JSON
  return $r
}
export APP_DIR DB WORK
FIRST=1
for SUITE in ${SUITES:-test_plugin test_media test_l10n_history test_bulk_create test_locking test_versions_keys test_phase2_c test_undo_refops test_jobs_approval}; do
  SNAME=${SUITE//\//_}
  if [ "$SUITE" = test_jobs_approval ]; then
    FIRST=0
    run_jobs_phase approvals > "$WORK/suite-$DB-$SNAME.txt" 2>&1; R1=$?
    run_jobs_phase runner >> "$WORK/suite-$DB-$SNAME.txt" 2>&1; R2=$?
    run_jobs_phase retention >> "$WORK/suite-$DB-$SNAME.txt" 2>&1; R3=$?
    run_jobs_phase anymode >> "$WORK/suite-$DB-$SNAME.txt" 2>&1; R4=$?
    R=$R1; [ $R2 -ne 0 ] && R=$R2; [ $R3 -ne 0 ] && R=$R3; [ $R4 -ne 0 ] && R=$R4
    # one summary line for the three phases
    awk '/^[0-9]+ passed, [0-9]+ failed/ { p += $1; f += $3 } END { printf "%d passed, %d failed (all phases)\n", p, f }' "$WORK/suite-$DB-$SNAME.txt" >> "$WORK/suite-$DB-$SNAME.txt"
    cd "$ROOT"
  else
    # A fresh Strapi per suite: Strapi 5.51.x keeps memory per MCP request (reproduced with the plugin off), and one
    # process serving all four suites runs out of heap there. The database (and the tokens) carry over.
    if [ "$FIRST" != 1 ]; then cd "$APP_DIR"; stop; start; cd "$ROOT"; fi
    FIRST=0
    # tests/test_undo_refops.py kills Strapi in the middle of an undo job and starts it again (stream F)
    if [ "$SUITE" = test_undo_refops ]; then
      write_restart; echo "$SPID" > "$WORK/strapi.pid"
      export WS_RESTART_CMD="$WORK/restart-strapi.sh" WS_PID_FILE="$WORK/strapi.pid"
    fi
    TEST_RESULTS="$OUT_JSON" python3 tests/$SUITE.py > "$WORK/suite-$DB-$SNAME.txt" 2>&1
    R=$?
    # a suite that restarted Strapi left the new pid in the pid file: stop() must stop that one
    if [ "$SUITE" = test_undo_refops ] && [ -s "$WORK/strapi.pid" ]; then SPID=$(cat "$WORK/strapi.pid"); fi
  fi
  [ $R -ne 0 ] && RC=$R
  LINE=$(grep -E 'passed, [0-9]+ failed' "$WORK/suite-$DB-$SNAME.txt" | tail -1)
  P=$(echo "$LINE" | sed -nE 's/^([0-9]+) passed.*/\1/p'); F=$(echo "$LINE" | sed -nE 's/.*passed, ([0-9]+) failed.*/\1/p')
  PASS=$((PASS + ${P:-0})); FAIL=$((FAIL + ${F:-1}))
  grep -E '^(FAIL|  t_)' "$WORK/suite-$DB-$SNAME.txt"
  echo "$SUITE: ${LINE:-no summary (rc=$R)}"
done
# Item 13 (phase 2): what an MCP client actually receives (initialize, tools/list, a guarded call) in every
# builtinUpdates mode. A Strapi that stops sending the instructions or moves the built-in tools fails here.
export WRITESAFE_MODULES=$(sed -n 's/^WRITESAFE_MODULES=//p' "$APP_DIR/.env")
for MODE in ${PROBE_MODES-keep guide guard hide}; do
  cd "$APP_DIR"; stop; export WRITESAFE_BUILTIN_UPDATES=$MODE; start; cd "$ROOT"
  python3 tests/test_mcp_probe.py > "$WORK/suite-$DB-test_mcp_probe-$MODE.txt" 2>&1
  R=$?; [ $R -ne 0 ] && RC=$R
  LINE=$(grep -E 'passed, [0-9]+ failed' "$WORK/suite-$DB-test_mcp_probe-$MODE.txt" | tail -1)
  P=$(echo "$LINE" | sed -nE 's/^([0-9]+) passed.*/\1/p'); F=$(echo "$LINE" | sed -nE 's/.*passed, ([0-9]+) failed.*/\1/p')
  PASS=$((PASS + ${P:-0})); FAIL=$((FAIL + ${F:-1}))
  grep -E '^FAIL' "$WORK/suite-$DB-test_mcp_probe-$MODE.txt"
  echo "test_mcp_probe ($MODE): ${LINE:-no summary (rc=$R)}"
done
unset WRITESAFE_BUILTIN_UPDATES
# Item 13 (phase 2): the compat probes, in-process (the app booted without a listener). A failed probe fails the run.
cd "$APP_DIR"; stop; cd "$ROOT"
APP_DIR="$APP_DIR" node scripts/compat_check.mjs > "$WORK/suite-$DB-compat_check.txt" 2>&1
R=$?
if [ $R -ne 0 ] && [ $R -ne 2 ]; then RC=1; FAIL=$((FAIL + 1)); echo "compat_check: FAILED (rc=$R)"; grep -E '^FAIL' "$WORK/suite-$DB-compat_check.txt"; else PASS=$((PASS + 1)); echo "compat_check: ok"; fi
# Phase 4 D (tests/test_phase4d.py): ws_find with the config above, then the shipped defaults (history and find on,
# allowForce off in guard) and both modules off. The process environment wins over .env (dotenv does not override it),
# so an empty WRITESAFE_MODULES means "no modules named". PHASE4D_VARIANTS= skips it (e.g. with SUITES).
export STRAPI_VERSION="$VER"
for VARIANT in ${PHASE4D_VARIANTS-main defaults off}; do
  cd "$APP_DIR"; stop
  case "$VARIANT" in
    defaults) export WRITESAFE_MODULES= WRITESAFE_ALLOW_FORCE= ;;
    off) export WRITESAFE_MODULES=-history,-find WRITESAFE_ALLOW_FORCE= ;;
  esac
  start; cd "$ROOT"
  PHASE4D_VARIANT=$VARIANT python3 tests/test_phase4d.py > "$WORK/suite-$DB-test_phase4d_$VARIANT.txt" 2>&1
  R=$?; [ $R -ne 0 ] && RC=$R
  unset WRITESAFE_MODULES WRITESAFE_ALLOW_FORCE
  LINE=$(grep -E 'passed, [0-9]+ failed' "$WORK/suite-$DB-test_phase4d_$VARIANT.txt" | tail -1)
  P=$(echo "$LINE" | sed -nE 's/^([0-9]+) passed.*/\1/p'); F=$(echo "$LINE" | sed -nE 's/.*passed, ([0-9]+) failed.*/\1/p')
  PASS=$((PASS + ${P:-0})); FAIL=$((FAIL + ${F:-1}))
  grep -E '^(FAIL|HISTORY_COST|FIND_EXAMPLE)' "$WORK/suite-$DB-test_phase4d_$VARIANT.txt"
  echo "test_phase4d ($VARIANT): ${LINE:-no summary (rc=$R)}"
done
# In-process check on a copy of the SQLite database (phase 1 re-review B): permission-condition populates never load a
# whole admin row. SQLite only (it boots the app on a file copy); Strapi is stopped first.
if [ "$DB" = sqlite ] && [ -z "${SUITES:-}" ]; then
  cd "$APP_DIR"; stop; cd "$ROOT"
  APP_DIR="$APP_DIR" node tests/test_condition_populate.js > "$WORK/suite-$DB-test_condition_populate.txt" 2>&1
  R=$?; [ $R -ne 0 ] && RC=$R
  LINE=$(grep -E 'passed, [0-9]+ failed' "$WORK/suite-$DB-test_condition_populate.txt" | tail -1)
  P=$(echo "$LINE" | sed -nE 's/^([0-9]+) passed.*/\1/p'); F=$(echo "$LINE" | sed -nE 's/.*passed, ([0-9]+) failed.*/\1/p')
  PASS=$((PASS + ${P:-0})); FAIL=$((FAIL + ${F:-1}))
  grep -E '^FAIL' "$WORK/suite-$DB-test_condition_populate.txt"
  echo "test_condition_populate: ${LINE:-no summary (rc=$R)}"
fi
cat "$WORK"/suite-$DB-*.txt > "$WORK/suite-$DB.txt"
# per-check results of the module suites, next to test_plugin's OUT_JSON (uploaded as CI artifacts)
for F in tests/results/test_media-"$DB"*.json tests/results/test_l10n_history_"$DB".json tests/results/test_bulk_create-"$DB".json tests/results/test_locking-"$DB".json \
  tests/results/test_versions_keys-"$DB".json tests/results/test_row_key_import-"$DB".json tests/results/test_phase2_c-"$DB".json tests/results/test_mcp_probe-"$DB"-*.json \
  tests/results/test_undo_refops-"$DB".json; do
  [ -f "$F" ] && cp "$F" "$(dirname "$OUT_JSON")/$(basename "${OUT_JSON%.json}")-$(basename "$F")"
done
echo "all suites: $PASS passed, $FAIL failed"
echo "suite rc=$RC in $(( $(date +%s) - T0 ))s (strapi $VER, $DB)"
if [ $RC -ne 0 ]; then echo "--- strapi log tail"; grep -iE 'error|warn' "$LOG" | tail -30; fi
exit $RC
