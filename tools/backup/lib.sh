#!/usr/bin/env bash
# lib.sh: helpers shared by restore.sh, drill.sh and pull.sh. Sourced, never run. Everything goes through kubectl; nothing here needs a
# database client or the backup volume on your own machine. See docs/deploy/backup.md.

LIVE_NAMESPACE=${MANYTHREADS_LIVE_NAMESPACE:-manythreads}

info() { printf '%s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found in PATH"
}

# Pods and namespaces this run created, removed again by cleanup_created (call it from your own EXIT trap).
CREATED_PODS=()
CREATED_NAMESPACE=""

cleanup_created() {
  local entry ns name
  for entry in "${CREATED_PODS[@]+"${CREATED_PODS[@]}"}"; do
    ns=${entry%%/*}
    name=${entry#*/}
    kubectl -n "$ns" delete pod "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  CREATED_PODS=()
}

# image_of_database NAMESPACE: the image the database pods of that install run (pg_dump / pg_restore of the matching major version).
image_of_database() {
  local ns=$1 img
  img=$(kubectl -n "$ns" get cronjob manythreads-backup -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}' 2>/dev/null || true)
  if [ -z "$img" ]; then
    img=$(kubectl -n "$ns" get pods -l cnpg.io/cluster=manythreads-pg -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null || true)
  fi
  printf '%s' "$img"
}

# start_pod NAMESPACE NAME IMAGE: reads the rest of the pod spec (YAML after "spec:" at two-space indent) from stdin, creates the pod and waits.
start_pod() {
  local ns=$1 name=$2 image=$3
  {
    printf 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: %s\n  namespace: %s\n  labels:\n    app.kubernetes.io/component: backup-tool\nspec:\n' "$name" "$ns"
    printf '  restartPolicy: Never\n  automountServiceAccountToken: false\n  terminationGracePeriodSeconds: 1\n'
    printf '  containers:\n    - name: main\n      image: %s\n      imagePullPolicy: IfNotPresent\n' "$image"
    cat
  } | kubectl apply -f - >/dev/null || die "could not create pod $name in $ns"
  CREATED_PODS+=("$ns/$name")
  kubectl -n "$ns" wait --for=condition=Ready "pod/$name" --timeout=240s >/dev/null ||
    die "pod $name in $ns did not become ready (kubectl -n $ns describe pod $name)"
}

# start_reader SOURCE_NAMESPACE IMAGE: a pod that mounts the backups volume read-only; sets READER (pod name) and READER_NS.
start_reader() {
  local ns=$1 image=$2
  READER="manythreads-backup-reader-$RANDOM"
  READER_NS=$ns
  kubectl -n "$ns" get pvc manythreads-backups >/dev/null 2>&1 || die "no backups volume (pvc manythreads-backups) in namespace $ns: is backup.enabled set?"
  start_pod "$ns" "$READER" "$image" <<YAML
      command: ["sleep", "3600"]
      securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumeMounts: [{ name: backups, mountPath: /backups, readOnly: true }]
  securityContext: { fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  volumes: [{ name: backups, persistentVolumeClaim: { claimName: manythreads-backups, readOnly: true } }]
YAML
}

reader_sh() { kubectl -n "$READER_NS" exec "$READER" -- sh -c "$1"; }

# resolve_set REQUESTED: "latest" or a set name; sets SET, SET_DIR and MANIFEST_TEXT, and checks the set is whole.
resolve_set() {
  local want=$1
  case $want in
    latest) SET=$(reader_sh "ls -1 /backups | grep -E '^[0-9]{8}T[0-9]{6}Z\$' | sort | tail -n 1") ;;
    *) SET=$want ;;
  esac
  [ -n "$SET" ] || die "the backups volume holds no backup set yet"
  printf '%s' "$SET" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' || die "'$SET' is not a set name (expected like 20261029T021700Z)"
  SET_DIR="/backups/$SET"
  MANIFEST_TEXT=$(reader_sh "cat '$SET_DIR/manifest.txt'" 2>/dev/null) || die "set $SET has no manifest.txt (not a backup set)"
  [ "$(mf complete)" = "yes" ] || die "set $SET is not marked complete"
}

# mf KEY: a value from the manifest of the resolved set (empty when absent).
mf() { printf '%s\n' "$MANIFEST_TEXT" | sed -n "s/^$1=//p" | head -n 1; }

# verify_set: sha256 of every file of the set, checked where it lives.
verify_set() {
  reader_sh "cd '$SET_DIR' && sha256sum -c sha256sums.txt" >&2 || die "checksum mismatch in set $SET: this set is damaged; use an earlier one"
}

# safe_ident WORD: refuse anything that is not a plain database or role name (they end up in SQL).
safe_ident() {
  printf '%s' "$1" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$' || die "unexpected name '$1' in the manifest"
}

# epoch_of ISO8601: seconds since 1970 for a UTC timestamp like 2026-10-29T02:17:03Z.
epoch_of() { date -u -d "$1" +%s; }
