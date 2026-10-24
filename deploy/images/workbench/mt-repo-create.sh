#!/bin/bash
# Creates the repository of record /workspace/repos/<name>.git: bare, owned by `repo`, readable by everyone, written only through
# mt-receive-pack (which runs the protecting update hook). Run as `repo`.
#   by a bot, through sudo:   sudo -u repo mt-repo-create.sh <name>          (exactly one argument; an empty repository; at most 50 repositories)
#   by the reconcile loop:    mt-repo-create.sh <name> [https-origin]        (origin only if it starts with a prefix in $MT_ORIGIN_ALLOW)
set -euo pipefail
name="${1:-}"; origin="${2:-}"
if [ -n "${SUDO_USER:-}" ]; then   # sudo sets this itself; a bot cannot choose it
  [ "$#" -eq 1 ] || { echo "usage: sudo -u repo mt-repo-create.sh <name>" >&2; exit 2; }
  count=$(find /workspace/repos -maxdepth 1 -name '*.git' | wc -l)
  [ "$count" -lt "${MT_MAX_REPOS:-50}" ] || { echo "too many repositories" >&2; exit 2; }
fi
[[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,60}$ ]] && [[ "$name" != *..* ]] || { echo "bad repository name (lowercase letters, digits, . _ -)" >&2; exit 2; }
if [ -n "$origin" ]; then
  ok=no
  IFS=',' read -ra allow <<<"${MT_ORIGIN_ALLOW:-}"
  for prefix in "${allow[@]}"; do
    case "$prefix" in https://*) [[ "$origin" == "$prefix"* ]] && ok=yes ;; esac
  done
  [ "$ok" = yes ] || { echo "origin not on the allowlist" >&2; exit 2; }
fi
dir="/workspace/repos/$name.git"
if [ -d "$dir" ]; then echo "$dir exists"; exit 0; fi
umask 0022
if [ -n "$origin" ]; then git clone --bare -- "$origin" "$dir"; else git init --bare -- "$dir" >/dev/null; fi
git -C "$dir" config receive.denyDeletes true
git -C "$dir" config receive.denyNonFastForwards true
install -m 0755 /usr/local/share/workbench/hooks/update "$dir/hooks/update"
echo "created $dir"
