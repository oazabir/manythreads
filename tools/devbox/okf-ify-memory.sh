#!/bin/bash
# okf-ify-memory.sh — give the live demo's memory facts their OKF frontmatter, then rebuild the index.
# One shared one-off password for the admin account, stdin-only, rotated after.
# Usage (from Windows): .\tools\devbox\Remote.ps1 "bash tools/devbox/okf-ify-memory.sh"
set -euo pipefail
cd /root/manythreads
PW_FILE=/root/.okf-ify-pw
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "omar@kahf.example" < "$PW_FILE"
set +u
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/okf-ify-memory.mjs engineering customer-support marketing
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/rebuild-concepts.mjs engineering customer-support marketing
set -u
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "omar@kahf.example" < "$PW_FILE"
rm -f "$PW_FILE"
