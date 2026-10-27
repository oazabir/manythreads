#!/usr/bin/env bash
# ci.sh — runs ON the devbox, and is the whole pipeline: install, lint, typecheck, build
# the images, deploy the candidate into the CI namespace, test it there, and only then
# promote the same build to the live namespace.
#
# The GitHub runner does nothing but carry the code here (see .github/workflows/ci.yml).
# Building and testing on a GitHub runner costs minutes we do not have, and its image
# carries no browser, so the end-to-end tests could not run there at all.
#
# The CI namespace is a throwaway one: the candidate release, its own database and its own
# volumes, never reachable from the internet (no ingress). Every run starts from a fresh
# release, so the tests always see a pristine world. The live namespace is touched only
# after the tests are green.
#
# Usage: bash tools/devbox/ci.sh [--no-tests] [--no-deploy]
#   --no-tests   build and deploy, but do not run the test suite
#   --no-deploy  build and test only; leave the live release alone (a pull request)
#
# Environment:
#   TAG             the image tag (default: the short sha of HEAD)
#   CI_NAMESPACE    the namespace the candidate runs in (default manythreads-ci)
#   LIVE_NAMESPACE  the namespace the live release runs in (default manythreads)
set -euo pipefail
cd "$(dirname "$0")/../.."

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export PATH="$PATH:/usr/local/bin"

# The tree may arrive owned by another user (the GitHub runner copies it); git refuses a
# repository it does not own.
git config --global --add safe.directory /root/ci 2>/dev/null || true

# Keep this run's whole output on the devbox as well: the GitHub job log needs a signed-in reader, and a red run is
# only fixable from the step that failed. The last 20 runs are kept (/root/ci is rewritten by every run, so not there).
CI_LOG_DIR="${CI_LOG_DIR:-/root/ci-logs}"
mkdir -p "$CI_LOG_DIR"
CI_LOG="$CI_LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown).log"
exec > >(tee -a "$CI_LOG") 2>&1
# Pruning old logs never stops a run (the first run finds no log yet, and `ls` of an unmatched glob fails).
ls -1t "$CI_LOG_DIR"/*.log 2>/dev/null | tail -n +21 | xargs -r rm -f -- || true
echo "log: $CI_LOG"

CI_NAMESPACE="${CI_NAMESPACE:-manythreads-ci}"
LIVE_NAMESPACE="${LIVE_NAMESPACE:-manythreads}"
CI_WEB_PORT="${CI_WEB_PORT:-18080}"
CI_API_PORT="${CI_API_PORT:-18081}"

RUN_TESTS=1
DEPLOY=1
for arg in "$@"; do
  case "$arg" in
    --no-tests) RUN_TESTS=0 ;;
    --no-deploy) DEPLOY=0 ;;
    *) echo "unknown argument '$arg' (want --no-tests or --no-deploy)" >&2; exit 2 ;;
  esac
done

stage() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

if [ -z "${TAG:-}" ]; then
  TAG=$(git rev-parse --short=12 HEAD)
fi
export TAG
echo "candidate $TAG (namespace $CI_NAMESPACE, live $LIVE_NAMESPACE)"

# The port-forwards to the CI release, killed when this script ends whatever happens.
PF_PIDS=()
cleanup() {
  for pid in "${PF_PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

# --- 1 · the fast gates -------------------------------------------------------
stage "install (pnpm install --frozen-lockfile)"
pnpm install --frozen-lockfile

stage "lint (eslint + stylelint)"
pnpm lint

stage "typecheck (tsc)"
pnpm typecheck

# --- 2 · build the candidate --------------------------------------------------
stage "build the images (server + web)"
docker build -f deploy/docker/server.Dockerfile -t "manythreads/server:$TAG" .
docker build -f deploy/docker/web.Dockerfile -t "manythreads/web:$TAG" .

stage "import the images into k3s"
for img in "manythreads/server:$TAG" "manythreads/web:$TAG"; do
  echo "importing $img"
  docker save "$img" | k3s ctr -n k8s.io images import - | tail -n 2
done

# --- 3 · a fresh CI release ---------------------------------------------------
stage "a fresh release in $CI_NAMESPACE"
# The namespace goes, not just the release: the database and the volumes with it, so the
# tests never see what the last run left behind.
helm uninstall manythreads -n "$CI_NAMESPACE" >/dev/null 2>&1 || true
kubectl delete namespace "$CI_NAMESPACE" --ignore-not-found --wait=true --timeout=300s
kubectl create namespace "$CI_NAMESPACE"
helm upgrade --install manythreads-ci ./deploy/helm/manythreads -n "$CI_NAMESPACE" \
  -f deploy/helm/manythreads/values-ci.yaml \
  --set imageTag="$TAG" --wait --timeout 15m

stage "wait for the CI release"
kubectl -n "$CI_NAMESPACE" rollout status deploy/manythreads-server --timeout=300s
kubectl -n "$CI_NAMESPACE" rollout status deploy/manythreads-web --timeout=300s

# --- 4 · the tests ------------------------------------------------------------
if [ "$RUN_TESTS" = "1" ]; then
  stage "the unit and integration suites (vitest, against the dev Postgres on 55432)"
  pnpm db:up
  # MinIO for the storage-s3 contract suite (the compose profile `s3`), the same coverage the
  # old GitHub runner had.
  docker compose -f deploy/compose/docker-compose.dev.yml --profile s3 up -d --wait minio || true
  CI=true MANYTHREADS_TEST_S3=1 MANYTHREADS_TEST_S3_ENDPOINT=http://127.0.0.1:9000 pnpm test --maxWorkers=3

  stage "the candidate release answers (the CI namespace, through a port-forward)"
  # A short port-forward: the release is checked here and left alone after that. The test
  # suite itself runs against its own instances (the Playwright config starts a fresh
  # database, an empty world and an idle world for it) — pointing the whole suite at one
  # deployed release would break the specs that need a pristine world, and the ones that
  # write would leave their traces in it for the specs that follow.
  kubectl -n "$CI_NAMESPACE" port-forward svc/manythreads-web "$CI_WEB_PORT:80" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  # The server itself, for the one route the web pod does not proxy (/openapi.json).
  kubectl -n "$CI_NAMESPACE" port-forward svc/manythreads-server "$CI_API_PORT:3000" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$CI_WEB_PORT/healthz" 2>/dev/null; then break; fi
    sleep 2
  done
  CI_ORIGIN="http://127.0.0.1:$CI_WEB_PORT"
  curl -fsS -o /dev/null "$CI_ORIGIN/healthz" || fail "the CI release did not answer /healthz"
  curl -fsS -o /dev/null "$CI_ORIGIN/readyz" || fail "the CI release did not answer /readyz"
  curl -fsS -o /dev/null "http://127.0.0.1:$CI_API_PORT/openapi.json" || fail "the CI release did not answer /openapi.json"
  # A persona signs in through the real form and sees the seeded world.
  # The seed's persona password is read from the one place that sets it, so the two cannot drift apart.
  PERSONA_PASSWORD=$(sed -n "s/^export const PERSONA_PASSWORD = '\(.*\)';$/\1/p" packages/test-utils/src/create-personas.ts)
  [ -n "$PERSONA_PASSWORD" ] || fail "could not read PERSONA_PASSWORD from packages/test-utils/src/create-personas.ts"
  COOKIE_JAR=$(mktemp)
  curl -fsS -c "$COOKIE_JAR" -o /dev/null -X POST "$CI_ORIGIN/api/auth/password/sign-in" \
    -H "Content-Type: application/json" \
    --data-binary "{\"email\":\"omar@kahf.example\",\"password\":\"$PERSONA_PASSWORD\"}" \
    || fail "no persona could sign in to the CI release"
  curl -fsS -b "$COOKIE_JAR" -o /dev/null "$CI_ORIGIN/api/teams/engineering/channels" \
    || fail "the signed-in persona could not read the channel directory"
  rm -f "$COOKIE_JAR"
  echo "the candidate release answers, a persona signs in and the seeded world is there"

  stage "the browser and api suite (playwright, with its own instances on the devbox)"
  # Two workers: the devbox is shared with whatever else runs there, and a suite that
  # fights for the CPU fails on timeouts that are not the product's.
  pnpm e2e --workers=2
fi

# --- 5 · promote the same build to the live namespace -------------------------
if [ "$DEPLOY" = "1" ]; then
  stage "promote $TAG to the live namespace ($LIVE_NAMESPACE)"
  TAG="$TAG" bash tools/devbox/deploy.sh --no-build
else
  stage "live deploy skipped (--no-deploy)"
fi

printf '\nCI OK: %s tested%s\n' "$TAG" "$([ "$DEPLOY" = "1" ] && echo ' and deployed' || echo '')"
