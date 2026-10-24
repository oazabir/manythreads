#!/usr/bin/env bash
# deploy.sh — runs ON the devbox. Builds server+web images, imports them into
# k3s containerd, helm-upgrades manythreads, smoke-tests https://manythreads.kahf.to/
# Usage: /root/manythreads/tools/devbox/deploy.sh [--rebuild-postgres] [--demo] [--no-build]
#   --demo also builds the Hermes agent image (once; cached as manythreads/hermes:stable),
#   the demo server layer, and the fake-llm + fake-hindsight stand-ins, and points the
#   server at them (deploy/helm/manythreads/values-demo.yaml). A later deploy
#   without --demo removes the stand-ins and their wiring again.
#   --no-build skips the image build: the images are already built and imported (the CI
#   pipeline builds once, tests the candidate in its own namespace, then promotes the very
#   same tag here with this script).
set -euo pipefail
cd "$(dirname "$0")/../.."

REBUILD_PG=false
DEMO=false
BUILD=true
for arg in "$@"; do
  case "$arg" in
    --rebuild-postgres) REBUILD_PG=true ;;
    --demo) DEMO=true ;;
    --no-build) BUILD=false ;;
    *) echo "unknown argument $arg (want --rebuild-postgres, --demo or --no-build)"; exit 2 ;;
  esac
done

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export PATH="$PATH:/usr/local/bin"

# The tag of the build. The CI pipeline sets TAG (one build, tested and then promoted);
# by hand it is the short sha of HEAD, with a content suffix when the tree is not committed.
if [ -z "${TAG:-}" ]; then
  TAG=$(git rev-parse --short=12 HEAD)
  if [ -n "$(git status --porcelain)" ]; then
    # The sync dev loop (WINDOWS_DEV.md) deploys uncommitted working-tree content, and
    # docker/k3s identify images by tag: tagging by HEAD alone would leave k8s serving
    # the PREVIOUS image on every deploy whose changes are not committed. Tag by tree
    # CONTENT instead, so every distinct tree rolls the deployment and an unchanged
    # tree stays a no-op. Untracked files are hashed too (new files matter).
    H=$(
      {
        git diff HEAD --binary
        git ls-files -o --exclude-standard -z | while IFS= read -r -d '' f; do
          printf '%s\0' "$f"
          cat "$f" 2>/dev/null || true
        done
      } | sha256sum | cut -c1-8
    )
    TAG="$TAG-$H"
    echo "working tree differs from HEAD; content suffix -$H"
  fi
fi
echo "deploying $(git rev-parse HEAD) as tag $TAG"

if [ "$BUILD" = "true" ]; then
  echo "--- build images"
  docker build -f deploy/docker/server.Dockerfile -t "manythreads/server:$TAG" .
  docker build -f deploy/docker/web.Dockerfile -t "manythreads/web:$TAG" .
else
  echo "--- images are already built (--no-build): manythreads/server:$TAG, manythreads/web:$TAG"
fi

IMAGES=("manythreads/server:$TAG" "manythreads/web:$TAG")
if [ "$DEMO" = true ]; then
  if k3s ctr -n k8s.io images ls -q | grep -q "manythreads/hermes:stable"; then
    echo "manythreads/hermes:stable already imported; skipping (remove it from containerd to force a rebuild)"
  else
    echo "--- build hermes agent image (one-time; the installer pulls upstream)"
    docker build -f deploy/docker/hermes.Dockerfile -t manythreads/hermes:stable .
    echo "importing manythreads/hermes:stable"
    docker save manythreads/hermes:stable | k3s ctr -n k8s.io images import - | tail -n 2
  fi
  echo "--- build demo server layer"
  docker build -f deploy/docker/server-demo.Dockerfile --build-arg SERVER_TAG="$TAG" -t "manythreads/server-demo:$TAG" .
  IMAGES+=("manythreads/server-demo:$TAG")
  echo "--- build demo-fakes image"
  docker build -f deploy/docker/demo-fakes.Dockerfile --build-arg SERVER_TAG="$TAG" -t "manythreads/demo-fakes:$TAG" .
  IMAGES+=("manythreads/demo-fakes:$TAG")
fi
if [ "$REBUILD_PG" = true ] || ! k3s ctr -n k8s.io images ls -q | grep -q "manythreads/postgres:19"; then
  docker build -t manythreads/postgres:19 deploy/postgres
  IMAGES+=("manythreads/postgres:19")
else
  echo "manythreads/postgres:19 already imported; skipping (use --rebuild-postgres to force)"
fi

# Managed Hermes pods (values-live.yaml hermesPods): the Hermes container and the workbench. Tagged by the content of their build
# folders, so an unchanged folder is a no-op and a changed one rolls the pods. Built whether or not --no-build is given (the CI
# pipeline builds only server+web); needs manythreads/hermes:stable (the official Hermes install, deploy/docker/hermes.Dockerfile).
PODS_ARGS=()
if grep -q '^hermesPods:' deploy/helm/manythreads/values-live.yaml 2>/dev/null; then
  HP_TAG=$(tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C deploy/images/hermes-pod -cf - . | sha256sum | cut -c1-10)
  WB_TAG=$(tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C deploy/images/workbench -cf - . | sha256sum | cut -c1-10)
  if ! k3s ctr -n k8s.io images ls -q | grep -q "manythreads/hermes-pod:$HP_TAG\$"; then
    echo "--- build manythreads/hermes-pod:$HP_TAG"
    if ! docker image inspect manythreads/hermes:stable >/dev/null 2>&1; then
      docker build -f deploy/docker/hermes.Dockerfile -t manythreads/hermes:stable .
    fi
    docker build -f deploy/images/hermes-pod/Dockerfile -t "manythreads/hermes-pod:$HP_TAG" deploy/images/hermes-pod
    IMAGES+=("manythreads/hermes-pod:$HP_TAG")
  fi
  if ! k3s ctr -n k8s.io images ls -q | grep -q "manythreads/workbench:$WB_TAG\$"; then
    echo "--- build manythreads/workbench:$WB_TAG"
    docker build -f deploy/images/workbench/Dockerfile -t "manythreads/workbench:$WB_TAG" deploy/images/workbench
    IMAGES+=("manythreads/workbench:$WB_TAG")
  fi
  PODS_ARGS=(--set "hermesPods.images.hermes=manythreads/hermes-pod:$HP_TAG" --set "hermesPods.images.workbench=manythreads/workbench:$WB_TAG")
fi

echo "--- import into k3s"
for img in "${IMAGES[@]}"; do
  echo "importing $img"
  docker save "$img" | k3s ctr -n k8s.io images import - | tail -n 2
done

echo "--- prune old server/web images (keep $TAG and pod-in-use)"
USED=$(kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | sort -u)
k3s ctr -n k8s.io images ls -q | { grep -E 'manythreads/(server|server-demo|demo-fakes|web):' || true; } | while read -r ref; do
  short=${ref#docker.io/}
  case "$short" in *":$TAG") continue ;; esac
  echo "$USED" | grep -qx "$short" && continue
  k3s ctr -n k8s.io images rm "$ref" || true
done
# Docker keeps its own copy of every build and a build cache; left alone they filled the disk on 2026-10-24, the kubelet
# tainted the node with disk-pressure and garbage-collected the images every pod needed (MISTAKES.md).
docker images --format '{{.Repository}}:{{.Tag}}' | { grep -E '^manythreads/(server|server-demo|demo-fakes|web):' || true; } | while read -r ref; do
  case "$ref" in *":$TAG") continue ;; esac
  echo "$USED" | grep -qx "$ref" && continue
  docker rmi "$ref" >/dev/null 2>&1 || true
done
# pod images: keep the current content tags and whatever a pod still uses
docker images --format '{{.Repository}}:{{.Tag}}' | { grep -E '^manythreads/(hermes-pod|workbench):' || true; } | while read -r ref; do
  case "$ref" in *":${HP_TAG:-none}"|*":${WB_TAG:-none}") continue ;; esac
  echo "$USED" | grep -qx "$ref" && continue
  docker rmi "$ref" >/dev/null 2>&1 || true
done
k3s ctr -n k8s.io images ls -q | { grep -E 'manythreads/(hermes-pod|workbench):' || true; } | while read -r ref; do
  short=${ref#docker.io/}
  case "$short" in *":${HP_TAG:-none}"|*":${WB_TAG:-none}") continue ;; esac
  echo "$USED" | grep -qx "$short" && continue
  k3s ctr -n k8s.io images rm "$ref" || true
done
docker builder prune -f --keep-storage 8gb >/dev/null 2>&1 || true

echo "--- ensure CNPG operator"
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update cnpg >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait --timeout 5m

# The live install runs a real LiteLLM gateway and Hindsight memory engine (values-live.yaml); --demo overrides that with stand-ins.
HELM_ARGS=(--set imageTag="$TAG" -f deploy/helm/manythreads/values-live.yaml "${PODS_ARGS[@]}")
[ "$DEMO" = true ] && HELM_ARGS+=(-f deploy/helm/manythreads/values-demo.yaml)
echo "--- helm upgrade manythreads (imageTag=$TAG demo=$DEMO)"
if ! helm upgrade --install manythreads ./deploy/helm/manythreads -n manythreads \
  "${HELM_ARGS[@]}" --wait --timeout 10m; then
  echo "WARNING: helm --wait failed; checking web + postgres readiness"
  kubectl get pods -n manythreads
  kubectl rollout status deploy/manythreads-web -n manythreads --timeout=60s
  kubectl get cluster -n manythreads 2>/dev/null || kubectl get sts manythreads-pg -n manythreads
fi

echo "--- smoke test"
ok=0
for _ in $(seq 1 30); do
  if curl -fsSk -o /dev/null https://manythreads.kahf.to/; then ok=1; break; fi
  sleep 5
done
curl -fsSk https://manythreads.kahf.to/healthz || echo "WARNING: /healthz not healthy"
kubectl get pods -n manythreads
[ "$ok" = "1" ] || { echo "ERROR: site did not respond"; exit 1; }
echo "deployed $TAG — https://manythreads.kahf.to/ OK"
