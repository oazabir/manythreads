#!/usr/bin/env bash
# deploy.sh — runs ON the devbox. Builds server+web images, imports them into
# k3s containerd, helm-upgrades manythreads, smoke-tests https://manythreads.kahf.to/
# Usage: /root/manythreads/tools/devbox/deploy.sh [--rebuild-postgres]
set -euo pipefail
cd "$(dirname "$0")/../.."

REBUILD_PG=false
[ "${1:-}" = "--rebuild-postgres" ] && REBUILD_PG=true

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export PATH="$PATH:/usr/local/bin"

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
echo "deploying $(git rev-parse HEAD) as tag $TAG"

echo "--- build images"
docker build -f deploy/docker/server.Dockerfile -t "manythreads/server:$TAG" .
docker build -f deploy/docker/web.Dockerfile -t "manythreads/web:$TAG" .

IMAGES=("manythreads/server:$TAG" "manythreads/web:$TAG")
if [ "$REBUILD_PG" = true ] || ! k3s ctr -n k8s.io images ls -q | grep -q "manythreads/postgres:19"; then
  docker build -t manythreads/postgres:19 deploy/postgres
  IMAGES+=("manythreads/postgres:19")
else
  echo "manythreads/postgres:19 already imported; skipping (use --rebuild-postgres to force)"
fi

echo "--- import into k3s"
for img in "${IMAGES[@]}"; do
  echo "importing $img"
  docker save "$img" | k3s ctr -n k8s.io images import - | tail -n 2
done

echo "--- prune old server/web images (keep $TAG and pod-in-use)"
USED=$(kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | sort -u)
k3s ctr -n k8s.io images ls -q | grep -E 'manythreads/(server|web):' | while read -r ref; do
  short=${ref#docker.io/}
  case "$short" in *":$TAG") continue ;; esac
  echo "$USED" | grep -qx "$short" && continue
  k3s ctr -n k8s.io images rm "$ref" || true
done

echo "--- ensure CNPG operator"
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update cnpg >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait --timeout 5m

echo "--- helm upgrade manythreads (imageTag=$TAG)"
if ! helm upgrade --install manythreads ./deploy/helm/manythreads -n manythreads \
  --set imageTag="$TAG" --wait --timeout 10m; then
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
