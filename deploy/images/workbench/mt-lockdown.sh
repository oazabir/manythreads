#!/bin/bash
# The workspace volume arrives world-writable (0777). Bots must never be able to rename or replace /workspace, /workspace/bots or
# /workspace/repos, because root and `repo` operate inside them. Idempotent; run at start and by every reconcile pass.
set -euo pipefail
for d in /workspace /workspace/bots /workspace/repos; do
  if [ -L "$d" ]; then echo "lockdown: $d is a symlink; removing it" >&2; rm -f -- "$d"; fi
  mkdir -p -- "$d"
done
chown -h root:root /workspace /workspace/bots
chmod 0755 /workspace /workspace/bots
chown -h repo:repo /workspace/repos
chmod 0755 /workspace/repos
