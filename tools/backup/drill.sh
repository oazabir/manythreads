#!/usr/bin/env bash
# drill.sh: prove the newest backup set can be restored, without touching the live install.
#
#   tools/backup/drill.sh                 # newest set of the live namespace
#   tools/backup/drill.sh --set 20261029T021700Z --keep
#
# It makes a throwaway namespace with its own scratch Postgres and empty volumes, restores the set into it with restore.sh, then checks:
#   - every row count in the manifest matches the restored database,
#   - every file of the attachment store is back and one reads back byte for byte,
#   - every team repository is back and has a HEAD,
# prints PASS or FAIL with the measured RPO and RTO, and deletes the namespace (unless --keep). Exit code 0 only on PASS.
# Options: --set NAME|latest (default latest), --source-ns NS (default the live namespace), --image IMAGE, --keep.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SET_ARG=latest
SOURCE_NS=$LIVE_NAMESPACE
IMAGE=""
KEEP=false
while [ $# -gt 0 ]; do
  case $1 in
    --set) SET_ARG=${2:?--set needs a value}; shift 2 ;;
    --source-ns) SOURCE_NS=${2:?--source-ns needs a value}; shift 2 ;;
    --image) IMAGE=${2:?--image needs a value}; shift 2 ;;
    --keep) KEEP=true; shift ;;
    -h | --help) sed -n '2,/^set -e/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//' >&2; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

need kubectl
DRILL_NS="manythreads-drill-$(date -u +%H%M%S)-$RANDOM"
[ "$DRILL_NS" != "$LIVE_NAMESPACE" ] && [ "$DRILL_NS" != "$SOURCE_NS" ] || die "internal error: scratch namespace equals a real one"

on_exit() {
  local rc=$?
  cleanup_created
  if [ -n "$CREATED_NAMESPACE" ]; then
    if [ "$KEEP" = true ]; then
      info "Scratch namespace $CREATED_NAMESPACE kept; remove it with: kubectl delete namespace $CREATED_NAMESPACE"
    else
      # Only the namespace this run created, and only if it still carries the drill label.
      if kubectl get namespace -l manythreads-drill=true -o name 2>/dev/null | grep -qx "namespace/$CREATED_NAMESPACE"; then
        kubectl delete namespace "$CREATED_NAMESPACE" --wait=false >/dev/null 2>&1 || true
      fi
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

DRILL_START=$(date +%s)
[ -n "$IMAGE" ] || IMAGE=$(image_of_database "$SOURCE_NS")
[ -n "$IMAGE" ] || die "could not find the database image in $SOURCE_NS; pass --image"

info "== Reading the backups volume of $SOURCE_NS"
start_reader "$SOURCE_NS" "$IMAGE"
resolve_set "$SET_ARG"
verify_set
SET_AGE=$(($(date +%s) - $(epoch_of "$(mf created_at)")))
info "== Drilling set $SET (taken $(mf created_at), ${SET_AGE}s ago)"

# --- scratch namespace: a Postgres of its own and empty volumes ----------------------------------------------------------------------
blob_bytes=$(mf file.blobs.tar.bytes); repo_bytes=$(mf file.repos.tar.bytes)
size_mi() { echo $(((${1:-0} * 2) / 1048576 + 128)); }
kubectl create namespace "$DRILL_NS" >/dev/null
CREATED_NAMESPACE=$DRILL_NS
kubectl label namespace "$DRILL_NS" manythreads-drill=true pod-security.kubernetes.io/enforce=baseline --overwrite >/dev/null
PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
kubectl -n "$DRILL_NS" create secret generic manythreads-db-owner --from-literal=password="$PW" >/dev/null
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Service
metadata: { name: manythreads-pg-rw, namespace: $DRILL_NS }
spec: { selector: { app.kubernetes.io/component: drill-postgres }, ports: [{ port: 5432 }] }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: manythreads-blobs, namespace: $DRILL_NS }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: $(size_mi "$blob_bytes")Mi } } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: manythreads-repos, namespace: $DRILL_NS }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: $(size_mi "$repo_bytes")Mi } } }
YAML

PG=drill-postgres
info "== Starting a scratch Postgres in $DRILL_NS"
# The pod runs the database image's own binaries. The data lives in an emptyDir: gone with the namespace. The same pod mounts the two volumes so the
# checks below can read the restored files as the database user.
start_pod "$DRILL_NS" "$PG" "$IMAGE" <<YAML
      command:
        - bash
        - -c
        - |
          set -e
          export PATH="\$(ls -d /usr/lib/postgresql/*/bin | tail -n 1):\$PATH"
          printf '%s' "\$PGPASSWORD" >/tmp/pw
          # A sub-directory: the volume root belongs to root, and initdb must own (and chmod) the directory it initialises.
          initdb -D /var/lib/pgdata/data -U manythreads_owner -E UTF8 --locale=C.UTF-8 -A scram-sha-256 --pwfile=/tmp/pw >/dev/null
          echo 'host all all all scram-sha-256' >>/var/lib/pgdata/data/pg_hba.conf
          exec postgres -D /var/lib/pgdata/data -c listen_addresses='*' -c unix_socket_directories=/tmp
      env:
        - { name: PGUSER, value: manythreads_owner }
        - { name: PGHOST, value: /tmp }
        - { name: PGPASSWORD, valueFrom: { secretKeyRef: { name: manythreads-db-owner, key: password } } }
      readinessProbe: { exec: { command: [sh, -c, 'PATH=\$(ls -d /usr/lib/postgresql/*/bin | tail -n 1):\$PATH pg_isready -h /tmp'] }, periodSeconds: 2 }
      securityContext: { runAsNonRoot: true, runAsUser: 999, allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumeMounts:
        - { name: pgdata, mountPath: /var/lib/pgdata }
        - { name: blobs, mountPath: /data/blobs }
        - { name: repos, mountPath: /data/repos }
        - { name: tmp, mountPath: /tmp }
  securityContext: { fsGroup: 999, seccompProfile: { type: RuntimeDefault } }
  volumes:
    - { name: pgdata, emptyDir: {} }
    - { name: tmp, emptyDir: {} }
    - { name: blobs, persistentVolumeClaim: { claimName: manythreads-blobs } }
    - { name: repos, persistentVolumeClaim: { claimName: manythreads-repos } }
YAML
# The service selects the scratch pod by label.
kubectl -n "$DRILL_NS" label pod "$PG" app.kubernetes.io/component=drill-postgres --overwrite >/dev/null

# --- restore (this is the part that is timed as the RTO) ----------------------------------------------------------------------------------
RESTORE_START=$(date +%s)
"$HERE/restore.sh" --set "$SET" --source-ns "$SOURCE_NS" --target-ns "$DRILL_NS" --image "$IMAGE" --yes >&2

# --- checks -----------------------------------------------------------------------------------------------------------------------------
PASSED=0; FAILED=0
ok() { PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$*"; }
bad() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
pgx() { kubectl -n "$DRILL_NS" exec "$PG" -- "$@"; }
pq() { pgx psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

echo "Checks on set $SET:"
MAIN=$(mf rows_database)
[ -n "$MAIN" ] || MAIN=$(mf databases | cut -d' ' -f1)
for key in $(printf '%s\n' "$MANIFEST_TEXT" | sed -n 's/^rows\.\([a-z_]*\)=.*/\1/p'); do
  want=$(mf "rows.$key")
  got=$(pq "$MAIN" "SELECT count(*) FROM app.$key" 2>/dev/null || echo "error")
  if [ "$got" = "$want" ]; then ok "rows in app.$key: $got"; else bad "rows in app.$key: restored $got, manifest says $want"; fi
done

if [ "$(mf blobs)" = "included" ]; then
  want=$(reader_sh "tar -tvf '$SET_DIR/blobs.tar' | grep -c '^-' || true")
  got=$(pgx sh -c "find /data/blobs -type f ! -path '*/.tmp/*' | wc -l" | tr -d ' ')
  if [ "$got" = "$want" ]; then ok "attachment files: $got"; else bad "attachment files: restored $got, archive holds $want"; fi
  first=$(pgx sh -c "find /data/blobs -type f ! -path '*/.tmp/*' | head -n 1")
  if [ -n "$first" ]; then
    rel=${first#/data/blobs/}
    a=$(pgx sha256sum "$first" | cut -d' ' -f1)
    b=$(reader_sh "tar -xOf '$SET_DIR/blobs.tar' './$rel' | sha256sum" | cut -d' ' -f1)
    if [ -n "$a" ] && [ "$a" = "$b" ]; then ok "one attachment reads back byte for byte ($rel)"; else bad "attachment $rel differs from the archive"; fi
  else
    ok "attachment store is empty in the set (nothing to read back)"
  fi
fi
if [ "$(mf repos)" = "included" ]; then
  want=$(reader_sh "tar -tf '$SET_DIR/repos.tar' | grep -E '^\./[^/]+\.git/\$' | wc -l" | tr -d ' ')
  got=$(pgx sh -c "ls -d /data/repos/*.git 2>/dev/null | wc -l" | tr -d ' ')
  if [ "$got" = "$want" ]; then ok "team repositories: $got"; else bad "team repositories: restored $got, archive holds $want"; fi
  nohead=$(pgx sh -c "n=0; for r in /data/repos/*.git; do [ -e \"\$r\" ] || continue; [ -f \"\$r/HEAD\" ] || n=\$((n + 1)); done; echo \$n" | tr -d ' ')
  if [ "$nohead" = "0" ]; then ok "every repository has a HEAD"; else bad "$nohead repositories have no HEAD"; fi
fi

NOW=$(date +%s)
RTO=$((NOW - RESTORE_START))
TOTAL=$((NOW - DRILL_START))
echo
echo "Drill of set $SET (source namespace $SOURCE_NS, scratch namespace $DRILL_NS)"
echo "  RPO  the newest set is ${SET_AGE}s old: that much recent data would be lost if the site vanished now (worst case: one schedule interval plus the run time)"
echo "  RTO  ${RTO}s to restore and verify this set into a ready database and volumes (excludes provisioning a new cluster or machine); drill total ${TOTAL}s"
if [ "$FAILED" -eq 0 ] && [ "$PASSED" -gt 0 ]; then
  echo "PASS  ($PASSED checks)"
  exit 0
fi
echo "FAIL  ($FAILED failed, $PASSED passed)"
exit 1
