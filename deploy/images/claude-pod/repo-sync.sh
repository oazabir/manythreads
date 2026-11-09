#!/bin/sh
# The repo-sync step of a Claude Code runner's pod: clones and fetches the projects of the teams on the runner's list.
# The list is one line per clone: <team> <bot> <project> <branch or -> <https address>. It comes from two places: /run/repos/repos.txt, which the bridge rewrites whenever the
# platform sends a new list (the controller does it within seconds of a project being added), and /etc/bridge/repos.txt, the ConfigMap copy the pod started with (a ConfigMap
# reaches a pod only after about a minute). The first is used when it exists. The list is read every 5 seconds, so a new project is cloned within seconds; a clone that already
# exists is fetched once a minute, not every 5 seconds. It has no Kubernetes token and no sign-in file, and it writes no credential into a clone: only public addresses work
# (publishing is the publisher container's job, with a token this step never sees).
# REPO_SYNC_* are test hooks (a local bare "origin" and short waits); the pod sets none of them.
export HOME=/tmp
export GIT_TERMINAL_PROMPT=0
LIST="${REPO_SYNC_LIST:-/run/repos/repos.txt}"
FALLBACK="${REPO_SYNC_FALLBACK:-/etc/bridge/repos.txt}"
WORK="${REPO_SYNC_WORK:-/work}"
INTERVAL="${REPO_SYNC_INTERVAL:-5}"
FETCH_EVERY="${REPO_SYNC_FETCH_EVERY:-12}"
STATE="${REPO_SYNC_STATE:-/tmp/repo-sync}"
RETRY_AFTER="${REPO_SYNC_RETRY_AFTER:-60}"
ONCE="${REPO_SYNC_ONCE:-}"
mkdir -p "$STATE"
tick=0
while true; do
  src="$FALLBACK"
  [ -f "$LIST" ] && src="$LIST"
  if [ -f "$src" ]; then
    while read -r team bot project branch origin; do
      [ -n "$origin" ] || continue
      # the names come from our own database but are checked again: letters, digits, dot, dash and underscore only
      case "$team$bot$project" in *[!A-Za-z0-9._-]*) echo "repo-sync: skipping a name with odd characters"; continue ;; esac
      # a name that is only dots would climb out of its folder
      case "$team" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$bot" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$project" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$origin" in https://*) ;; *) echo "repo-sync: skipping $project: not an https address"; continue ;; esac
      dir="$WORK/$team/$bot/$project"
      if [ -d "$dir/.git" ]; then
        # an existing clone is fetched once in FETCH_EVERY rounds
        [ $((tick % FETCH_EVERY)) -eq 0 ] || continue
        timeout 120 git -C "$dir" fetch --quiet origin </dev/null 2>&1 | head -n 3
      else
        # a clone that failed is tried again after RETRY_AFTER seconds, not every round
        mark="$STATE/failed.$team.$bot.$project"
        now=$(date +%s)
        if [ -f "$mark" ] && [ $((now - $(cat "$mark" 2>/dev/null || echo 0))) -lt "$RETRY_AFTER" ]; then continue; fi
        mkdir -p "$WORK/$team/$bot"
        if [ "$branch" = "-" ]; then
          timeout 300 git clone --quiet -- "$origin" "$dir" </dev/null 2>&1 | head -n 3
        else
          timeout 300 git clone --quiet --branch "$branch" -- "$origin" "$dir" </dev/null 2>&1 | head -n 3
        fi
        if [ -d "$dir/.git" ]; then rm -f "$mark"; else echo "$now" > "$mark"; fi
      fi
    done < "$src"
  fi
  tick=$((tick + 1))
  [ -z "$ONCE" ] || exit 0
  sleep "$INTERVAL"
done
