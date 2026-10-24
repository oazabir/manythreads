#!/bin/bash
# What `git push` runs for a bot (system gitconfig: remote.origin.receivepack): git-receive-pack as the `repo` user, so only that account
# writes a repository of record and the update hook cannot be bypassed from a bot's own git settings. Refuses anything that is not a
# plain repository directory of `repo` with `repo`-owned hooks and config.
set -euo pipefail
path="${1:-}"
[ "$#" -eq 1 ] && [[ "$path" =~ ^/workspace/repos/[a-z0-9][a-z0-9._-]*\.git$ ]] && [[ "$path" != *..* ]] || { echo "not a repository of record" >&2; exit 2; }
[ -d "$path" ] && [ ! -L "$path" ] && [ "$(realpath -e "$path")" = "$path" ] || { echo "no such repository" >&2; exit 2; }
[ "$(stat -c %U "$path")" = repo ] || { echo "repository is not owned by repo" >&2; exit 2; }
for p in "$path/hooks" "$path/config" "$path/hooks/update"; do
  [ -e "$p" ] && [ ! -L "$p" ] && [ "$(stat -c %U "$p")" = repo ] || { echo "repository is not in order ($p)" >&2; exit 2; }
done
# any other hook file must be repo's too (a bot cannot create files here, but check anyway)
for h in "$path"/hooks/*; do
  [ -e "$h" ] || continue
  case "$(basename "$h")" in update|*.sample) ;; *) echo "unexpected hook $(basename "$h")" >&2; exit 2 ;; esac
done
export MT_BOT_PUSH=1
exec git -c core.hooksPath="$path/hooks" receive-pack "$path"
