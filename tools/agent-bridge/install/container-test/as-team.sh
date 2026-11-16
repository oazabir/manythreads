#!/bin/bash
# Test double of the bridge's side (P26-22): what the bridge does for one run of a team, run as the bridge's user. Starts `sudo -n -- <helper> run <team> <kind>`, sends the header line,
# then the commands on this script's standard input go to the program (the probe, or the real adapter when MT_AS_TEAM_RAW=1 and the input is the adapter's own protocol).
#   as-team.sh TEAM [BOT] [KIND]        (standard input: one shell command per line, or the adapter's messages)
# Environment: MT_TOKEN (the run token, default "token-of-TEAM"), MT_FILES (a JSON array of header files), MT_REMOVE (a JSON array), MT_EXTRA_ENV (a JSON object merged into the header env,
# to prove the helper drops what the bridge never sends).
set -eu
team="$1"
bot="${2:-dev}"
kind="${3:-claude}"
root=/var/lib/manythreads-bridge
extra="${MT_EXTRA_ENV:-}"
[ -n "$extra" ] || extra='{}'
header="$(jq -nc --arg cwd "$root/work/$team/$bot" --arg tok "${MT_TOKEN:-token-of-$team}" --arg claude "$root/auth/claude" --arg codex "$root/auth/codex" \
  --argjson files "${MT_FILES:-[]}" --argjson remove "${MT_REMOVE:-[]}" --argjson extra "$extra" \
  '{v:1, cwd:$cwd, env:({PATH:"/opt/manythreads-bridge/node/bin:/usr/local/bin:/usr/bin:/bin", CLAUDE_CONFIG_DIR:$claude, CODEX_HOME:$codex, MANYTHREADS_RUN_TOKEN:$tok} + $extra), files:$files, removeAtEnd:$remove}')"
{ printf '%s\n' "$header"; cat; } | runuser -u manythreads-bridge -- sudo -n -- /opt/manythreads-bridge/helper/mt-team-helper run "$team" "$kind"
