#!/usr/bin/env bash
# The disk guard's prune with the keep list a deploy uses (tools/devbox/deploy.sh), for a person or the operator's watchdog to run between deploys.
# Running `disk-guard.sh check` by hand without that list removed the Hermes base image and the Hermes pod and workbench images twice on 2026-11-23: nothing
# used them at that moment (no Hermes pod was up), so the guard took them, and the next deploy spent ~7 GB and twenty minutes building them again.
# Kept, as a deploy keeps them: the Hermes base image; every pod image (claude-pod, workbench, hermes-pod, asr) Docker or k3s holds; and the server and web
# images k3s holds (a running pod's image is kept anyway; this also keeps the ones a deploy imported and has not rolled out yet). Usage: bash tools/devbox/disk-guard-safe.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
KEEP=(--keep-docker manythreads/hermes:stable)
while read -r ref; do [ -n "$ref" ] && KEEP+=(--keep-docker "$ref"); done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^manythreads/(claude-pod|claude-pod-fake|workbench|hermes-pod|asr|server|web):' || true)
while read -r ref; do [ -n "$ref" ] && KEEP+=(--keep "${ref#docker.io/}"); done < <(k3s ctr -n k8s.io images ls -q 2>/dev/null | grep -E '^docker.io/manythreads/(claude-pod|workbench|hermes-pod|asr|server|web):' || true)
exec bash tools/devbox/disk-guard.sh check "${KEEP[@]}"
