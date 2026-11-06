#!/bin/sh
# The repo-sync step of a Claude Code runner's pod: clones and fetches the projects of the teams on the runner's list.
# Reads /etc/bridge/repos.txt, one line per clone: <team> <bot> <project> <branch or -> <https address>. It has no Kubernetes token and no sign-in file,
# and it writes no credential into a clone: only public addresses work until a team token is mounted for this step alone.
export HOME=/tmp
export GIT_TERMINAL_PROMPT=0
LIST=/etc/bridge/repos.txt
while true; do
  if [ -f "$LIST" ]; then
    while read -r team bot project branch origin; do
      [ -n "$origin" ] || continue
      # the names come from our own database but are checked again: letters, digits, dot, dash and underscore only
      case "$team$bot$project" in *[!A-Za-z0-9._-]*) echo "repo-sync: skipping a name with odd characters"; continue ;; esac
      # a name that is only dots would climb out of its folder
      case "$team" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$bot" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$project" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$origin" in https://*) ;; *) echo "repo-sync: skipping $project: not an https address"; continue ;; esac
      dir="/work/$team/$bot/$project"
      if [ -d "$dir/.git" ]; then
        timeout 120 git -C "$dir" fetch --quiet origin 2>&1 | head -n 3
      else
        mkdir -p "/work/$team/$bot"
        if [ "$branch" = "-" ]; then
          timeout 300 git clone --quiet -- "$origin" "$dir" 2>&1 | head -n 3
        else
          timeout 300 git clone --quiet --branch "$branch" -- "$origin" "$dir" 2>&1 | head -n 3
        fi
      fi
    done < "$LIST"
  fi
  sleep 60
done
