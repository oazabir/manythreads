#!/usr/bin/env bash
# secrets-encrypt.sh — runs ON the devbox. Turns on, checks and rotates k3s "Secrets encryption at rest" (PLAN P19-12, owner decision O7, Bundle E blocker 3). THE OWNER RUNS THIS. It is
# written and tested with stand-in commands only; no coding session runs `enable` or `rotate`.
#
# Why: a runner's sign-in file (a live Claude or Codex login) and every other Kubernetes Secret sit in k3s' datastore as plain base64 until encryption is on
# (`k3s secrets-encrypt status` says "Disabled, no configuration file found" today). Turning it on restarts the k3s server: for a minute the API does not answer and the
# kubelet may restart containers, so the live site can blink. Do it in a quiet hour, with the backup of tools/backup/ fresh.
#
# Usage:
#   tools/devbox/secrets-encrypt.sh status                          # read only: what k3s says, and whether the datastore really holds a Secret encrypted
#   tools/devbox/secrets-encrypt.sh verify                          # read only: the datastore check alone
#   tools/devbox/secrets-encrypt.sh enable  --yes-i-am-the-owner    # enable, restart k3s, re-encrypt every Secret, verify
#   tools/devbox/secrets-encrypt.sh rotate  --yes-i-am-the-owner    # new key, re-encrypt every Secret, verify (no restart on a single server)
#   add --dry-run to `enable` or `rotate` to print what would run and change nothing.
#
# Roll back (if the site does not come back): `k3s secrets-encrypt disable`, `systemctl restart k3s`, `k3s secrets-encrypt reencrypt`. The keys stay in
# /var/lib/rancher/k3s/server/cred/encryption-config.json: back that file up with the datastore; a datastore without its key cannot be read.
#
# Variables (for the tests; the defaults are right on the devbox): K3S (k3s), KUBECTL (kubectl), SYSTEMCTL (systemctl), K3S_DB (the sqlite datastore), PYTHON (python3), WAIT_SECONDS (900), SETTLE_SECONDS (5, the pause after the restart).
set -euo pipefail

K3S="${K3S:-k3s}"
KUBECTL="${KUBECTL:-kubectl}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
PYTHON="${PYTHON:-python3}"
K3S_DB="${K3S_DB:-/var/lib/rancher/k3s/server/db/state.db}"
WAIT_SECONDS="${WAIT_SECONDS:-900}"
SETTLE_SECONDS="${SETTLE_SECONDS:-5}"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

die() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$1"; }

ACTION="${1:-}"
[ $# -gt 0 ] && shift
OWNER=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --yes-i-am-the-owner) OWNER=1 ;;
    --dry-run) DRY=1 ;;
    *) printf 'usage: secrets-encrypt.sh status | verify | enable --yes-i-am-the-owner [--dry-run] | rotate --yes-i-am-the-owner [--dry-run]\n' >&2; exit 2 ;;
  esac
done

# Whether the datastore holds Secrets encrypted: reads (read-only) the stored value of up to three Secrets and looks at its first bytes, which are `k8s:enc:` for an encrypted
# value. Only the kind of prefix is printed, never a value. Returns 0 when every Secret looked at is encrypted, 1 when one is plain, 3 when the datastore cannot be read.
verify() {
  [ -r "$K3S_DB" ] || { echo "datastore $K3S_DB cannot be read here (is this the k3s server? are you root?)"; return 3; }
  "$PYTHON" -I - "$K3S_DB" <<'PY'
import sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
rows = db.execute("select name, value from kine where name like '/registry/secrets/%' and value is not null order by id desc limit 200").fetchall()
seen = {}
for name, value in rows:
    if name in seen:
        continue
    seen[name] = bytes(value)[:8] == b"k8s:enc:"
    if len(seen) >= 3:
        break
if not seen:
    print("no Secret found in the datastore")
    sys.exit(3)
for name, enc in seen.items():
    print("%-9s %s" % ("encrypted" if enc else "PLAIN", name))
sys.exit(0 if all(seen.values()) else 1)
PY
}

pods_not_running() { "$KUBECTL" get pods -A --no-headers 2>/dev/null | awk '$4 != "Running" && $4 != "Completed" { n++ } END { print n + 0 }'; }

wait_api() {
  local waited=0
  until "$KUBECTL" get --raw=/readyz >/dev/null 2>&1; do
    sleep 3; waited=$((waited + 3))
    [ "$waited" -lt "$WAIT_SECONDS" ] || die "the Kubernetes API did not come back in ${WAIT_SECONDS}s (see: journalctl -u k3s)"
  done
}

wait_reencrypted() {
  local waited=0
  until "$K3S" secrets-encrypt status 2>&1 | grep -q 'reencrypt_finished'; do
    sleep 3; waited=$((waited + 3))
    [ "$waited" -lt "$WAIT_SECONDS" ] || die "re-encryption did not finish in ${WAIT_SECONDS}s (see: $K3S secrets-encrypt status)"
  done
}

need_owner() {
  [ "$OWNER" = 1 ] || { printf 'REFUSED: `%s` changes the live cluster (a k3s restart). Run it yourself and add --yes-i-am-the-owner. Nothing was done.\n' "$ACTION" >&2; exit 2; }
}

# Prints (dry run) or runs a command.
run() {
  if [ "$DRY" = 1 ]; then printf 'would run: %s\n' "$*"; else "$@"; fi
}

case "$ACTION" in
  status)
    step "k3s says"
    "$K3S" secrets-encrypt status
    step "the datastore"
    verify || true
    ;;
  verify)
    verify
    ;;
  enable)
    need_owner
    step "before"
    "$K3S" secrets-encrypt status || true
    echo "pods not Running or Completed: $(pods_not_running)"
    run "$K3S" secrets-encrypt enable
    run "$SYSTEMCTL" restart k3s
    if [ "$DRY" = 1 ]; then echo "would wait for the API, then: $K3S secrets-encrypt reencrypt, then verify"; exit 0; fi
    step "wait for the API"
    sleep "$SETTLE_SECONDS"
    wait_api
    step "re-encrypt every Secret"
    "$K3S" secrets-encrypt reencrypt
    wait_reencrypted
    step "after"
    "$K3S" secrets-encrypt status
    verify || die "the datastore still holds a plain Secret (see above)"
    echo "pods not Running or Completed: $(pods_not_running)"
    echo "DONE: Secrets are encrypted at rest. Back up /var/lib/rancher/k3s/server/cred/encryption-config.json with the datastore."
    ;;
  rotate)
    need_owner
    step "before"
    "$K3S" secrets-encrypt status || true
    run "$K3S" secrets-encrypt rotate-keys
    if [ "$DRY" = 1 ]; then echo "would then verify"; exit 0; fi
    wait_api
    step "after"
    "$K3S" secrets-encrypt status
    verify || die "the datastore holds a plain Secret after the rotation (see above)"
    echo "DONE: new key in use, every Secret re-encrypted."
    ;;
  *)
    printf 'usage: secrets-encrypt.sh status | verify | enable --yes-i-am-the-owner [--dry-run] | rotate --yes-i-am-the-owner [--dry-run]\n' >&2
    exit 2
    ;;
esac
