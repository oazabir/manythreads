#!/usr/bin/env bash
# Shared helpers for deploy/ops workflows. Needs env SSHPASS (from secrets.ROOT_PASSWORD) and sshpass installed.
# Never print SSHPASS. Remote scripts are fed on stdin so no workflow input is ever interpolated into a command line.
REMOTE_HOST=65.109.71.84
REMOTE_PORT=44033
SSH_OPTS=(-p "$REMOTE_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -o LogLevel=ERROR)

remote() { sshpass -e ssh "${SSH_OPTS[@]}" "root@${REMOTE_HOST}" "$@"; }

# remote_sh NAME=value ...  < script
# Runs the stdin script remotely with KUBECONFIG set and the (already validated) vars exported.
remote_sh() {
  {
    echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml PATH="$PATH:/usr/local/bin"; set -euo pipefail'
    local kv
    for kv in "$@"; do printf 'export %s=%q\n' "${kv%%=*}" "${kv#*=}"; done
    cat
  } | remote 'bash -s'
}
