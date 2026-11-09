#!/usr/bin/env bash
# stage-profile.sh: the cluster side of the stage profiles "airgap" and "otel" (PLAN P10-09, P10-10).
#
#   tools/deploy-test/stage-profile.sh airgap up|check|down
#   tools/deploy-test/stage-profile.sh otel   up|check|down
#
# The profiles themselves (STAGE_PROFILE=airgap,otel on tools/devbox/stage.sh) only set chart values. This script adds what a values file cannot:
#   airgap  up      a NetworkPolicy in the stage namespace: its pods reach each other, the name service and the Kubernetes API, nothing else
#           check   an outside address must fail from the server pod, and a call inside the namespace must work
#   otel    up      an OpenTelemetry Collector (debug exporter) in the stage namespace, at http://otel-collector:4318
#           check   makes one API request and prints the collector's lines for it
# It touches the namespace manythreads-stage and nothing else; it stops when that namespace is not there.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NS=manythreads-stage
PROFILE=${1:-}
ACTION=${2:-}
case "$PROFILE/$ACTION" in
  airgap/up | airgap/check | airgap/down | otel/up | otel/check | otel/down) ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

kubectl get namespace "$NS" -o name >/dev/null 2>&1 || { echo "FAILED: the namespace $NS is not there; start the stage first (tools/devbox/stage.sh up)"; exit 1; }
k() { kubectl -n "$NS" "$@"; }

case "$PROFILE/$ACTION" in
  airgap/up)
    NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
    [ -n "$NODE_IP" ] || { echo "FAILED: no node address"; exit 1; }
    sed "s|__NODE_IP__|$NODE_IP|" "$HERE/stage/airgap-deny-egress.yaml" | kubectl apply -f -
    echo "airgap: the stage namespace can now reach only itself, the name service and the API at $NODE_IP:6443"
    ;;
  airgap/down)
    k delete networkpolicy airgap-deny-egress --ignore-not-found
    ;;
  airgap/check)
    # from the server pod: an outside address must fail ...
    if k exec deploy/manythreads-server -- node -e "fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0),()=>process.exit(1))"; then
      echo "FAILED: the server pod reached https://example.com with the policy on"; exit 1
    fi
    echo "ok: https://example.com is not reachable from the server pod"
    # ... and the namespace itself must still work
    k exec deploy/manythreads-server -- node -e "fetch('http://manythreads-web/healthz',{signal:AbortSignal.timeout(8000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" \
      || { echo "FAILED: the server pod cannot reach the web pod inside the namespace"; exit 1; }
    echo "ok: the web pod answers inside the namespace"
    echo "PASSED. Now ask Brain a question in the stage and check that it answers (e2e/screens, the stage probe)."
    ;;
  otel/up)
    kubectl apply -f "$HERE/stage/otel-collector.yaml"
    k rollout status deploy/otel-collector --timeout=300s
    echo "otel: the collector is up; the server sends to it when the stage was started with STAGE_PROFILE=otel"
    ;;
  otel/down)
    k delete -f "$HERE/stage/otel-collector.yaml" --ignore-not-found
    ;;
  otel/check)
    k get deploy otel-collector -o name >/dev/null 2>&1 || { echo "FAILED: the collector is not running; run: $0 otel up"; exit 1; }
    k exec deploy/manythreads-server -- node -e "fetch('http://localhost:3000/api/session').then((r)=>console.log('request answered',r.status))"
    sleep 6
    LINES=$(k logs deploy/otel-collector --tail=200 | grep -E 'Span #|Name +:|Trace ID|http.route|db.transaction' || true)
    [ -n "$LINES" ] || { echo "FAILED: the collector log has no span; is the stage started with STAGE_PROFILE=otel?"; exit 1; }
    printf '%s\n' "$LINES" | head -n 30
    echo "PASSED: the collector received spans"
    ;;
esac
