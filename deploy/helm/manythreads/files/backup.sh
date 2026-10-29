#!/usr/bin/env bash
# backup.sh: one backup set of a manythreads install. Run by the CronJob `manythreads-backup` (deploy/helm/manythreads/templates/backup.yaml);
# the script is the chart's file files/backup.sh, mounted from a ConfigMap. Plain-language description: docs/deploy/backup.md.
#
# A set is a directory <BACKUP_DIR>/<UTC timestamp> holding:
#   db-<database>.dump   pg_dump custom format, one per database in BACKUP_DATABASES
#   db-<database>.settings.sql   per-database role settings (search_path) that a dump does not carry
#   blobs.tar            the attachment store (local store only)
#   repos.tar            the team repositories
#   manifest.txt         key=value lines: when, which version, sizes, checksums, row counts; ends with complete=yes
#   sha256sums.txt       `sha256sum -c` format
# The set is built in a hidden directory and renamed into place only when finished, so a set that is listed is a whole set.
#
# Environment: PGHOST PGUSER PGPASSWORD (the owner role, which can read every row), BACKUP_DIR, BACKUP_DATABASES (space separated),
# BACKUP_RETENTION (sets to keep), BACKUP_BLOBS_DIR, BACKUP_REPOS_DIR (empty or missing = skip), BACKUP_STORAGE_TYPE (local | s3),
# BACKUP_APP_VERSION, BACKUP_NAMESPACE.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_DATABASES=${BACKUP_DATABASES:-manythreads}
BACKUP_RETENTION=${BACKUP_RETENTION:-7}
BACKUP_STORAGE_TYPE=${BACKUP_STORAGE_TYPE:-local}
BACKUP_APP_VERSION=${BACKUP_APP_VERSION:-unknown}
BACKUP_NAMESPACE=${BACKUP_NAMESPACE:-unknown}
BACKUP_BLOBS_DIR=${BACKUP_BLOBS_DIR:-}
BACKUP_REPOS_DIR=${BACKUP_REPOS_DIR:-}
# The database that holds the application's tables; its row counts go into the manifest.
MAIN_DB=${BACKUP_MAIN_DB:-manythreads}
COUNT_TABLES=${BACKUP_COUNT_TABLES:-workspaces teams people channels messages files repos tasks events}

log() { printf '%s backup: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

case $BACKUP_RETENTION in '' | *[!0-9]*) fail "BACKUP_RETENTION must be a whole number, got '$BACKUP_RETENTION'" ;; esac
[ "$BACKUP_RETENTION" -ge 1 ] || fail "BACKUP_RETENTION must be at least 1"
[ -d "$BACKUP_DIR" ] || fail "$BACKUP_DIR is not a directory (is the backups volume mounted?)"

SET=$(date -u +%Y%m%dT%H%M%SZ)
STARTED=$(date +%s)
WORK="$BACKUP_DIR/.incoming-$SET"
mkdir "$WORK"
cleanup() { rc=$?; if [ -d "$WORK" ]; then rm -rf "$WORK"; fi; exit "$rc"; }
trap cleanup EXIT
# The job's main process is PID 1 of its container, which ignores a signal it has no handler for: without these the 'deadline reached' stop
# would skip the cleanup above.
trap 'exit 143' TERM INT

MANIFEST="$WORK/manifest.txt"
{
  echo "set=$SET"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "namespace=$BACKUP_NAMESPACE"
  echo "app_version=$BACKUP_APP_VERSION"
  echo "storage_type=$BACKUP_STORAGE_TYPE"
  echo "databases=$BACKUP_DATABASES"
} >"$MANIFEST"

# --- 1. Databases -------------------------------------------------------------------------------------------------------------------
# For the main database the dump and the row counts must describe the same moment: one psql session holds a repeatable-read snapshot open,
# pg_dump joins that snapshot, and the counts are read from the same session before it ends.
dump_main() {
  local db=$1 out=$2 snap line
  coproc PSQL { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$db"; }
  echo "rows_database=$db" >>"$MANIFEST"
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ;" >&"${PSQL[1]}"
  echo "SELECT pg_export_snapshot();" >&"${PSQL[1]}"
  read -r snap <&"${PSQL[0]}" || fail "could not open a snapshot of $db"
  pg_dump --format=custom --snapshot="$snap" --dbname="$db" --file="$out" || fail "pg_dump of $db failed"
  for t in $COUNT_TABLES; do
    echo "SELECT count(*) FROM app.$t;" >&"${PSQL[1]}"
    read -r line <&"${PSQL[0]}" || fail "row count of app.$t failed"
    echo "rows.$t=$line" >>"$MANIFEST"
  done
  echo "COMMIT;" >&"${PSQL[1]}"
  eval "exec ${PSQL[1]}>&-"
  wait "$PSQL_PID" || fail "psql session for $db ended with an error"
}

for db in $BACKUP_DATABASES; do
  log "dumping database $db"
  out="$WORK/db-$db.dump"
  if [ "$db" = "$MAIN_DB" ]; then
    dump_main "$db" "$out"
  else
    pg_dump --format=custom --dbname="$db" --file="$out" || fail "pg_dump of $db failed"
  fi
  # Things that belong to the database object, not to its contents: a dump does not carry them, a restore must put them back. Role settings
  # (ALTER ROLE ... IN DATABASE ... SET search_path, the app roles') and the database's privileges (the chart's REVOKE CONNECT ... FROM PUBLIC that
  # keeps the memory engine's login out of the application database).
  psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$db" >"$WORK/db-$db.settings.sql" <<SQL
SELECT sql FROM (
  SELECT 0 AS ord, format('ALTER ROLE %I IN DATABASE %I SET %s;', r.rolname, d.datname, s.cfg) AS sql
    FROM pg_db_role_setting x
    JOIN pg_database d ON d.oid = x.setdatabase
    JOIN pg_roles r ON r.oid = x.setrole
    CROSS JOIN LATERAL unnest(x.setconfig) AS s(cfg)
   WHERE d.datname = '$db'
  UNION ALL
  SELECT 0, format('ALTER DATABASE %I SET %s;', d.datname, s.cfg)
    FROM pg_db_role_setting x
    JOIN pg_database d ON d.oid = x.setdatabase
    CROSS JOIN LATERAL unnest(x.setconfig) AS s(cfg)
   WHERE d.datname = '$db' AND x.setrole = 0
  UNION ALL
  SELECT 1, format('REVOKE ALL ON DATABASE %I FROM PUBLIC;', d.datname)
    FROM pg_database d WHERE d.datname = '$db' AND d.datacl IS NOT NULL
  UNION ALL
  SELECT 2, format('GRANT %s ON DATABASE %I TO %s;', a.privilege_type, d.datname,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END)
    FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
   WHERE d.datname = '$db' AND a.grantee <> d.datdba
) q ORDER BY ord, sql;
SQL
  owner=$(psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$db" -c "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")
  echo "db.$db.owner=$owner" >>"$MANIFEST"
done
# Roles the dumps refer to (owners and grantees). The restore creates any that is missing, without a password: the server sets them on start.
roles=$(psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$MAIN_DB" -c "SELECT string_agg(rolname, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'postgres'")
echo "roles=$roles" >>"$MANIFEST"
echo "pg_server_version=$(psql -X -q -A -t -d "$MAIN_DB" -c 'SHOW server_version')" >>"$MANIFEST"

# --- 2. Attachment store and repositories --------------------------------------------------------------------------------------------
# Taken after the database on purpose: a file written meanwhile is a harmless extra, whereas a row that points at a file the tar missed
# would be a dangling reference. The same goes for repositories: the database index of a repository heals itself from git when git is ahead.
# tar exit code 1 means "a file changed while it was read"; the stores write a temporary file and rename it, so that is only a warning.
tar_dir() {
  local src=$1 dest=$2 rc=0
  tar --create --file="$dest" --directory="$src" --exclude=./.tmp . || rc=$?
  if [ "$rc" -eq 1 ]; then
    log "warning: files changed while $src was archived"
    echo "warning.$(basename "$dest" .tar)=files changed while archived" >>"$MANIFEST"
  elif [ "$rc" -ne 0 ]; then
    fail "tar of $src failed (exit $rc)"
  fi
}

if [ "$BACKUP_STORAGE_TYPE" = "local" ] && [ -n "$BACKUP_BLOBS_DIR" ] && [ -d "$BACKUP_BLOBS_DIR" ]; then
  log "archiving the attachment store $BACKUP_BLOBS_DIR"
  tar_dir "$BACKUP_BLOBS_DIR" "$WORK/blobs.tar"
  echo "blobs=included" >>"$MANIFEST"
else
  # With the S3 store the bytes live in the bucket, not in this install: protect the bucket (versioning, replication), see docs/deploy/backup.md.
  echo "blobs=not-included ($BACKUP_STORAGE_TYPE store)" >>"$MANIFEST"
fi
if [ -n "$BACKUP_REPOS_DIR" ] && [ -d "$BACKUP_REPOS_DIR" ]; then
  log "archiving the team repositories $BACKUP_REPOS_DIR"
  tar_dir "$BACKUP_REPOS_DIR" "$WORK/repos.tar"
  echo "repos=included" >>"$MANIFEST"
else
  echo "repos=not-included" >>"$MANIFEST"
fi

# --- 3. Checksums, manifest, publish, prune -----------------------------------------------------------------------------------------
(
  cd "$WORK"
  files=()
  for f in db-*.dump db-*.settings.sql blobs.tar repos.tar; do
    if [ -e "$f" ]; then files+=("$f"); fi
  done
  sha256sum "${files[@]}" >sha256sums.txt
  while read -r sum name; do
    echo "file.$name.sha256=$sum" >>manifest.txt
    echo "file.$name.bytes=$(stat -c %s "$name")" >>manifest.txt
  done <sha256sums.txt
)
echo "duration_seconds=$(($(date +%s) - STARTED))" >>"$MANIFEST"
echo "complete=yes" >>"$MANIFEST"

mv "$WORK" "$BACKUP_DIR/$SET"
log "set $SET written ($(du -sh "$BACKUP_DIR/$SET" | cut -f1))"

# Keep the newest BACKUP_RETENTION sets. Only directories named like a set are ever removed. A failed run left no set behind (the trap above).
mapfile -t sets < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z' -printf '%f\n' | sort)
excess=$((${#sets[@]} - BACKUP_RETENTION))
if [ "$excess" -gt 0 ]; then
  for old in "${sets[@]:0:excess}"; do
    log "pruning old set $old"
    rm -rf "${BACKUP_DIR:?}/$old"
  done
fi
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.incoming-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
log "done"
