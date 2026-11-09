#!/bin/bash
# The Hermes container of the Docker Compose install (docs/deploy/compose.md): a gateway that serves one profile per bot, and a small loop that
# picks up the profiles `admin init` and `admin brain-profile` write into the volume it shares with the manythreads container.
#
#   * the default profile only multiplexes the others (`gateway.multiplex_profiles`) and opens the API on port 8642;
#   * a profile that exists at start is served by the gateway itself; one that appears later is attached with `hermes -p <name> gateway run`
#     (about two seconds), and one whose config.yaml or .env changed is restarted with `gateway restart` (a served profile keeps its old
#     connection to the MCP address otherwise). The same three commands the pod's profile sync uses (deploy/images/hermes-pod/sync.mjs).
#
# The container starts as root only to make the shared profile directory writable for the user `node`, then drops to it.
set -euo pipefail
SELF="${BASH_SOURCE[0]}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p /home/node/.hermes/profiles
  chown node:node /home/node/.hermes /home/node/.hermes/profiles
  exec setpriv --reuid=node --regid=node --init-groups /bin/bash "$SELF" "$@"
fi
export HOME=/home/node
export PATH="/home/node/.local/bin:$PATH"
H="$HOME/.hermes"
P="$H/profiles"
STATE=/tmp/hermes-profile-state
mkdir -p "$P" "$STATE"
log() { printf 'profiles: %s\n' "$*"; }

# Rewritten at every start: nothing in the default profile is state worth keeping.
cat > "$H/config.yaml" <<YAML
gateway:
  multiplex_profiles: true
  api_server:
    enabled: true
    host: 0.0.0.0
    port: ${API_SERVER_PORT:-8642}
YAML

# A fingerprint of the files that matter, never printed.
fingerprint() { cat "$1/config.yaml" "$1/.env" 2>/dev/null | sha256sum | cut -d' ' -f1; }

# $1 = "start": record what is there (the gateway serves it); otherwise attach or restart what is new or changed.
scan() {
  local d name now before
  for d in "$P"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in .*) continue ;; esac
    [ -f "$d/config.yaml" ] && [ -f "$d/.env" ] || continue
    now=$(fingerprint "$d")
    before=$(cat "$STATE/$name" 2>/dev/null || true)
    if [ "$1" = start ]; then
      printf '%s' "$now" > "$STATE/$name"
    elif [ -z "$before" ]; then
      if timeout 90 hermes -p "$name" gateway run >/tmp/hermes-attach.log 2>&1; then log "$name attached"; printf '%s' "$now" > "$STATE/$name"; else log "$name: attach failed: $(tail -c 300 /tmp/hermes-attach.log)"; fi
    elif [ "$before" != "$now" ]; then
      if timeout 90 hermes -p "$name" gateway restart >/tmp/hermes-attach.log 2>&1; then log "$name restarted"; printf '%s' "$now" > "$STATE/$name"; else log "$name: restart failed: $(tail -c 300 /tmp/hermes-attach.log)"; fi
    fi
  done
}

scan start
( sleep 20; while true; do scan loop || true; sleep 5; done ) &
export API_SERVER_ENABLED=true API_SERVER_HOST=0.0.0.0
exec hermes gateway run
