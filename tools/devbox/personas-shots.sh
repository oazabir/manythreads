#!/bin/bash
# personas-shots.sh — persona-journey screenshots on the live site (read-only walk).
# One shared one-off password for all seven accounts, stdin-only, rotated after.
# Usage (from Windows): .\tools\devbox\Remote.ps1 "bash tools/devbox/personas-shots.sh"
set -euo pipefail
cd /root/manythreads
PW_FILE=/root/.personas-shots-pw
USERS="omar nadia rafi sameera tariq priya lena"
SHOTS="${1:-task.personas.shots.ts}"
openssl rand -hex 24 > "$PW_FILE"
for u in $USERS; do
  kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "$u@kahf.example" < "$PW_FILE"
done
set +u
MANYTHREADS_LIVE_PASSWORD="$(cat "$PW_FILE")" pnpm -C e2e exec playwright test -c screens/task.config.ts "$SHOTS" 2>&1 | tail -n 15
STATUS=${PIPESTATUS[0]:-$?}
set -u
openssl rand -hex 24 > "$PW_FILE"
for u in $USERS; do
  kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "$u@kahf.example" < "$PW_FILE"
done
rm -f "$PW_FILE"
exit "$STATUS"
