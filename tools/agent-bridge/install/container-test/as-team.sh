#!/bin/bash
# Test double of the bridge's side (P26-22): what the bridge does for one run of a team, run as the bridge's user. Starts `sudo -n -- <helper> run <team> <kind>`, sends the header line,
# then the commands on this script's standard input go to the program (the probe, or the real adapter when MT_AS_TEAM_RAW=1 and the input is the adapter's own protocol).
#   as-team.sh TEAM [BOT] [KIND]        (standard input: one shell command per line, or the adapter's messages)
# Environment: MT_SIGNIN (per_team: the team's own sign-in folders, P35-10b), MT_TOKEN (the run token, default "token-of-TEAM"), MT_FILES (a JSON array of header files), MT_REMOVE (a JSON array), MT_EXTRA_ENV (a JSON object merged into the header env,
# to prove the helper drops what the bridge never sends).
set -eu
team="$1"
bot="${2:-dev}"
kind="${3:-claude}"
root=/var/lib/manythreads-bridge
extra="${MT_EXTRA_ENV:-}"
[ -n "$extra" ] || extra='{}'
# a Codex run names the team's own Codex home (P31-01); every other kind names none
codex='{}'
[ "$kind" = codex ] && codex="$(jq -nc --arg h "$root/work/$team/.codex" '{CODEX_HOME:$h}')"
claude="$root/auth/claude"
signin='{}'
# MT_SIGNIN=per_team (P35-10b): a run of a runner where each team signs in, as the bridge writes it: the team's own `.signin/<agent>` and `signIn: per_team`; the sign-in kinds name their own folder
if [ "${MT_SIGNIN:-}" = per_team ]; then
  signin='{"signIn":"per_team"}'
  case "$kind" in
    codex|codex-key|codex-logout) codex="$(jq -nc --arg h "$root/work/$team/.signin/codex" '{CODEX_HOME:$h}')"; claude='' ;;
    *) claude="$root/work/$team/.signin/claude" ;;
  esac
  case "$kind" in claude|codex) ;; *) signin='{}' ;; esac
fi
claudeenv='{}'
[ -n "$claude" ] && claudeenv="$(jq -nc --arg c "$claude" '{CLAUDE_CONFIG_DIR:$c}')"
header="$(jq -nc --arg cwd "$root/work/$team/$bot" --arg tok "${MT_TOKEN:-token-of-$team}" \
  --argjson files "${MT_FILES:-[]}" --argjson remove "${MT_REMOVE:-[]}" --argjson extra "$extra" --argjson codex "$codex" --argjson claudeenv "$claudeenv" --argjson signin "$signin" \
  '{v:1, cwd:$cwd, env:({PATH:"/opt/manythreads-bridge/node/bin:/usr/local/bin:/usr/bin:/bin", MANYTHREADS_RUN_TOKEN:$tok} + $claudeenv + $codex + $extra), files:$files, removeAtEnd:$remove} + $signin')"
{ printf '%s\n' "$header"; cat; } | runuser -u manythreads-bridge -- sudo -n -- /opt/manythreads-bridge/helper/mt-team-helper run "$team" "$kind"
