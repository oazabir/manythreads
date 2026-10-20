#!/bin/bash
# rebuild-concepts.sh — fill the OKF bundle's frontmatter index on the live demo (one-off password, rotated after).
# Usage (from Windows): .\tools\devbox\Remote.ps1 "bash tools/devbox/rebuild-concepts.sh"
set -euo pipefail
cd /root/manythreads
PW_FILE=/root/.rebuild-concepts-pw
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "omar@kahf.example" < "$PW_FILE"
set +u
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/rebuild-concepts.mjs
set -u
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "omar@kahf.example" < "$PW_FILE"
rm -f "$PW_FILE"
