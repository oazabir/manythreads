#!/bin/bash
# Hands each project's GitHub token to the `repo` user and to nobody else. Runs as root, from mt-reconcile.sh.
#   /etc/workbench-push/<project>   the Kubernetes Secret of the pod (root-only: the kubelet makes the files 0400 root)
#   /run/mt-push/<project>          the copy mt-publish.sh reads: 0400 and owned by `repo`, in a directory only ROOT can write (0755, a memory
#                                   volume): `repo` and the bots can neither plant a link there nor swap a file, and root's temp files are safe
# Each file is a JSON document: the token and the repository address it was issued for. A project whose key left the Secret loses its copy. Safe to run again and again; a file that did not change is not rewritten.
# MT_PUSH_SRC / MT_PUSH_DIR / MT_REPO_USER exist so the tests can run it without root and without /etc; a bot cannot set them (sudo clears its environment,
# and root runs this script from the reconcile loop).
set -uo pipefail
SRC="${MT_PUSH_SRC:-/etc/workbench-push}"
DIR="${MT_PUSH_DIR:-/run/mt-push}"
OWNER="${MT_REPO_USER:-repo}"
name_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{0,60}$ ]] && [[ "$1" != *..* ]]; }
if [ ! -d "$DIR" ] || [ -L "$DIR" ]; then
  [ -L "$DIR" ] && rm -f -- "$DIR"
  install -d -m 0755 -o root -g root -- "$DIR" || exit 1
fi
# a fresh memory volume is world-writable: make it root's before anything is written
chown root:root -- "$DIR" 2>/dev/null; chmod 0755 -- "$DIR"
if [ -d "$SRC" ]; then
  for f in "$SRC"/*; do
    [ -e "$f" ] || continue
    n=$(basename -- "$f")
    name_ok "$n" || continue
    dest="$DIR/$n"
    if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s -- "$f" "$dest"; then continue; fi
    tmp="$DIR/.$n.new"
    rm -f -- "$tmp"
    ( umask 077; cat -- "$f" > "$tmp" ) || { rm -f -- "$tmp"; continue; }
    chown "$OWNER" -- "$tmp" && chmod 0400 -- "$tmp" && mv -f -- "$tmp" "$dest"
  done
fi
for f in "$DIR"/* "$DIR"/.[!.]*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  n=$(basename -- "$f")
  case "$n" in .*.new) rm -f -- "$f"; continue ;; esac
  [ -e "$SRC/$n" ] || rm -f -- "$f"
done
exit 0
