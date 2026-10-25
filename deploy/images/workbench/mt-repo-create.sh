#!/bin/bash
# Creates the repository of record /workspace/repos/<name>.git: bare, owned by `repo`, readable by everyone, written only through
# mt-receive-pack (which runs the protecting update hook). Run as `repo`.
#   by a bot, through sudo:   sudo -u repo mt-repo-create.sh <name>          (exactly one argument; an empty repository; at most 50 repositories)
#   by the reconcile loop:    mt-repo-create.sh <name> [https-origin [branch]]   (origin only if it is plain and starts with a prefix in $MT_ORIGIN_ALLOW)
set -euo pipefail
name="${1:-}"; origin="${2:-}"; branch="${3:-}"
if [ -n "${SUDO_USER:-}" ]; then   # sudo sets this itself; a bot cannot choose it
  [ "$#" -eq 1 ] || { echo "usage: sudo -u repo mt-repo-create.sh <name>" >&2; exit 2; }
  count=$(find /workspace/repos -maxdepth 1 -name '*.git' | wc -l)
  [ "$count" -lt "${MT_MAX_REPOS:-50}" ] || { echo "too many repositories" >&2; exit 2; }
fi
[[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,60}$ ]] && [[ "$name" != *..* ]] || { echo "bad repository name (lowercase letters, digits, . _ -)" >&2; exit 2; }
# An address is compared as written, never normalised: it must be plain (https, no user name, query, fragment or "@", no empty or dot path segment,
# also not as %2e) and start with an allowed prefix. Same rule as isPlainRepoUrl in @manythreads/shared.
plain() {
  [[ "$1" =~ ^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*/?$ ]] || return 1
  shopt -s nocasematch
  if [[ "$1" =~ /(\.|%2e){1,2}(/|$) ]]; then shopt -u nocasematch; return 1; fi
  shopt -u nocasematch
}
if [ -n "$origin" ]; then
  plain "$origin" || { echo "origin is not a plain https address" >&2; exit 2; }
  ok=no
  IFS=',' read -ra allow <<<"${MT_ORIGIN_ALLOW:-}"
  for prefix in "${allow[@]}"; do
    plain "$prefix" || continue
    case "$prefix" in https://*) [[ "$prefix" == */ ]] || prefix="$prefix/"; [[ "$origin" == "$prefix"* ]] && ok=yes ;; esac
  done
  [ "$ok" = yes ] || { echo "origin not on the allowlist" >&2; exit 2; }
fi
if [ -n "$branch" ]; then
  [[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ ]] && [[ "$branch" != *..* ]] || { echo "bad branch name" >&2; exit 2; }
fi
dir="/workspace/repos/$name.git"
if [ -d "$dir" ]; then
  # the project's address may have changed: point the repository of record at the current one (the origin was checked above)
  if [ -n "$origin" ]; then
    current=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
    if [ -z "$current" ]; then git -C "$dir" remote add origin "$origin"
    elif [ "$current" != "$origin" ]; then git -C "$dir" remote set-url origin "$origin"; echo "$dir origin updated"; fi
  fi
  # follow the project's branch on its origin: fast-forward only (a non-fast-forward is refused and logged); the bots' own branches are not touched
  if [ -n "$origin" ] && [ -n "$branch" ]; then
    git -C "$dir" fetch --quiet origin "refs/heads/$branch:refs/heads/$branch" 2>/dev/null || echo "$dir: $branch did not fast-forward from origin"
  fi
  echo "$dir exists"; exit 0
fi
umask 0022
if [ -n "$origin" ]; then
  if [ -n "$branch" ]; then git clone --bare --branch "$branch" -- "$origin" "$dir"; else git clone --bare -- "$origin" "$dir"; fi
else git init --bare -- "$dir" >/dev/null; fi
git -C "$dir" config receive.denyDeletes true
git -C "$dir" config receive.denyNonFastForwards true
install -m 0755 /usr/local/share/workbench/hooks/update "$dir/hooks/update"
echo "created $dir"
