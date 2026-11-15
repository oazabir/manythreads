#!/usr/bin/env bash
# Container test of install/bridge.sh (P26-14, P26-15): runs the real installer in a throwaway Debian container against a stand-in site (stub-site.mjs), with systemctl replaced by a
# recorder. It proves: Node 22 is fetched and its hash checked, the bundle is downloaded and its hash checked, `npm ci` installs the pinned agent programs, the two users and the folders
# exist with the right modes, the agents are detected, the config is written (with the tools folder and the publisher's socket), the enrolment call is made and its key is kept in 0600,
# the two units are written, and --update and --uninstall --purge undo it all. The host is not touched: no installer runs on it.
#
#   bash tools/agent-bridge/install/container-test/run.sh [--keep]
#
# Needs docker and a network that reaches nodejs.org and registry.npmjs.org. Takes about two minutes. The container and the image are removed at the end unless --keep.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
keep=0
[ "${1:-}" = --keep ] && keep=1
work="$(mktemp -d)"
name="mt-bridge-installer-test-$$"
image="${MT_TEST_IMAGE:-debian:bookworm-slim}"
port="${MT_TEST_PORT:-18099}"
code="mte_$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \n')"
server_pid=''
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  if [ "$keep" -eq 0 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    [ -n "${MT_TEST_IMAGE:-}" ] || docker rmi "$image" >/dev/null 2>&1 || true
    docker builder prune -af >/dev/null 2>&1 || true
    rm -rf "$work"
  else
    echo "kept: container $name, folder $work"
  fi
}
trap cleanup EXIT

node "$repo/tools/agent-bridge/install/build.mjs" --out "$work/dist" >/dev/null
node "$here/stub-site.mjs" "$work/dist" "$port" "$code" "$work/site.log" >/dev/null &
server_pid=$!
sleep 1

docker run -d --name "$name" --network host "$image" sleep 3600 >/dev/null
# the packages the installer expects on a server, and a systemctl that records its calls (the container runs no systemd)
docker exec "$name" bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils git jq util-linux procps >/dev/null'
docker exec "$name" bash -c 'mkdir -p /run/systemd/system && printf "#!/bin/sh\necho \"systemctl \$*\" >> /var/log/systemctl.log\n" > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl'
docker cp "$work/dist/bridge.sh" "$name:/tmp/bridge.sh.template"

fail=0
check() {
  local what="$1"; shift
  local out
  if out="$(docker exec "$name" bash -c "$*" 2>&1)"; then echo "ok   $what"; else echo "FAIL $what"; printf '%s\n' "$out" | tail -8 | sed 's/^/       /'; fail=$((fail + 1)); fi
}

echo "--- install"
curl -fsS "http://127.0.0.1:$port/install/bridge.sh" -o "$work/bridge.sh"
docker cp "$work/bridge.sh" "$name:/tmp/bridge.sh"
# the code goes in through a file (--code-file), the way the Runners page advises: not through the command line
docker exec "$name" bash -c 'umask 077; printf "%s\n" "$1" >/tmp/enrol-code' _ "$code"
docker exec "$name" bash /tmp/bridge.sh --code-file /tmp/enrol-code --no-browser --no-hermes --insecure-for-tests 2>&1 | sed 's/^/  | /' || true

check "node 22 or later is installed"            '/opt/manythreads-bridge/node/bin/node -v | grep -q "^v22"'
check "the bundle is unpacked and complete"      'test -f /opt/manythreads-bridge/current/.complete && test -f /opt/manythreads-bridge/current/bridge.mjs'
check "the pinned agent programs are installed"  'test -x /opt/manythreads-bridge/current/agents/node_modules/.bin/claude-agent-acp && test -x /opt/manythreads-bridge/current/agents/node_modules/.bin/codex-acp'
check "mt-git and mt-publish are on the tools folder" 'test -x /opt/manythreads-bridge/current/tools/mt-git && test -x /opt/manythreads-bridge/current/tools/mt-publish && grep -q "/opt/manythreads-bridge/node/bin/node" /opt/manythreads-bridge/current/tools/mt-publish'
check "mt-publish without a run token says so"   '/opt/manythreads-bridge/current/tools/mt-publish check x 2>&1 | grep -q "no run token"'
check "mt-git runs"                              '/opt/manythreads-bridge/current/tools/mt-git 2>&1 | grep -qi "usage\|record"'
check "the bridge user exists"                   'id manythreads-bridge'
check "the publisher user exists"                'id manythreads-publisher'
check "the key is kept, mode 0600"               'test "$(stat -c %a /etc/manythreads-bridge/key)" = 600 && grep -q "^mtb_" /etc/manythreads-bridge/key'
check "the sign-in and state folders are 0700"   'test "$(stat -c %a /var/lib/manythreads-bridge/auth)" = 700 && test "$(stat -c %a /var/lib/manythreads-bridge/state)" = 700 && test "$(stat -c %a /var/lib/manythreads-bridge/hermes)" = 700'
check "the publisher user cannot read them"      'runuser -u manythreads-publisher -- sh -c "! ls /var/lib/manythreads-bridge/auth /var/lib/manythreads-bridge/state"'
check "the config names the tools and the socket" 'jq -e ".server.toolsDir == \"/opt/manythreads-bridge/current/tools\" and .server.publisherSocket == \"/run/manythreads-publisher/publisher.sock\" and (.server.instructions == null) and (.server.agents | has(\"claude\"))" /etc/manythreads-bridge/config.json'
check "the bridge unit has a PATH with node"     'grep -q "^Environment=PATH=/opt/manythreads-bridge/node/bin:" /etc/systemd/system/manythreads-bridge.service'
check "the publisher unit is written"            'grep -q "^User=manythreads-publisher" /etc/systemd/system/manythreads-publisher.service && grep -q "PUBLISHER_CREDENTIAL_FROM_SITE=1" /etc/systemd/system/manythreads-publisher.service && grep -q "^ExecStart=/opt/manythreads-bridge/node/bin/node /opt/manythreads-bridge/releases/.*/tools/publisher.mjs serve" /etc/systemd/system/manythreads-publisher.service'
check "both services were started"               'grep -q "restart manythreads-bridge.service" /var/log/systemctl.log && grep -q "restart manythreads-publisher.service" /var/log/systemctl.log'
check "the publisher serves on its socket (run by hand as its user)" '
  mkdir -p /run/manythreads-publisher && chown manythreads-publisher:manythreads-bridge /run/manythreads-publisher && chmod 750 /run/manythreads-publisher
  (runuser -u manythreads-publisher -g manythreads-bridge -- env PUBLISHER_SERVER_URL=http://127.0.0.1:'"$port"' PUBLISHER_SOCKET=/run/manythreads-publisher/publisher.sock PUBLISHER_SOCKET_MODE=660 PUBLISHER_CREDENTIAL_FROM_SITE=1 PUBLISHER_WORK=/var/lib/manythreads-bridge/work PUBLISHER_SCRIPT=/opt/manythreads-bridge/current/tools/mt-publish.sh /opt/manythreads-bridge/node/bin/node /opt/manythreads-bridge/releases/*/tools/publisher.mjs serve >/tmp/publisher.log 2>&1 &)
  sleep 2
  cat /tmp/publisher.log
  ls -l /run/manythreads-publisher/
  test "$(stat -c %a /run/manythreads-publisher/publisher.sock)" = 660
  runuser -u manythreads-bridge -- sh -c "mkdir -p /var/lib/manythreads-bridge/work/acme/dev/proj && cd /var/lib/manythreads-bridge/work/acme/dev/proj && git init -q -b main . && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m first && git remote add origin https://github.com/acme/proj.git"
  runuser -u manythreads-bridge -- env MANYTHREADS_RUN_TOKEN=mtr_bogusbogusbogusbogusbogusbogus MT_PUBLISH_SOCKET=/run/manythreads-publisher/publisher.sock /opt/manythreads-bridge/current/tools/mt-publish check proj > /tmp/answer.txt 2>&1 || true
  cat /tmp/answer.txt
  test -s /tmp/answer.txt && ! grep -q "did not answer" /tmp/answer.txt'

echo "--- the site saw"
sed 's/^/  | /' "$work/site.log"
grep -q '^POST /api/bridge/enrol 200' "$work/site.log" && echo "ok   the enrolment call was made and accepted" || { echo "FAIL the enrolment call"; fail=$((fail + 1)); }
grep -q '^enrol agents=.*claude-code' "$work/site.log" && echo "ok   the machine reported its agents" || { echo "FAIL the agents report"; fail=$((fail + 1)); }

echo "--- update (no code needed)"
docker exec "$name" bash /tmp/bridge.sh --update --no-browser --no-hermes --insecure-for-tests 2>&1 | sed 's/^/  | /' || true
check "the key survived the update"              'grep -q "^mtb_" /etc/manythreads-bridge/key'

echo "--- uninstall --purge (a key a rotation wrote under the state folder goes too)"
docker exec "$name" bash -c 'printf "%s\n" "mtb_$(printf "%064d" 0)" >/var/lib/manythreads-bridge/state/key'
docker exec "$name" bash /tmp/bridge.sh --uninstall --purge --insecure-for-tests 2>&1 | sed 's/^/  | /' || true
check "program, config and units are gone"       '! test -e /opt/manythreads-bridge && ! test -e /etc/manythreads-bridge && ! test -e /etc/systemd/system/manythreads-bridge.service && ! test -e /etc/systemd/system/manythreads-publisher.service'
check "no key is left behind"                    '! test -e /var/lib/manythreads-bridge/state/key'
check "both users are gone"                      '! id manythreads-bridge && ! id manythreads-publisher'
grep -q '^POST /api/bridge/uninstall' "$work/site.log" && echo "ok   the site was told" || echo "note the site was not told (the stub has no uninstall route)"

echo "--- $fail failed"
[ "$fail" -eq 0 ]
