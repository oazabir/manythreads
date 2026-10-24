#!/bin/bash
# Workbench entrypoint: host key, one reconcile pass BEFORE sshd opens (so the workspace is locked down first), the reconcile loop, then sshd.
set -euo pipefail
mkdir -p /etc/ssh/host /run/sshd /keys
[ -f /etc/ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/host/ssh_host_ed25519_key
/usr/local/bin/mt-lockdown.sh
/usr/local/bin/mt-reconcile.sh 2>&1 | sed 's/^/reconcile: /' || true
( while true; do /usr/local/bin/mt-reconcile.sh 2>&1 | sed 's/^/reconcile: /' || true; sleep 5; done ) &
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
