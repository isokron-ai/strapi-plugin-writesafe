#!/usr/bin/env bash
# Local equivalent of the CI matrix, for a developer machine with Docker.
#   ci/local_matrix.sh [versions...]     (default: every version in ci/strapi-versions.json)
# Env: DBS (default "sqlite postgres mysql"), WORK_ROOT (default ../work next to the repo), PORT (default 1537),
#      PG_CONTAINER / MYSQL_CONTAINER (default isokron-strapi-1-0-ci-pg / -mysql on 127.0.0.1:5633 / :3507),
#      DB_SECRETS (JSON with {"pg": "...", "mysql": "..."} root passwords; default $WORK_ROOT/secrets/db.json).
# Each database is dropped and recreated before every run. Prints one summary line per cell to $WORK_ROOT/matrix.tsv.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK_ROOT=${WORK_ROOT:-$(cd "$ROOT/.." && pwd)/work}
DBS=${DBS:-sqlite postgres mysql}
PORT=${PORT:-1537}
PG_CONTAINER=${PG_CONTAINER:-isokron-strapi-1-0-ci-pg}
MYSQL_CONTAINER=${MYSQL_CONTAINER:-isokron-strapi-1-0-ci-mysql}
DB_SECRETS=${DB_SECRETS:-$WORK_ROOT/secrets/db.json}
VERSIONS=("$@")
[ ${#VERSIONS[@]} -eq 0 ] && VERSIONS=($(node -p 'require(process.argv[1]).versions.join(" ")' "$ROOT/ci/strapi-versions.json"))
mkdir -p "$WORK_ROOT"
for V in "${VERSIONS[@]}"; do
  APP="$WORK_ROOT/app-$V"
  # #42: a work dir prepared before the utils pin has no .plugin-deps (and the hoisted utils): prepare it again
  if [ ! -f "$APP/.strapi-version" ] || [ ! -f "$APP/.plugin-deps" ]; then
    "$ROOT/ci/prepare_app.sh" "$V" "$APP" > "$WORK_ROOT/prepare-$V.log" 2>&1 || { printf '%s\tall\tPREPARE_FAILED\n' "$V" | tee -a "$WORK_ROOT/matrix.tsv"; continue; }
  fi
  RV=$(cat "$APP/.strapi-version")
  DEPS=$(cat "$APP/.plugin-deps")   # #42
  for DB in $DBS; do
    case "$DB" in
      postgres)
        PW=$(node -p 'require(process.argv[1]).pg' "$DB_SECRETS")
        docker exec "$PG_CONTAINER" psql -U postgres -q -c 'DROP DATABASE IF EXISTS strapi WITH (FORCE)' -c 'CREATE DATABASE strapi' >/dev/null
        EXTRA=(DB_PORT=5633 DB_USER=postgres DB_PASSWORD="$PW" DB_CONTAINER="$PG_CONTAINER") ;;
      mysql)
        PW=$(node -p 'require(process.argv[1]).mysql' "$DB_SECRETS")
        docker exec -e MYSQL_PWD="$PW" "$MYSQL_CONTAINER" mysql -uroot -e 'DROP DATABASE IF EXISTS strapi; CREATE DATABASE strapi' >/dev/null
        EXTRA=(DB_PORT=3507 DB_USER=root DB_PASSWORD="$PW" DB_CONTAINER="$MYSQL_CONTAINER") ;;
      *) EXTRA=() ;;
    esac
    OUT="$WORK_ROOT/results/$RV-$DB.json"
    env "${EXTRA[@]}" APP_DIR="$APP" DB="$DB" PORT="$PORT" WORK="$WORK_ROOT/run-$RV-$DB" OUT_JSON="$OUT" \
      "$ROOT/ci/run_suite.sh" > "$WORK_ROOT/run-$RV-$DB.txt" 2>&1
    RC=$?
    SUM=$(grep -E 'passed, [0-9]+ failed' "$WORK_ROOT/run-$RV-$DB.txt" | tail -1)
    printf '%s\t%s\t%s\t%s\t%s\n' "$RV" "$DB" "$DEPS" "rc=$RC" "${SUM:-no summary}" | tee -a "$WORK_ROOT/matrix.tsv"
  done
done
