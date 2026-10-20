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

  stage "port-forward to the CI release (web $CI_WEB_PORT)"
  # One forward, to the web service: the web pod's nginx proxies /api (and /ws) to the
  # server, so the api specs use the same origin as the browser ones. A second forward to
  # the server service would die whenever the server pod restarts, and a port-forward to
  # a pod that restarts is a port-forward that stops answering.
  kubectl -n "$CI_NAMESPACE" port-forward svc/manythreads-web "$CI_WEB_PORT:80" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$CI_WEB_PORT/healthz" 2>/dev/null; then break; fi
    sleep 2
  done
  curl -fsS -o /dev/null "http://127.0.0.1:$CI_WEB_PORT/healthz" || fail "the CI release did not answer on the port-forward"

  stage "the browser suite (playwright, against the CI release)"
  # The specs that start a stack of their own need the built web client. With an external
  # origin the Playwright config starts no web server, and that server was what built the
  # client — so build it here, or every one of those specs fails in its beforeAll.
  pnpm --filter @manythreads/web build
  # The test sign-in token of the CI release: the api specs read it from the environment.
  # It never leaves the devbox (it is read from the release's own secret).
  CI_TEST_TOKEN=$(kubectl -n "$CI_NAMESPACE" get secret manythreads-server-secrets -o jsonpath='{.data.test-auth-token}' | base64 -d)
  [ -n "$CI_TEST_TOKEN" ] || fail "the CI release has no test sign-in token"
  MANYTHREADS_TEST_AUTH_TOKEN="$CI_TEST_TOKEN" \
    MANYTHREADS_URL="http://127.0.0.1:$CI_WEB_PORT" \
    MANYTHREADS_API_URL="http://127.0.0.1:$CI_WEB_PORT" \
    pnpm e2e
fi

# --- 5 · promote the same build to the live namespace -------------------------
if [ "$DEPLOY" = "1" ]; then
  stage "promote $TAG to the live namespace ($LIVE_NAMESPACE)"
  TAG="$TAG" bash tools/devbox/deploy.sh --no-build
else
  stage "live deploy skipped (--no-deploy)"
fi

printf '\nCI OK: %s tested%s\n' "$TAG" "$([ "$DEPLOY" = "1" ] && echo ' and deployed' || echo '')"
