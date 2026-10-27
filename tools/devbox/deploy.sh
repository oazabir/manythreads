#!/usr/bin/env bash
# deploy.sh — runs ON the devbox. Builds server+web images, imports them into
# k3s containerd, helm-upgrades manythreads, smoke-tests https://manythreads.kahf.to/
# Usage: /root/manythreads/tools/devbox/deploy.sh [--rebuild-postgres] [--demo] [--no-build] [HTTPS flags]
#   HTTPS (docs/deploy.md "HTTPS: Cloudflare or Let's Encrypt"). Without --tls the deploy keeps the mode the release has now, so a plain
#   redeploy never flips it.
#   --tls none|cloudflare|letsencrypt   how visitors reach the site over HTTPS
#   --cf-origin strict|flexible         cloudflare only: "Full (strict)" (recommended) or "Flexible" (plain HTTP to the origin)
#   --origin-cert FILE --origin-key FILE  Cloudflare Origin CA certificate + key -> Secret manythreads-origin-cert (kubernetes.io/tls)
#   --acme-email EMAIL                  letsencrypt: contact address for the ACME account (optional)
#   --acme-staging                      letsencrypt: use Let's Encrypt's staging server (untrusted certificates, no rate limits)
#   --dns-token-file FILE               letsencrypt wildcard: Cloudflare API token (DNS edit) -> Secret manythreads-cloudflare-dns
#   --no-wildcard                       do not cover *.<domain> (letsencrypt then needs no DNS token)
#   --wildcard                          cover *.<domain> again (undoes a remembered --no-wildcard); only used with --apps-routing host
#   --apps-routing path|host            how deployed apps are reached: path (default) = https://<domain>/apps/<team>/<app>/ on the main domain,
#                                       so no wildcard DNS record or certificate is needed; host = https://<app>--<team>.<domain>/ (needs both).
#                                       Remembered like the HTTPS flags.
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
TLS_MODE=""
CF_ORIGIN=""
ORIGIN_CERT=""
ORIGIN_KEY=""
ACME_EMAIL=""
ACME_STAGING=false
DNS_TOKEN_FILE=""
NO_WILDCARD=false
YES_WILDCARD=false
APPS_ROUTING=""
need_value() { [ "$2" -ge 2 ] || { echo "$1 needs a value"; exit 2; }; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rebuild-postgres) REBUILD_PG=true ;;
    --demo) DEMO=true ;;
    --no-build) BUILD=false ;;
    --tls) need_value "$1" "$#"; TLS_MODE="$2"; shift ;;
    --cf-origin) need_value "$1" "$#"; CF_ORIGIN="$2"; shift ;;
    --origin-cert) need_value "$1" "$#"; ORIGIN_CERT="$2"; shift ;;
    --origin-key) need_value "$1" "$#"; ORIGIN_KEY="$2"; shift ;;
    --acme-email) need_value "$1" "$#"; ACME_EMAIL="$2"; shift ;;
    --acme-staging) ACME_STAGING=true ;;
    --dns-token-file) need_value "$1" "$#"; DNS_TOKEN_FILE="$2"; shift ;;
    --no-wildcard) NO_WILDCARD=true ;;
    --wildcard) YES_WILDCARD=true ;;
    --apps-routing) need_value "$1" "$#"; APPS_ROUTING="$2"; shift ;;
    *) echo "unknown argument $1 (want --rebuild-postgres, --demo, --no-build, --tls, --cf-origin, --origin-cert, --origin-key, --acme-email, --acme-staging, --dns-token-file, --wildcard, --no-wildcard or --apps-routing)"; exit 2 ;;
  esac
  shift
done
case "$TLS_MODE" in ""|none|cloudflare|letsencrypt) ;; *) echo "--tls wants none, cloudflare or letsencrypt"; exit 2 ;; esac
case "$APPS_ROUTING" in ""|path|host) ;; *) echo "--apps-routing wants path or host"; exit 2 ;; esac
case "$CF_ORIGIN" in ""|strict|flexible) ;; *) echo "--cf-origin wants strict or flexible"; exit 2 ;; esac
{ [ -z "$ORIGIN_CERT" ] && [ -z "$ORIGIN_KEY" ]; } || { [ -f "$ORIGIN_CERT" ] && [ -f "$ORIGIN_KEY" ]; } || { echo "--origin-cert and --origin-key both need an existing file"; exit 2; }
[ -z "$DNS_TOKEN_FILE" ] || [ -f "$DNS_TOKEN_FILE" ] || { echo "--dns-token-file: no such file"; exit 2; }

# Tools the HTTPS step needs: checked before anything is built, so a missing one does not cost a build.
command -v jq >/dev/null || { echo "ERROR: jq is not installed (apt install jq)"; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 is not installed"; exit 1; }
python3 -c 'import yaml' 2>/dev/null || { echo "ERROR: python3 needs PyYAML (apt install python3-yaml)"; exit 1; }

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
# The database image: CloudNativePG's pinned Postgres 19 build plus pgvector (deploy/postgres/cnpg.Dockerfile), kept in the in-cluster registry
# (registry.local:5000 -> the registry's node port) so the node can pull it again after an image clean-up. Built and pushed only when the
# registry does not have it; the chart pins its digest. --rebuild-postgres also rebuilds the old local manythreads/postgres:19 (compose).
PG_REF=platform/postgres-cnpg:19beta4-202609281634-u999
if ! curl -sf -o /dev/null -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' "http://127.0.0.1:30500/v2/${PG_REF%%:*}/manifests/${PG_REF##*:}"; then
  echo "--- build and push the database image ($PG_REF)"
  docker build -f deploy/postgres/cnpg.Dockerfile -t "127.0.0.1:30500/$PG_REF" deploy/postgres
  docker push "127.0.0.1:30500/$PG_REF"
else
  echo "database image $PG_REF is in the registry"
fi
if [ "$REBUILD_PG" = true ]; then
  docker build -t manythreads/postgres:19 deploy/postgres
  IMAGES+=("manythreads/postgres:19")
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
# k3s keeps its own copy of every image, so once one is in k3s Docker's copy is only weight: on a 77 GB disk the duplicates of the
# server, web and pod images pushed the node into disk pressure on 2026-10-27, which evicted the live database and the team pods
# and garbage-collected the hermes-pod image (MISTAKES.md). An image already in k3s is not imported again, and Docker's copy goes.
for img in "${IMAGES[@]}"; do
  if k3s ctr -n k8s.io images ls -q | grep -q "^docker.io/$img\$"; then
    echo "$img is already in k3s"
  else
    echo "importing $img"
    docker save "$img" | k3s ctr -n k8s.io images import - | tail -n 2
  fi
  docker rmi "$img" >/dev/null 2>&1 || true
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
# 3 GB of build cache: at 8 GB the cache, the image copies and a bot's build in a team pod filled the disk again on 2026-10-25, and the
# clean-up that followed deleted the database image (see the postgres note in values.yaml).
docker builder prune -f --keep-storage 3gb >/dev/null 2>&1 || true

# --- HTTPS: decide the effective tls settings (flags win; otherwise whatever the release has now, so a plain redeploy keeps the mode)
# "No release yet" is a normal first install; a FAILED read of an existing release must stop the deploy, or a plain redeploy could flip the mode.
RELEASES=$(helm list -n manythreads -q --filter '^manythreads$') || { echo "ERROR: cannot list helm releases; not guessing the current HTTPS mode"; exit 1; }
if [ -n "$RELEASES" ]; then
  CUR=$(helm get values manythreads -n manythreads -a -o json) || { echo "ERROR: cannot read the current release values; not guessing the current HTTPS mode"; exit 1; }
else
  CUR='{}'
fi
cur() { echo "$CUR" | jq -r "$1 // empty" 2>/dev/null || true; }
TLS_MODE=${TLS_MODE:-$(cur .tls.mode)}
TLS_MODE=${TLS_MODE:-none}
CF_ORIGIN=${CF_ORIGIN:-$(cur .tls.cloudflare.origin)}
CF_ORIGIN=${CF_ORIGIN:-strict}
ACME_EMAIL=${ACME_EMAIL:-$(cur .tls.letsencrypt.email)}
ACME_SERVER=$(cur .tls.letsencrypt.server)
ACME_SERVER=${ACME_SERVER:-production}
[ "$ACME_STAGING" = true ] && ACME_SERVER=staging
# (jq's `//` would turn a stored `false` into "absent", so this one is read with an explicit null check)
WILDCARD=$(echo "$CUR" | jq -r 'if .tls.wildcard == null then empty else (.tls.wildcard | tostring) end' 2>/dev/null || true)
WILDCARD=${WILDCARD:-true}
[ "$NO_WILDCARD" = true ] && WILDCARD=false
[ "$YES_WILDCARD" = true ] && WILDCARD=true
APPS_ROUTING=${APPS_ROUTING:-$(cur .hermesPods.apps.routing)}
APPS_ROUTING=${APPS_ROUTING:-path}
# A release made before path routing existed has no routing value: it served apps by host (<app>--<team>.<domain>). Defaulting to path makes the
# admission policy refuse updates to those Ingresses, so say so (read-only look; nothing here changes the cluster).
if [ -n "$RELEASES" ] && [ -z "$(cur .hermesPods.apps.routing)" ] && [ "$APPS_ROUTING" = path ]; then
  OLD_APPS=$({ kubectl get ns -l manythreads.io/apps=true -o name 2>/dev/null; kubectl get ns -o name 2>/dev/null | grep '^namespace/apps-' || true; } | sed 's|^namespace/||' | sort -u)
  OLD_HOSTED=""
  for ns in $OLD_APPS; do
    found=$(kubectl get ingress -n "$ns" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.rules[0].host}{"\n"}{end}' 2>/dev/null | awk -F'\t' '$2 ~ /--/ {print "'"$ns"'/" $1 " (" $2 ")"}' || true)
    [ -z "$found" ] || OLD_HOSTED="$OLD_HOSTED$found"$'\n'
  done
  if [ -n "$OLD_HOSTED" ]; then
    echo "WARNING: this release has no apps routing value and these app Ingresses use host form (<app>--<team>.<domain>):"
    printf '%s' "$OLD_HOSTED" | sed 's/^/    /'
    echo "WARNING: switching to path routing (the default) makes the admission policy refuse updates to them. Each app has to be redeployed under"
    echo "WARNING: /apps/<team>/<app>. To keep host routing for now, pass --apps-routing host."
  fi
fi
# (The chart only asks for a wildcard certificate with host routing; with path routing the apps sit under the main domain and tls.wildcard is ignored.)
TLS_ARGS=(--set hermesPods.apps.routing="$APPS_ROUTING" --set tls.mode="$TLS_MODE" --set tls.wildcard="$WILDCARD" --set tls.cloudflare.origin="$CF_ORIGIN"
  --set tls.letsencrypt.server="$ACME_SERVER")
[ -z "$ACME_EMAIL" ] || TLS_ARGS+=(--set-string tls.letsencrypt.email="$ACME_EMAIL")
echo "--- https mode: $TLS_MODE (wildcard=$WILDCARD, used only with host routing; apps routing=$APPS_ROUTING)"

# Secrets are made from files and never echoed. Server-side apply keeps no last-applied copy of the content in an annotation (client-side apply would).
kubectl create namespace manythreads --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if [ -n "$ORIGIN_CERT" ]; then
  kubectl -n manythreads create secret tls manythreads-origin-cert --cert="$ORIGIN_CERT" --key="$ORIGIN_KEY" --dry-run=client -o yaml \
    | kubectl apply --server-side --force-conflicts -f - >/dev/null
fi
if [ -n "$DNS_TOKEN_FILE" ]; then
  kubectl -n manythreads create secret generic manythreads-cloudflare-dns --from-file=api-token="$DNS_TOKEN_FILE" --dry-run=client -o yaml \
    | kubectl apply --server-side --force-conflicts -f - >/dev/null
fi
have_secret() { kubectl -n manythreads get secret "$1" >/dev/null 2>&1; }

# Traefik's forwarded-header trust (see docs/deploy.md). k3s configures its Traefik with the HelmChartConfig `traefik` in kube-system, which is
# cluster-wide, so it is applied here and not rendered by the chart. Read the current one and change only the trustedIPs (JSON is YAML, so the
# merged valuesContent is written as JSON). Cloudflare mode sets them; any other mode takes Cloudflare's ranges out again (and deletes the object
# when nothing else is left in it).
traefik_trust() { # $1 = set | clear
  local ips existing out
  ips=$(helm show values ./deploy/helm/manythreads | python3 -c 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)["tls"]["cloudflare"]["trustedIPs"]))')
  existing=$(kubectl -n kube-system get helmchartconfig traefik -o jsonpath='{.spec.valuesContent}' 2>/dev/null || true)
  if [ "$1" = clear ] && ! kubectl -n kube-system get helmchartconfig traefik >/dev/null 2>&1; then return 0; fi
  out=$(ACTION="$1" EXISTING="$existing" CF_IPS="$ips" python3 -c '
import os, json, yaml
v = yaml.safe_load(os.environ["EXISTING"] or "{}") or {}
ips = json.loads(os.environ["CF_IPS"])
ports = v.setdefault("ports", {})
for port in ("web", "websecure"):
    fh = ports.setdefault(port, {}).setdefault("forwardedHeaders", {})
    if os.environ["ACTION"] == "set":
        fh["trustedIPs"] = ips
    elif set(fh.get("trustedIPs") or []) <= set(ips):
        fh.pop("trustedIPs", None)
    if not fh: ports[port].pop("forwardedHeaders")
    if not ports[port]: ports.pop(port)
if not ports: v.pop("ports")
if not v and os.environ["ACTION"] == "clear":
    print("DELETE")
else:
    print(json.dumps({"apiVersion": "helm.cattle.io/v1", "kind": "HelmChartConfig",
      "metadata": {"name": "traefik", "namespace": "kube-system"}, "spec": {"valuesContent": json.dumps(v)}}))')
  if [ "$out" = DELETE ]; then
    kubectl -n kube-system delete helmchartconfig traefik >/dev/null
  else
    echo "$out" | kubectl apply -f - >/dev/null
  fi
  echo "Traefik will roll to pick this up (k3s's helm controller redeploys it)"
}

if [ "$TLS_MODE" = cloudflare ]; then
  if [ "$CF_ORIGIN" = strict ] && ! have_secret manythreads-origin-cert; then
    echo "ERROR: Cloudflare strict needs the origin certificate: pass --origin-cert FILE --origin-key FILE (or --cf-origin flexible)"; exit 1
  fi
  echo "--- Traefik: trust Cloudflare's forwarded headers"
  traefik_trust set
else
  traefik_trust clear
fi

if [ "$TLS_MODE" = letsencrypt ]; then
  if [ "$WILDCARD" = true ] && [ "$APPS_ROUTING" = host ] && ! have_secret manythreads-cloudflare-dns; then
    echo "ERROR: a wildcard Let's Encrypt certificate needs a Cloudflare DNS token: pass --dns-token-file FILE (or --no-wildcard)"; exit 1
  fi
  echo "--- ensure cert-manager"
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo update jetstack >/dev/null
  helm upgrade --install cert-manager jetstack/cert-manager --version v1.21.3 -n cert-manager --create-namespace \
    --set crds.enabled=true --wait --timeout 5m
fi

echo "--- ensure CNPG operator"
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update cnpg >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait --timeout 5m

# The live install runs a real LiteLLM gateway and Hindsight memory engine (values-live.yaml); --demo overrides that with stand-ins.
HELM_ARGS=(--set imageTag="$TAG" -f deploy/helm/manythreads/values-live.yaml "${PODS_ARGS[@]}" "${TLS_ARGS[@]}")
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
DOMAIN=$(helm get values manythreads -n manythreads -a -o json | jq -r '.domain // empty')
DOMAIN=${DOMAIN:-manythreads.kahf.to}
ok=0
for _ in $(seq 1 30); do
  if curl -fsSk -o /dev/null "https://$DOMAIN/"; then ok=1; break; fi
  sleep 5
done
if [ "$TLS_MODE" = letsencrypt ]; then
  kubectl -n manythreads wait certificate/manythreads-tls --for=condition=Ready --timeout=5m \
    || echo "WARNING: the Let's Encrypt certificate is not ready yet (kubectl -n manythreads describe certificate manythreads-tls)"
fi
curl -fsSk "https://$DOMAIN/healthz" || echo "WARNING: /healthz not healthy"
if [ "$TLS_MODE" != none ]; then
  # Without -k: does a browser-style check of the public certificate pass? A warning only (DNS or the edge may still be settling).
  curl -fsS -o /dev/null "https://$DOMAIN/" || echo "WARNING: the certificate of https://$DOMAIN/ does not verify (mode $TLS_MODE); check it before telling anyone"
fi
kubectl get pods -n manythreads
[ "$ok" = "1" ] || { echo "ERROR: site did not respond"; exit 1; }
echo "deployed $TAG - https://$DOMAIN/ OK"
