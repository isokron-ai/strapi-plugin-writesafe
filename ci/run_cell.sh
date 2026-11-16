#!/usr/bin/env bash
# CI: runs the suite on every database for one prepared app and writes <results>/<version>-<db>.{status,json}.
#   ci/run_cell.sh <app-dir> <results-dir>
# Env: DBS (default "sqlite postgres mysql"); PG_PORT PG_USER PG_PASSWORD PG_CONTAINER; MYSQL_PORT MYSQL_USER
#      MYSQL_PASSWORD MYSQL_CONTAINER. Exit 1 if any database failed (every database still runs).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=$(cd "${1:?app dir}" && pwd)
RES=${2:?results dir}; mkdir -p "$RES"; RES=$(cd "$RES" && pwd)
VER=$(cat "$APP/.strapi-version")
# #42: which @strapi/utils (and zod) the plugin runs on, on every result line
DEPS=$(cat "$APP/.plugin-deps" 2>/dev/null || echo "plugin deps unknown")
echo "strapi $VER: plugin on $DEPS"
# CI: the service containers' throwaway passwords derive from the run id, so they need not sit in the step env (and log)
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  PG_PASSWORD=${PG_PASSWORD:-ci-$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}-pg}
  MYSQL_PASSWORD=${MYSQL_PASSWORD:-ci-$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}-my}
fi
FAILED=0
for DB in ${DBS:-sqlite postgres mysql}; do
  case "$DB" in
    postgres) EXTRA=(DB_PORT="$PG_PORT" DB_USER="$PG_USER" DB_PASSWORD="$PG_PASSWORD" DB_CONTAINER="$PG_CONTAINER") ;;
    mysql) EXTRA=(DB_PORT="$MYSQL_PORT" DB_USER="$MYSQL_USER" DB_PASSWORD="$MYSQL_PASSWORD" DB_CONTAINER="$MYSQL_CONTAINER") ;;
    *) EXTRA=() ;;
  esac
  echo "::group::strapi $VER on $DB"
  env "${EXTRA[@]}" APP_DIR="$APP" DB="$DB" WORK="$RES/work-$DB" OUT_JSON="$RES/$VER-$DB.json" "$ROOT/ci/run_suite.sh" 2>&1 | tee "$RES/$VER-$DB.txt"
  RC=${PIPESTATUS[0]}
  echo "::endgroup::"
  SUM=$(grep -E 'passed, [0-9]+ failed' "$RES/$VER-$DB.txt" | tail -1)
  echo "rc=$RC ${SUM:-no summary}" > "$RES/$VER-$DB.status"
  echo "strapi $VER $DB ($DEPS): rc=$RC ${SUM:-no summary}"
  [ "$RC" -ne 0 ] && FAILED=1 && echo "::error title=strapi $VER on $DB::rc=$RC ${SUM:-no summary}"
  rm -rf "$RES/work-$DB/secrets"   # generated credentials never leave the runner
done
exit $FAILED
