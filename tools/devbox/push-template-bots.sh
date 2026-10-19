#!/bin/bash
# push-template-bots.sh — give the live demo's Support and Marketing teams their template bots.
#
# The demo deployment seeded those repositories directly, so the bots' BOT.md files are in git but the bots plugin
# (which loads a bot when a commit touches bots/<slug>/BOT.md) never saw a commit for them: their rosters and
# conversations are empty. This commits the shipped template definitions as the workspace admin, which is what
# makes the personas of those teams real.
#
# One shared one-off password for the admin account, stdin-only, rotated after.
# Usage (from Windows): .\tools\devbox\Remote.ps1 "bash tools/devbox/push-template-bots.sh"
set -euo pipefail
cd /root/manythreads
PW_FILE=/root/.push-bots-pw
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "omar@kahf.example" < "$PW_FILE"
set +u
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/push-template-bots.mjs customer-support support-responder
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/push-template-bots.mjs customer-support brain
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/push-template-bots.mjs marketing brain
DEMO_BASE=https://manythreads.kahf.to \
DEMO_EMAIL=omar@kahf.example \
DEMO_PASSWORD="$(cat "$PW_FILE")" \
  node tools/devbox/push-template-bots.mjs marketing content-drafter
set -u
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "omar@kahf.example" < "$PW_FILE"
rm -f "$PW_FILE"
