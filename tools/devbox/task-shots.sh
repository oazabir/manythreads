#!/bin/bash
# task-shots.sh — one-off live password + one task screenshots file, all on the devbox.
# The password is generated here, travels on stdin only (never argv/logs), signs the
# lead in through the real form for the shots, then is rotated to a value nobody
# sees. Usage (from Windows): .\tools\devbox\Remote.ps1 'bash tools/devbox/task-shots.sh omar@kahf.example task.p5-01.shots.ts'
set -euo pipefail
cd /root/manythreads
EMAIL="${1:-omar@kahf.example}"
SHOTS="${2:-task.p5-01.shots.ts}"
PW_FILE=/root/.task-shots-pw
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "$EMAIL" < "$PW_FILE"
set +u
MANYTHREADS_LIVE_PASSWORD="$(cat "$PW_FILE")" pnpm -C e2e exec playwright test -c screens/task.config.ts "$SHOTS"
STATUS=$?
set -u
openssl rand -hex 24 > "$PW_FILE"
kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "$EMAIL" < "$PW_FILE"
rm -f "$PW_FILE"
exit $STATUS
