#!/usr/bin/env bash
# stage.sh — runs ON the devbox. The throwaway stage release of PLAN section 9: a second, unreachable copy of the site wired to the stand-ins of tools/fake-saas, seeded with the
# connectors world (seed v16), for the live probe's block B (e2e/screens/task.verify-bundle-d.shots.ts). It never touches the live namespace.
#
# Usage:
#   tools/devbox/stage.sh up        # fake-saas on 10.0.2.15:18090 (control 18091), release `manythreads-stage`, seed v16, port-forward to 127.0.0.1:18080
#   tools/devbox/stage.sh down      # port-forwards, fake-saas and the whole namespace removed
#   tools/devbox/stage.sh status
#
# Needs: images for $TAG in k3s (tools/devbox/ci.sh or deploy.sh built them; default TAG is the short sha of HEAD); the demo layer (server-demo, demo-fakes) is built here when missing.
# Variables: TAG, STAGE_NAMESPACE (manythreads-stage), STAGE_PORT (18080), STAGE_API_PORT (18081), STAGE_HOST (10.0.2.15), FAKE_SAAS_PORT (18090), STAGE_STATE_DIR (/tmp/manythreads-stage).
# STAGE_PROFILE=<a,b>  (Bundle E) adds deploy/helm/manythreads/values-stage-<a>.yaml, <b>... after values-stage.yaml. Known profiles: runners, airgap, otel (any other word is refused).
#   `runners` also makes the pods namespace `manythreads-stage-bots` (Claude and Codex pods, Hermes pods of the stage) and reserves a host port for the stand-ins the profile runs
#   (STAGE_STANDIN_PORT, default 18100, printed at the end). `down` removes that namespace too. Like the release namespace, the bots namespace is a fixed name that no variable changes.
# The fake values (seed key, bot token) are made up here and live only in $STAGE_STATE_DIR; nothing in them is a secret. About 1.5 GB of memory while it runs.
# Written for the integration pass; not run by the coder that wrote it.
set -euo pipefail
cd "$(dirname "$0")/../.."
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"  # helm has no default kubeconfig on the devbox (deploy.sh sets the same)

NS="${STAGE_NAMESPACE:-manythreads-stage}"
PORT="${STAGE_PORT:-18080}"
API_PORT="${STAGE_API_PORT:-18081}"
HOST="${STAGE_HOST:-10.0.2.15}"
FAKE_PORT="${FAKE_SAAS_PORT:-18090}"
STATE="${STAGE_STATE_DIR:-/tmp/manythreads-stage}"
SEED_KEY="stage-seed"
TG_TOKEN="${FAKE_SAAS_TELEGRAM_TOKEN:-111111:stage-fake-telegram-bot-token}"
TAG="${TAG:-$(git rev-parse --short=12 HEAD)}"
# The stage lives in ONE namespace and one release, both named manythreads-stage. Anything else (above all the live namespace `manythreads`) is refused before any kubectl
# or helm call, so a stray STAGE_NAMESPACE can never point `up`, `down` or `status` at the production release. Nothing in this script runs `kubectl exec` or touches a pod.
readonly STAGE_NS="manythreads-stage"
[ "$NS" = "$STAGE_NS" ] || { printf 'FAILED: STAGE_NAMESPACE must be %s (got "%s"); this script never touches any other namespace\n' "$STAGE_NS" "$NS" >&2; exit 1; }
# The pods namespace of the `runners` profile: the only other namespace this script ever touches, also a fixed name.
readonly STAGE_BOTS_NS="manythreads-stage-bots"
STANDIN_PORT="${STAGE_STANDIN_PORT:-18100}"
# Profiles: a comma list of words from this list only; each one is a values file that must exist. Anything else is refused before any kubectl or helm call.
PROFILES="${STAGE_PROFILE:-}"
PROFILE_ARGS=()
HAS_RUNNERS=0
if [ -n "$PROFILES" ]; then
  IFS=',' read -r -a PROFILE_LIST <<<"$PROFILES"
  for p in "${PROFILE_LIST[@]}"; do
    case "$p" in
      runners|airgap|otel) ;;
      *) printf 'FAILED: STAGE_PROFILE word "%s" is not one of runners, airgap, otel\n' "$p" >&2; exit 1 ;;
    esac
    [ -f "deploy/helm/manythreads/values-stage-$p.yaml" ] || { printf 'FAILED: deploy/helm/manythreads/values-stage-%s.yaml is missing\n' "$p" >&2; exit 1; }
    PROFILE_ARGS+=(-f "deploy/helm/manythreads/values-stage-$p.yaml")
    [ "$p" = runners ] && HAS_RUNNERS=1
  done
fi
step() { printf '\n=== %s ===\n' "$1"; }
die() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }
stop_pid() {
  local file="${STATE:?}/$1.pid"
  # only a process this script started (a stale pid file may name an unrelated process now)
  if [ -f "$file" ] && tr '\0' ' ' <"/proc/$(cat "$file")/cmdline" 2>/dev/null | grep -Eq 'kubectl|fake-saas|pnpm|node'; then pkill -P "$(cat "$file")" 2>/dev/null || true; kill "$(cat "$file")" 2>/dev/null || true; fi
}

down() {
  step "stage down"
  stop_pid pf-web; stop_pid pf-api; stop_pid pf-pg; stop_pid fake-saas
  # pnpm starts tsx, which starts node: stop_pid reaches only the first two, so the listener on the stand-ins' ports is stopped by its command line too
  pkill -f "src/cli.ts --host $HOST --public-host $HOST --port $FAKE_PORT" 2>/dev/null || true
  helm uninstall "$STAGE_NS" -n "$STAGE_NS" >/dev/null 2>&1 || true
  kubectl delete namespace "$STAGE_NS" --ignore-not-found --wait=true --timeout=300s
  # the pods namespace exists only when a `runners` stage made it; deleting it is harmless when it does not
  kubectl delete namespace "$STAGE_BOTS_NS" --ignore-not-found --wait=true --timeout=300s
  echo "the stage is gone (the pid files in $STATE are stale and are overwritten by the next up)"
}

have_image() { k3s ctr -n k8s.io images ls -q | grep -q "$1"; }
import_image() { docker save "$1" | k3s ctr -n k8s.io images import - | tail -n 2; docker rmi "$1" >/dev/null 2>&1 || true; }
alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

up() {
  mkdir -p "$STATE"
  alive fake-saas && die "the stage is already up (run: stage.sh down)"
  have_image "manythreads/server:$TAG" || die "no image manythreads/server:$TAG in k3s (build it with tools/devbox/ci.sh or deploy.sh first, or set TAG)"

  step "the demo layer (fake-llm, fake-hindsight)"
  # The demo images are built FROM the server image, which docker must hold: deploy.sh and ci.sh drop docker's copy once k3s has it, so it is loaded back from k3s here and dropped again after.
  LOADED_SERVER=0
  if { ! have_image "manythreads/server-demo:$TAG" || ! have_image "manythreads/demo-fakes:$TAG"; } && ! docker image inspect "manythreads/server:$TAG" >/dev/null 2>&1; then
    k3s ctr -n k8s.io images export - "docker.io/manythreads/server:$TAG" | docker load >/dev/null || die "could not load manythreads/server:$TAG from k3s into docker"
    LOADED_SERVER=1
  fi
  if ! have_image "manythreads/server-demo:$TAG"; then
    docker build -f deploy/docker/server-demo.Dockerfile --build-arg SERVER_TAG="$TAG" -t "manythreads/server-demo:$TAG" .
    import_image "manythreads/server-demo:$TAG"
  fi
  if ! have_image "manythreads/demo-fakes:$TAG"; then
    docker build -f deploy/docker/demo-fakes.Dockerfile --build-arg SERVER_TAG="$TAG" -t "manythreads/demo-fakes:$TAG" .
    import_image "manythreads/demo-fakes:$TAG"
  fi
  [ "$LOADED_SERVER" = 0 ] || docker rmi "manythreads/server:$TAG" >/dev/null 2>&1 || true

  step "fake-saas on $HOST:$FAKE_PORT (control $((FAKE_PORT + 1)))"
  # The grants are the ones of the seed (packages/test-utils seed-connectors.ts SEED_CONNECTORS.grants); the seed's runner seals tokens for them.
  FAKE_SAAS_TELEGRAM_TOKEN="$TG_TOKEN" FAKE_SAAS_TELEGRAM_BOT_USERNAME=manythreads_stage_bot \
    nohup pnpm -C tools/fake-saas start --host "$HOST" --public-host "$HOST" --port "$FAKE_PORT" --seed "$SEED_KEY" \
      --seed-grant google:nadia@kahf.example --seed-grant google:omar@kahf.example --seed-grant google:rafi@kahf.example --seed-grant microsoft:lena@kahf.example \
      >"$STATE/fake-saas.log" 2>&1 &
  echo $! >"$STATE/fake-saas.pid"
  for _ in $(seq 1 60); do grep -q '^FAKE_SAAS ' "$STATE/fake-saas.log" 2>/dev/null && break; sleep 1; done
  grep -q '^FAKE_SAAS ' "$STATE/fake-saas.log" || die "fake-saas did not start (see $STATE/fake-saas.log)"
  # The server env: the line's `env` holds the base address of every stand-in (Google, Microsoft, Telegram and the rest) and the control address.
  node -e '
    const fs = require("fs");
    const line = fs.readFileSync(process.argv[1], "utf8").split("\n").find((l) => l.startsWith("FAKE_SAAS "));
    const env = JSON.parse(line.slice(10)).env;
    const out = ["server:", "  env:", ...Object.entries(env).map(([k, v]) => "    " + k + ": " + JSON.stringify(String(v)))];
    fs.writeFileSync(process.argv[2], out.join("\n") + "\n");
  ' "$STATE/fake-saas.log" "$STATE/values-fake-bases.yaml"
  CONTROL="http://$HOST:$((FAKE_PORT + 1))"
  curl -fsS "$CONTROL/__fake/health" >/dev/null || die "the stand-ins' control port does not answer at $CONTROL"

  step "the release in $NS"
  kubectl delete namespace "$NS" --ignore-not-found --wait=true --timeout=300s
  kubectl create namespace "$NS"
  if [ "$HAS_RUNNERS" = 1 ]; then
    kubectl delete namespace "$STAGE_BOTS_NS" --ignore-not-found --wait=true --timeout=300s
    kubectl create namespace "$STAGE_BOTS_NS"
    # The chart (templates/hermes-pods.yaml) renders this Namespace itself; Helm refuses to take over one it did not make unless it carries these marks.
    kubectl label namespace "$STAGE_BOTS_NS" app.kubernetes.io/managed-by=Helm --overwrite
    kubectl annotate namespace "$STAGE_BOTS_NS" meta.helm.sh/release-name=manythreads-stage meta.helm.sh/release-namespace="$NS" --overwrite
    echo "pods namespace $STAGE_BOTS_NS made; stand-ins use host port $STANDIN_PORT (STAGE_STANDIN_PORT)"
  fi
  helm upgrade --install manythreads-stage ./deploy/helm/manythreads -n "$NS" \
    -f deploy/helm/manythreads/values-ci.yaml -f deploy/helm/manythreads/values-demo.yaml -f deploy/helm/manythreads/values-stage.yaml \
    -f "$STATE/values-fake-bases.yaml" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} --set imageTag="$TAG" --wait --timeout 15m
  kubectl -n "$NS" rollout status deploy/manythreads-server --timeout=300s
  kubectl -n "$NS" rollout status deploy/manythreads-web --timeout=300s

  step "port-forwards (web $PORT, server $API_PORT, database 15432)"
  kubectl -n "$NS" port-forward svc/manythreads-web "$PORT:80" >/dev/null 2>&1 &
  echo $! >"$STATE/pf-web.pid"
  kubectl -n "$NS" port-forward svc/manythreads-server "$API_PORT:3000" >/dev/null 2>&1 &
  echo $! >"$STATE/pf-api.pid"
  PG_SVC=$(kubectl -n "$NS" get svc -o name | grep -E 'rw$|postgres$' | head -n1)
  [ -n "$PG_SVC" ] || die "no database service found in $NS"
  kubectl -n "$NS" port-forward "$PG_SVC" 15432:5432 >/dev/null 2>&1 &
  echo $! >"$STATE/pf-pg.pid"
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/readyz" 2>/dev/null && break; sleep 2; done
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/readyz" || die "the stage does not answer /readyz"

  step "seed v16 (the connectors world on top of the demo seed)"
  # The seed job of the chart has run (--wait above); this adds the connectors world. It seals the sign-ins with the pod's own KMS key, so it reads that key from the cluster.
  KMS_KEY=$(kubectl -n "$NS" get secret manythreads-server-secrets -o jsonpath='{.data.kms-key}' | base64 -d)
  SYS_PW=$(kubectl -n "$NS" get secret manythreads-db-system -o jsonpath='{.data.password}' | base64 -d)
  MANYTHREADS_KMS_KEY="$KMS_KEY" \
  STAGE_SERVER_URL="http://127.0.0.1:$API_PORT" \
  STAGE_SYSTEM_DATABASE_URL="postgres://manythreads_system:$SYS_PW@127.0.0.1:15432/manythreads" \
  FAKE_SAAS_CONTROL="$CONTROL" FAKE_SAAS_SEED_KEY="$SEED_KEY" FAKE_SAAS_TELEGRAM_TOKEN="$TG_TOKEN" \
    pnpm exec tsx tools/devbox/stage-seed-connectors.ts

  cat <<MSG

the stage is up:
  site            http://127.0.0.1:$PORT   (personas <key>@kahf.example, the known test password)
  stand-ins       $CONTROL
Run the probe:
  MANYTHREADS_STAGE_URL=http://127.0.0.1:$PORT FAKE_SAAS_CONTROL=$CONTROL pnpm -C e2e exec playwright test -c screens/task.config.ts verify-bundle-d --retries=0 --workers=1
Take it down: tools/devbox/stage.sh down
profiles        ${PROFILES:-none}$([ "$HAS_RUNNERS" = 1 ] && printf '   (pods namespace %s, stand-in host port %s)' "$STAGE_BOTS_NS" "$STANDIN_PORT")
MSG
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status)
    kubectl -n "$NS" get pods 2>/dev/null || echo "no stage release"
    if alive fake-saas; then echo "fake-saas running (pid $(cat "$STATE/fake-saas.pid"))"; else echo "fake-saas not running"; fi
    ;;
  *) echo "usage: stage.sh up | down | status"; exit 2 ;;
esac
