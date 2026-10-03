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

# remote_set_password <email> <password>
# Sets a person's password on the live site through the server's admin CLI (packages/server/src/cli/admin.ts), run inside the
# server pod. The password travels only on stdin: it is sent inside the SSH stream (not the remote command line) and piped into
# `kubectl exec -i`, so it is in no argv, no `ps`, no log (printf is a builtin; this script never runs with xtrace). The caller
# masks it (::add-mask::) before calling. Signs the person out everywhere and writes an identity.password.admin_set audit event.
remote_set_password() {
  local email="$1" pw="$2"
  [[ "$email" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$ ]] || { echo "refusing an invalid email address" >&2; return 1; }
  [ "${#pw}" -ge 8 ] || { echo "refusing a password under 8 characters" >&2; return 1; }
  remote_sh "PW_EMAIL=$email" "PW_VALUE=$pw" <<'REMOTE'
printf '%s\n' "$PW_VALUE" | kubectl exec -i -n manythreads deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password "$PW_EMAIL"
REMOTE
}
