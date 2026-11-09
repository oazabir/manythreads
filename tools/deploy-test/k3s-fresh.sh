#!/usr/bin/env bash
# k3s-fresh.sh: install manythreads on a brand-new k3s, using the commands of docs/deploy/k3s.md and nothing else (PLAN P10-09, decision E27).
#
#   flock /tmp/manythreads-test.lock tools/deploy-test/k3s-fresh.sh            # run the test
#   tools/deploy-test/k3s-fresh.sh --print-steps                               # print the commands it would run, change nothing
#
# What it does:
#   1. refuses to start while the disk is more than 80 % full, a CI run (tools/devbox/ci.sh) or a stage is up, or another copy runs;
#   2. starts a rancher/k3s container (--privileged, its own Docker network and volume, a unique name) and waits for the node;
#   3. takes the fenced blocks tagged `sh k3s-test` out of docs/deploy/k3s.md and runs them in order, in one shell, from the repository root;
#      `k3s` is a small wrapper that runs the command inside the container, `kubectl` and `helm` talk to it through a kubeconfig of their own;
#   4. checks /readyz answers 200 and the first administrator can sign in (the last blocks of the page do it; this script asks again);
#   5. removes the container, the network, the volume, the images it made or pulled and the files it wrote, whatever the outcome.
# It never talks to any other cluster except for ONE read-only look at whether the stage namespace exists. Exit code 0 only when everything passed.
#
# Settings (environment): K3S_IMAGE (default rancher/k3s:v1.36.5-k3s1), K3S_FRESH_LOG (default /tmp/k3s-fresh.log), K3S_FRESH_MAX_DISK (default 80, percent),
# K3S_FRESH_KEEP=1 (leave everything in place to look at it; remove it yourself with `docker rm -fv` and `docker network rm`).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PAGE=docs/deploy/k3s.md
cd "$REPO"

if [ "${1:-}" = "--print-steps" ]; then
  exec npx --no-install tsx tools/deploy-test/src/extract.ts "$PAGE"
fi

LOG=${K3S_FRESH_LOG:-/tmp/k3s-fresh.log}
exec > >(tee "$LOG") 2>&1

K3S_IMAGE=${K3S_IMAGE:-rancher/k3s:v1.36.5-k3s1}
MAX_DISK=${K3S_FRESH_MAX_DISK:-80}
NAME="mt-k3s-fresh-$$"
NET="$NAME"
VOL="$NAME-data"
WORK=""
STARTED=$(date +%s)
RESULT=FAILED

say() { printf '\n[%s +%ss] %s\n' "$(date -u +%H:%M:%S)" "$(( $(date +%s) - STARTED ))" "$*"; }
die() { say "REFUSED: $*"; exit 2; }
disk_percent() { df --output=pcent / | tail -n 1 | tr -dc '0-9'; }

# --- 1. preconditions -------------------------------------------------------------------------------------------------------------------------------------------
for tool in docker helm kubectl curl git npx; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
[ "$(disk_percent)" -lt "$MAX_DISK" ] || die "the disk is $(disk_percent) % full (the limit is $MAX_DISK %); free some space first"
if pgrep -fx 'bash tools/devbox/ci.sh.*' >/dev/null 2>&1; then die "a CI run (tools/devbox/ci.sh) is in progress; it shares this machine"; fi
if docker ps -a --format '{{.Names}}' | grep -q '^mt-k3s-fresh-'; then die "another k3s-fresh container exists ($(docker ps -a --format '{{.Names}}' | grep '^mt-k3s-fresh-' | head -n 1)); remove it first"; fi
# One read-only look at the machine's own cluster: a stage in it means a test of someone else is using this machine's memory.
if kubectl --request-timeout=10s get namespace manythreads-stage -o name >/dev/null 2>&1; then die "a stage is up (namespace manythreads-stage); run stage.sh down first"; fi
[ ! -e my-values.yaml ] || die "my-values.yaml exists in the repository root; the page writes that file, so move it away first"

DISK_BEFORE=$(disk_percent)
IMAGES_BEFORE=$(docker images -q --no-trunc | sort -u)
say "start: disk ${DISK_BEFORE} %, free memory $(free -m | awk '/^Mem:/ {print $7}') MB, k3s image $K3S_IMAGE"

# --- 5. clean-up, registered first so every later failure still runs it -------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  set +e
  if [ "${K3S_FRESH_KEEP:-}" = 1 ]; then
    say "K3S_FRESH_KEEP=1: leaving container $NAME, network $NET, volume $VOL and $WORK in place"
    return
  fi
  say "clean-up"
  # everything the steps left running (the port-forward the page starts): found by the marker in its environment, never by name
  for env in /proc/[0-9]*/environ; do
    pid=$(basename "$(dirname "$env")")
    [ "$pid" != "$$" ] || continue
    { tr '\0' '\n' <"$env" | grep -qx "K3S_FRESH_RUN=$NAME" && kill "$pid"; } 2>/dev/null
  done
  docker rm -fv "$NAME" >/dev/null 2>&1
  docker volume rm -f "$VOL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -f "$REPO/my-values.yaml"
  [ -z "$WORK" ] || rm -rf "$WORK"
  # images: whatever is new since the start (the k3s image, the three built, the base images pulled), and the build cache beyond the usual 3 GB
  local now id
  now=$(docker images -q --no-trunc | sort -u)
  for id in $(comm -13 <(printf '%s\n' "$IMAGES_BEFORE") <(printf '%s\n' "$now")); do docker rmi -f "$id" >/dev/null 2>&1; done
  docker builder prune -f --keep-storage 3gb >/dev/null 2>&1
  say "$RESULT. disk ${DISK_BEFORE} % before, $(disk_percent) % after; log: $LOG"
  return "$code"
}
trap cleanup EXIT

# --- 2. the cluster ---------------------------------------------------------------------------------------------------------------------------------------------
WORK=$(mktemp -d /tmp/mt-k3s-fresh.XXXXXX)
mkdir -p "$WORK/bin" "$WORK/helm/config" "$WORK/helm/cache" "$WORK/helm/data"
say "start the k3s container $NAME"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
# A privileged container is how k3s runs inside Docker. The data directory is a volume (k3s cannot keep it on the overlay filesystem); the API port is published on loopback only.
docker run -d --name "$NAME" --hostname "$NAME" --privileged --network "$NET" \
  -v "$VOL:/var/lib/rancher/k3s" --tmpfs /run --tmpfs /var/run \
  -p 127.0.0.1::6443 \
  "$K3S_IMAGE" server --write-kubeconfig-mode 644 --tls-san 127.0.0.1 >/dev/null
API=$(docker port "$NAME" 6443/tcp | head -n 1 | sed 's/.*://')
[ -n "$API" ] || die "the container has no API port"

for _ in $(seq 1 120); do docker exec "$NAME" test -s /etc/rancher/k3s/k3s.yaml 2>/dev/null && break; sleep 2; done
docker exec "$NAME" cat /etc/rancher/k3s/k3s.yaml | sed "s|https://127.0.0.1:6443|https://127.0.0.1:$API|" >"$WORK/kubeconfig"
chmod 600 "$WORK/kubeconfig"
# `k3s ctr ...` of the page runs inside the container, where k3s lives. On a host `k3s ctr` is k3s' own containerd client; in the rancher/k3s image that client is the
# separate command `ctr`, and k3s' containerd listens on its own socket.
cat >"$WORK/bin/k3s" <<SHIM
#!/bin/sh
if [ "\$1" = ctr ]; then shift; exec docker exec -i $NAME ctr --address /run/k3s/containerd/containerd.sock "\$@"; fi
exec docker exec -i $NAME k3s "\$@"
SHIM
chmod +x "$WORK/bin/k3s"

export KUBECONFIG="$WORK/kubeconfig"
export PATH="$WORK/bin:$PATH"
export HELM_CONFIG_HOME="$WORK/helm/config" HELM_CACHE_HOME="$WORK/helm/cache" HELM_DATA_HOME="$WORK/helm/data"
export K3S_FRESH_RUN="$NAME"
say "wait for the API at 127.0.0.1:$API"
for _ in $(seq 1 90); do kubectl --request-timeout=5s get nodes >/dev/null 2>&1 && break; sleep 2; done
kubectl --request-timeout=5s get nodes >/dev/null 2>&1 || { docker logs --tail 40 "$NAME" || true; die "the k3s API did not come up in 3 minutes"; }

# --- 3. the page ------------------------------------------------------------------------------------------------------------------------------------------------
npx --no-install tsx tools/deploy-test/src/extract.ts "$PAGE" >"$WORK/steps.sh"
say "run the $(grep -c "^echo '=== " "$WORK/steps.sh") steps of $PAGE"
bash "$WORK/steps.sh"

# --- 4. the verdict -----------------------------------------------------------------------------------------------------------------------------------------------
say "check the result"
READY=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/readyz || true)
[ "$READY" = 200 ] || { say "FAILED: /readyz answered $READY, not 200"; exit 1; }
kubectl -n manythreads get pods
say "PASSED: /readyz answered 200 and the first administrator signed in"
RESULT=PASSED
