#!/usr/bin/env bash
# restore.sh: put a backup set back: databases, attachment store and team repositories, into a target namespace.
#
#   tools/backup/restore.sh --set latest --target-ns manythreads-restore
#   tools/backup/restore.sh --set 20261029T021700Z --target-ns manythreads --force-live
#
# The set is read from the backups volume of --source-ns (default: the live namespace). The target namespace must already run the chart
# (database service, and the blob and repository volumes); the restore REPLACES what is there. It never touches the live namespace unless
# you pass --force-live. Plain-language steps and what to check afterwards: docs/deploy/backup.md.
#
# Options:
#   --set NAME|latest   the set to restore (required)
#   --target-ns NS      where to restore into (required)
#   --source-ns NS      namespace whose backups volume holds the set (default: $MANYTHREADS_LIVE_NAMESPACE or manythreads)
#   --force-live        allow the target to be the live namespace (or the namespace the set came from)
#   --yes               do not ask for confirmation
#   --check-only        verify the set's checksums and print what would happen; change nothing
#   --image IMAGE       database image for the helper pods (default: read from the install)
#   -h, --help
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

usage() { sed -n '2,/^set -e/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//' >&2; }

SET_ARG=""
TARGET_NS=""
SOURCE_NS=$LIVE_NAMESPACE
FORCE_LIVE=false
ASSUME_YES=false
CHECK_ONLY=false
IMAGE=""

while [ $# -gt 0 ]; do
  case $1 in
    --set) SET_ARG=${2:?--set needs a value}; shift 2 ;;
    --target-ns) TARGET_NS=${2:?--target-ns needs a value}; shift 2 ;;
    --source-ns) SOURCE_NS=${2:?--source-ns needs a value}; shift 2 ;;
    --image) IMAGE=${2:?--image needs a value}; shift 2 ;;
    --force-live) FORCE_LIVE=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --check-only) CHECK_ONLY=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done
[ -n "$SET_ARG" ] || { usage; die "--set is required"; }
[ -n "$TARGET_NS" ] || { usage; die "--target-ns is required"; }

need kubectl
if [ "$TARGET_NS" = "$LIVE_NAMESPACE" ] || [ "$TARGET_NS" = "$SOURCE_NS" ]; then
  [ "$FORCE_LIVE" = true ] || die "refusing to restore into '$TARGET_NS': it is the live namespace or the one the set came from. Restore into another namespace, or pass --force-live if you really mean to replace the live data."
fi
kubectl get namespace "$TARGET_NS" >/dev/null 2>&1 || die "namespace $TARGET_NS does not exist"

trap cleanup_created EXIT
[ -n "$IMAGE" ] || IMAGE=$(image_of_database "$SOURCE_NS")
[ -n "$IMAGE" ] || die "could not find the database image in $SOURCE_NS; pass --image"

info "== Reading the backups volume of $SOURCE_NS"
start_reader "$SOURCE_NS" "$IMAGE"
resolve_set "$SET_ARG"
verify_set

DATABASES=$(mf databases)
ROLES=$(mf roles)
HAS_BLOBS=false
if [ "$(mf blobs)" = "included" ]; then HAS_BLOBS=true; fi
HAS_REPOS=false
if [ "$(mf repos)" = "included" ]; then HAS_REPOS=true; fi
info "== Set $SET: taken $(mf created_at), version $(mf app_version)"
info "   databases: $DATABASES   attachment store: $(mf blobs)   repositories: $(mf repos)"
for r in $ROLES; do safe_ident "$r"; done
for d in $DATABASES; do
  safe_ident "$d"
  safe_ident "$(mf "db.$d.owner")"
  case $d in postgres | template0 | template1) die "the set names the system database '$d'; refusing to replace it" ;; esac
  [ "${#d}" -le 50 ] || die "database name '$d' is too long for the restore's scratch name"
done

if [ "$HAS_BLOBS" = true ]; then
  kubectl -n "$TARGET_NS" get pvc manythreads-blobs >/dev/null 2>&1 || die "$TARGET_NS has no volume manythreads-blobs to restore the attachment store into"
fi
if [ "$HAS_REPOS" = true ]; then
  kubectl -n "$TARGET_NS" get pvc manythreads-repos >/dev/null 2>&1 || die "$TARGET_NS has no volume manythreads-repos to restore the repositories into"
fi
kubectl -n "$TARGET_NS" get secret manythreads-db-owner >/dev/null 2>&1 || die "$TARGET_NS has no secret manythreads-db-owner (is the chart installed there?)"

echo "Plan: replace the databases ($DATABASES)$([ "$HAS_BLOBS" = true ] && echo ', the attachment store')$([ "$HAS_REPOS" = true ] && echo ' and the team repositories') in namespace '$TARGET_NS' with set $SET."
if [ "$CHECK_ONLY" = true ]; then
  echo "Check only: the set's checksums match. Nothing was changed."
  exit 0
fi
if [ "$ASSUME_YES" != true ]; then
  printf "This DELETES the current data in '%s'. Type the namespace name to continue: " "$TARGET_NS" >&2
  read -r answer
  [ "$answer" = "$TARGET_NS" ] || die "not confirmed"
fi

T0=$(date +%s)

# --- helper pod in the target namespace: database client plus both volumes -------------------------------------------------------------
HELPER="manythreads-restore-helper-$RANDOM"
MOUNTS=""; VOLS=""
if [ "$HAS_BLOBS" = true ]; then
  MOUNTS="$MOUNTS{ name: blobs, mountPath: /data/blobs }, "
  VOLS="$VOLS{ name: blobs, persistentVolumeClaim: { claimName: manythreads-blobs } }, "
fi
if [ "$HAS_REPOS" = true ]; then
  MOUNTS="$MOUNTS{ name: repos, mountPath: /data/repos }, "
  VOLS="$VOLS{ name: repos, persistentVolumeClaim: { claimName: manythreads-repos } }, "
fi
info "== Starting the helper pod in $TARGET_NS"
start_pod "$TARGET_NS" "$HELPER" "$IMAGE" <<YAML
      command: ["sleep", "7200"]
      securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      env:
        - { name: HOME, value: /tmp }
        - { name: PGHOST, value: manythreads-pg-rw }
        - { name: PGUSER, value: manythreads_owner }
        - { name: PGPASSWORD, valueFrom: { secretKeyRef: { name: manythreads-db-owner, key: password } } }
      volumeMounts: [${MOUNTS}{ name: work, mountPath: /work }]
  securityContext: { fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  volumes: [${VOLS}{ name: work, emptyDir: {} }]
YAML
h() { kubectl -n "$TARGET_NS" exec "$HELPER" -- "$@"; }
hi() { kubectl -n "$TARGET_NS" exec -i "$HELPER" -- "$@"; }

# stage FILE: copy a file of the set into the helper's /work and check its sha256 against the manifest.
stage() {
  local f=$1 want got
  want=$(mf "file.$f.sha256")
  [ -n "$want" ] || die "the manifest lists no checksum for $f"
  kubectl -n "$READER_NS" exec "$READER" -- cat "$SET_DIR/$f" | hi sh -c "cat > '/work/$f'"
  got=$(h sha256sum "/work/$f" | cut -d' ' -f1)
  [ "$got" = "$want" ] || die "$f arrived damaged (sha256 $got, expected $want)"
}

# --- stop the server so nothing writes while the data is replaced -----------------------------------------------------------------
REPLICAS=""
if kubectl -n "$TARGET_NS" get deployment manythreads-server >/dev/null 2>&1; then
  REPLICAS=$(kubectl -n "$TARGET_NS" get deployment manythreads-server -o jsonpath='{.spec.replicas}')
  info "== Stopping the server in $TARGET_NS (was $REPLICAS replica(s))"
  kubectl -n "$TARGET_NS" scale deployment manythreads-server --replicas=0 >/dev/null
  kubectl -n "$TARGET_NS" wait --for=delete pod -l app.kubernetes.io/component=server --timeout=180s >/dev/null 2>&1 || true
fi
restart_server() {
  if [ -n "$REPLICAS" ] && [ "$REPLICAS" != "0" ]; then
    info "== Starting the server again ($REPLICAS replica(s))"
    kubectl -n "$TARGET_NS" scale deployment manythreads-server --replicas="$REPLICAS" >/dev/null
  fi
}
# A restore that fails half way leaves the server stopped on purpose: started against a missing database it would migrate an empty one.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "$REPLICAS" ]; then
    info "The restore did not finish. The server in $TARGET_NS stays stopped (it had $REPLICAS replica(s)). Fix the cause and run the restore again."
  fi
  cleanup_created
  exit "$rc"
}
trap on_exit EXIT

# --- databases ------------------------------------------------------------------------------------------------------------------------
psql_admin() { h psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
for r in $ROLES; do
  # A role the dump refers to must exist before the data goes in. A missing one is created with LOGIN but no password (nobody can sign in as it
  # until the server's migrations or the memory engine's setup set one on start).
  psql_admin -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$r') THEN CREATE ROLE \"$r\" LOGIN; END IF; END \$\$" >/dev/null
done
for d in $DATABASES; do
  owner=$(mf "db.$d.owner")
  info "== Restoring database $d (owner $owner)"
  stage "db-$d.dump"
  stage "db-$d.settings.sql"
  # The dump is restored into a scratch database first and swapped in only when pg_restore finished: a damaged dump or a full disk leaves the
  # current database exactly as it was (the server stays stopped; run the restore again).
  scratch="${d}_restoring"
  psql_admin -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" -c "CREATE DATABASE \"$scratch\" OWNER \"$owner\""
  h pg_restore --exit-on-error --dbname="$scratch" "/work/db-$d.dump"
  psql_admin -c "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" -c "ALTER DATABASE \"$scratch\" RENAME TO \"$d\""
  psql_admin -f "/work/db-$d.settings.sql"
  h rm -f "/work/db-$d.dump" "/work/db-$d.settings.sql"
done

# --- attachment store and repositories ---------------------------------------------------------------------------------------------------
restore_tree() {
  local file=$1 dir=$2
  info "== Restoring $file into $dir"
  stage "$file"
  # The volume root stays (it is the mount); everything inside is replaced.
  h find "$dir" -mindepth 1 -delete
  # The tar starts with its own root entry "./"; the mount point is not ours to chmod, so that one entry is left out.
  h tar --extract --no-same-owner --touch --file="/work/$file" --directory="$dir" --wildcards --no-wildcards-match-slash './?*'
  h rm -f "/work/$file"
}
if [ "$HAS_BLOBS" = true ]; then restore_tree blobs.tar /data/blobs; fi
if [ "$HAS_REPOS" = true ]; then restore_tree repos.tar /data/repos; fi
restart_server

RESTORE_SECONDS=$(($(date +%s) - T0))
info "== Restore finished in ${RESTORE_SECONDS}s"
echo "restored set $SET into $TARGET_NS in ${RESTORE_SECONDS}s"
echo "Next: check https://<your domain>/readyz, sign in, open a file and a team repository. If you restored an old set, the blob garbage collector refuses to delete until the store and the database match (docs/deploy/backup.md)."
