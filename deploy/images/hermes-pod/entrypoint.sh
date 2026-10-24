#!/bin/bash
# Hermes container: a minimal default profile that multiplexes the team's bot profiles, the profile sync, then `hermes gateway run`.
set -euo pipefail
H="$HOME/.hermes"
mkdir -p "$H/profiles" "$HOME/.ssh/keys" /keys
chmod 0700 "$HOME/.ssh" "$HOME/.ssh/keys"
# the workbench's host key changes whenever its container restarts; it is reachable on localhost only
printf '%s\n' 'Host 127.0.0.1 localhost' '  UserKnownHostsFile /dev/null' '  StrictHostKeyChecking no' '  LogLevel ERROR' > "$HOME/.ssh/config"
chmod 0600 "$HOME/.ssh/config"
# Rewritten every start: nothing in the default profile is state worth keeping.
cat > "$H/config.yaml" <<YAML
gateway:
  multiplex_profiles: true
  api_server:
    enabled: true
    host: 0.0.0.0
    port: ${API_SERVER_PORT:-8642}
YAML
node /usr/local/lib/hermes-pod/sync.mjs --once
( while true; do sleep 10; node /usr/local/lib/hermes-pod/sync.mjs --once || true; done ) &
export API_SERVER_ENABLED=true API_SERVER_HOST=0.0.0.0
exec hermes gateway run
