#!/usr/bin/env bash
# Container test of install/bridge.sh (P26-14, P26-15): runs the real installer in a throwaway Debian container against a stand-in site (stub-site.mjs), with systemctl replaced by a
# recorder. It proves: Node 22 is fetched and its hash checked, the bundle is downloaded and its hash checked, `npm ci` installs the pinned agent programs, the two users and the folders
# exist with the right modes, the agents are detected, the config is written (with the tools folder and the publisher's socket), the enrolment call is made and its key is kept in 0600,
# the two units are written, and --update and --uninstall --purge undo it all. P26-22: it also proves the per-team users with two teams: the helper and the sudo rule, each run as its own
# user, one team unable to read another's folders, kubeconfig or token (files and /proc), both using the shared sign-in folder, the bridge's key and state out of their reach, and the sudo rule
# allowing nothing else. Hermes (owner decision 2026-11-16: the script never installs it): the machine has none at the first install (reported as not found, no runner); a stub `hermes`
# in /usr/local/bin is found by `--update` and started as a team user with that team's own HERMES_HOME; a stub under /root, or one the team users cannot enter, is reported as not usable
# (one plain sentence with the fix) and left out; /opt/*/bin and `--hermes-bin` are found; and no program ever asks Hermes' download host (a recording `curl` and a dead address for it).
# The host is not touched: no installer runs on it.
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
docker exec "$name" bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils git jq util-linux procps sudo passwd >/dev/null'
docker exec "$name" bash -c 'mkdir -p /run/systemd/system && printf "#!/bin/sh\necho \"systemctl \$*\" >> /var/log/systemctl.log\n" > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl'
# a `curl` that records every address it is given (never a header or a body: the key goes in on standard input) and one that Hermes' download host could not answer; the installer must ask neither
docker exec "$name" bash -c 'printf "#!/bin/sh\nfor a in \"\$@\"; do case \"\$a\" in http*) echo \"\$a\" >> /var/log/curl-urls.log ;; esac; done\nexec /usr/bin/curl \"\$@\"\n" > /usr/local/bin/curl && chmod +x /usr/local/bin/curl && echo "127.0.0.1 hermes-agent.nousresearch.com" >> /etc/hosts'
docker cp "$work/dist/bridge.sh" "$name:/tmp/bridge.sh.template"
docker cp "$here/as-team.sh" "$name:/usr/local/bin/as-team"
docker cp "$here/probe.sh" "$name:/usr/local/bin/mt-probe"
docker exec "$name" chmod 0755 /usr/local/bin/as-team /usr/local/bin/mt-probe

fail=0
check() {
  local what="$1"; shift
  local out
  if out="$(docker exec "$name" bash -c "$*" 2>&1)"; then echo "ok   $what"; else echo "FAIL $what"; printf '%s\n' "$out" | tail -8 | sed 's/^/       /'; fail=$((fail + 1)); fi
}

# like `check`, but every line must succeed (a plain check judges by its last line only)
checkx() {
  local what="$1"; shift
  check "$what" "$(printf '%s\n' "$*" | sed -e '/^[[:space:]]*$/!s/$/ || exit 1/')"
}

echo "--- install"
curl -fsS "http://127.0.0.1:$port/install/bridge.sh" -o "$work/bridge.sh"
docker cp "$work/bridge.sh" "$name:/tmp/bridge.sh"
# the code goes in through a file (--code-file), the way the Runners page advises: not through the command line
docker exec "$name" bash -c 'umask 077; printf "%s\n" "$1" >/tmp/enrol-code' _ "$code"
# no Hermes is on the machine at this first install (and no --no-hermes: it must look and say so)
docker exec "$name" bash -c 'bash /tmp/bridge.sh --code-file /tmp/enrol-code --no-browser --insecure-for-tests 2>&1 | tee /tmp/install-1.log' | sed 's/^/  | /' || true

check "node 22 or later is installed"            '/opt/manythreads-bridge/node/bin/node -v | grep -q "^v22"'
check "the bundle is unpacked and complete"      'test -f /opt/manythreads-bridge/current/.complete && test -f /opt/manythreads-bridge/current/bridge.mjs'
check "the pinned agent programs are installed"  'test -x /opt/manythreads-bridge/current/agents/node_modules/.bin/claude-agent-acp && test -x /opt/manythreads-bridge/current/agents/node_modules/.bin/codex-acp'
check "mt-git and mt-publish are on the tools folder" 'test -x /opt/manythreads-bridge/current/tools/mt-git && test -x /opt/manythreads-bridge/current/tools/mt-publish && grep -q "/opt/manythreads-bridge/node/bin/node" /opt/manythreads-bridge/current/tools/mt-publish'
check "mt-publish without a run token says so"   '/opt/manythreads-bridge/current/tools/mt-publish check x 2>&1 | grep -q "no run token"'
check "mt-git runs"                              '/opt/manythreads-bridge/current/tools/mt-git 2>&1 | grep -qi "usage\|record"'
check "the bridge user exists"                   'id manythreads-bridge'
check "the publisher user exists"                'id manythreads-publisher'
check "the key is kept, mode 0600"               'test "$(stat -c %a /etc/manythreads-bridge/key)" = 600 && grep -q "^mtb_" /etc/manythreads-bridge/key'
check "the state and Hermes folders are 0700, the sign-in folders the agents group's" 'test "$(stat -c %a /var/lib/manythreads-bridge/state)" = 700 && test "$(stat -c %a /var/lib/manythreads-bridge/hermes)" = 700 && test "$(stat -c %U:%a:%G /var/lib/manythreads-bridge/auth)" = root:750:mt-agents && test "$(stat -c %a:%G:%U /var/lib/manythreads-bridge/auth/claude)" = 2770:mt-agents:manythreads-bridge'
check "the publisher user cannot read them"      'runuser -u manythreads-publisher -- sh -c "! ls /var/lib/manythreads-bridge/auth /var/lib/manythreads-bridge/state"'
check "the config names the tools and the socket" 'jq -e ".server.toolsDir == \"/opt/manythreads-bridge/current/tools\" and .server.publisherSocket == \"/run/manythreads-publisher/publisher.sock\" and .server.teamUsers.helper == \"/opt/manythreads-bridge/helper/mt-team-helper\" and (.server.instructions == null) and (.server.agents | has(\"claude\"))" /etc/manythreads-bridge/config.json'
check "the bridge unit has a PATH with node"     'grep -q "^Environment=PATH=/opt/manythreads-bridge/node/bin:" /etc/systemd/system/manythreads-bridge.service'
check "the publisher unit is written"            'grep -q "^User=manythreads-publisher" /etc/systemd/system/manythreads-publisher.service && grep -q "PUBLISHER_CREDENTIAL_FROM_SITE=1" /etc/systemd/system/manythreads-publisher.service && grep -q "^ExecStart=/opt/manythreads-bridge/node/bin/node /opt/manythreads-bridge/releases/.*/tools/publisher.mjs serve" /etc/systemd/system/manythreads-publisher.service'
check "both services were started"               'grep -q "restart manythreads-bridge.service" /var/log/systemctl.log && grep -q "restart manythreads-publisher.service" /var/log/systemctl.log'
echo "--- Hermes is found, never installed (owner decision 2026-11-16)"
checkx "no Hermes on the machine: reported as not found, no table entry, no runner, nothing asked of Hermes' download host" '
  grep -q "^Hermes: not found" /tmp/install-1.log
  grep -q "^agents on this server: Claude Code (installed by this script), Codex (installed by this script), Hermes: not found" /tmp/install-1.log
  jq -e ".agents | has(\"hermes\") | not" /etc/manythreads-bridge/team-agents.json
  jq -e ".server.agents | has(\"hermes\") | not" /etc/manythreads-bridge/config.json
  test -s /var/log/curl-urls.log
  ! grep -qi "nousresearch\|hermes" /var/log/curl-urls.log
  ! grep -qi "nousresearch\|HERMES_INSTALLER_SHA256" /tmp/bridge.sh
  ! test -e /var/lib/manythreads-bridge/hermes-install'
echo "--- per-team users (P26-22)"
H=/opt/manythreads-bridge/helper/mt-team-helper
B=/var/lib/manythreads-bridge
check "the helper is root's, in a folder only root writes" 'test "$(stat -c %U:%a '"$H"')" = root:755 && test "$(stat -c %U:%a /opt/manythreads-bridge/helper)" = root:755 && test "$(stat -c %U:%a /opt/manythreads-bridge/helper/team-helper.mjs)" = root:644 && test "$(stat -c %U:%a /etc/manythreads-bridge/team-agents.json)" = root:644'
check "work is root's, 0711: a team's folders are not the bridge user's to make"  'test "$(stat -c %U:%a '"$B"'/work)" = root:711 && ! runuser -u manythreads-bridge -- mkdir '"$B"'/work/x'
check "the sudo rule is root's 0440 and passes visudo" 'test "$(stat -c %U:%a /etc/sudoers.d/manythreads-bridge)" = root:440 && visudo -cf /etc/sudoers.d/manythreads-bridge'
check "sudo -l for the bridge user lists the two commands and nothing else" '
  out="$(sudo -l -U manythreads-bridge)"; echo "$out"
  test "$(printf %s "$out" | grep -c "^ *(")" = 1
  printf %s "$out" | grep -q "(root) NOPASSWD: '"$H"' ensure-user \*, '"$H"' run \*"
  ! printf %s "$out" | grep -q "(ALL"'
check "the bridge user gets no other program from sudo" '
  ! runuser -u manythreads-bridge -- sudo -n id
  ! runuser -u manythreads-bridge -- sudo -n -- /bin/sh -c id
  ! runuser -u manythreads-bridge -- sudo -n -- '"$H"' delete-user acme
  ! runuser -u manythreads-bridge -- sudo -n -- '"$H"'
  ! runuser -u manythreads-bridge -- sudo -n -- /usr/sbin/useradd mt-team-evil'
check "the helper refuses a bad team, a bad kind and extra words (and makes no user for them)" '
  for bad in "run Acme claude" "run a_b claude" "run ../x claude" "run acme sh" "run acme claude extra" "ensure-user a--b" "ensure-user -rf" "run acme bash -c id"; do
    ! runuser -u manythreads-bridge -- sudo -n -- '"$H"' $bad </dev/null >/dev/null 2>&1 || { echo "accepted: $bad"; exit 1; }
  done
  ! getent passwd mt-team-Acme mt-team-a_b mt-team-evil mt-team-acme >/dev/null
  test "$(getent passwd | grep -c "^mt-team-")" = 0'
check "a header that names another team folder, or a path that climbs, is refused before anything starts" '
  mk() { jq -nc --arg c "$1" "{v:1,cwd:\$c,env:{PATH:\"/usr/bin:/bin\"},files:[],removeAtEnd:[]}"; }
  for cwd in '"$B"'/work/other/x '"$B"'/work/acme/../other /root /; do
    ! mk "$cwd" | runuser -u manythreads-bridge -- sudo -n -- '"$H"' run acme claude >/dev/null 2>&1 || { echo "accepted $cwd"; exit 1; }
  done
  ! getent passwd mt-team-other >/dev/null'

# the real adapter, started through the helper by the real table, answers the protocol's first message as the team user
check "the real Claude adapter answers initialize, started as the team user through sudo" '
  out="$(printf "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}\n" | (sleep 8; cat) | timeout 40 as-team acme dev claude 2>&1 | head -c 4000)"; echo "$out" | head -c 600
  echo "$out" | grep -q "\"protocolVersion\""
  getent passwd mt-team-acme | grep -q "^mt-team-acme:"'

# from here the table names a probe that runs the lines it is given, so the checks can look at the team user from the inside
docker exec "$name" bash -c 'jq ".agents.claude.command = \"/usr/local/bin/mt-probe\" | .agents.claude.args = []" /etc/manythreads-bridge/team-agents.json > /tmp/t.json && install -m 0644 -o root -g root /tmp/t.json /etc/manythreads-bridge/team-agents.json'
check "a run is the team's own user, with that team's home and the allowed environment only" '
  out="$(echo "id -un; id -gn; echo HOME=\$HOME; echo USER=\$USER; pwd; env | sort" | MT_EXTRA_ENV="{\"LD_PRELOAD\":\"/tmp/x.so\",\"HOME\":\"/root\",\"AGENT_BRIDGE_API_KEY\":\"leak\"}" as-team acme dev 2>&1)"; echo "$out" | head -40
  echo "$out" | grep -qx mt-team-acme
  echo "$out" | grep -qx "HOME='"$B"'/work/acme"
  echo "$out" | grep -qx "'"$B"'/work/acme/dev"
  echo "$out" | grep -qx "MANYTHREADS_RUN_TOKEN=token-of-acme"
  echo "$out" | grep -q "left out of the environment"
  ! echo "$out" | grep -qE "^(LD_PRELOAD|AGENT_BRIDGE_API_KEY)=|^HOME=/root|^leak"'
check "the second team is its own user, with its own ids" '
  echo "id -un" | as-team beta dev | grep -qx mt-team-beta
  test "$(id -u mt-team-acme)" != "$(id -u mt-team-beta)"
  getent passwd mt-team-beta | grep -q ":'"$B"'/work/beta:/usr/sbin/nologin$"
  id -nG mt-team-acme | tr " " "\n" | grep -qx mt-agents && id -nG mt-team-beta | tr " " "\n" | grep -qx mt-agents'
check "a team home is the team's, group the publisher's (setgid), others none" '
  test "$(stat -c %U:%G:%a '"$B"'/work/acme)" = mt-team-acme:manythreads-publisher:2750
  test "$(stat -c %U:%G:%a '"$B"'/work/beta)" = mt-team-beta:manythreads-publisher:2750'

# team acme leaves a secret file, a deploy login and a long run with its token; team beta looks for them
docker exec "$name" bash -c 'echo "echo acme-secret > \$HOME/secret.txt; chmod 600 \$HOME/secret.txt; mkdir -p \$HOME/proj-private && echo x > \$HOME/proj-private/f" | as-team acme dev >/dev/null'
docker exec -d "$name" bash -c 'echo "sleep 90" | MT_TOKEN=token-acme-in-environ MT_FILES="[{\"path\":\"/var/lib/manythreads-bridge/work/acme/kube/dev/r1/config\",\"text\":\"acme-kubeconfig\",\"mode\":\"0600\"}]" MT_REMOVE="[\"/var/lib/manythreads-bridge/work/acme/kube/dev/r1\"]" as-team acme dev >/tmp/acme-long.log 2>&1'
sleep 3
check "the deploy login is written by the helper as the team user, 0600, while the run lasts" '
  test "$(stat -c %U:%a '"$B"'/work/acme/kube/dev/r1/config)" = mt-team-acme:600
  grep -qx acme-kubeconfig '"$B"'/work/acme/kube/dev/r1/config'
check "team beta cannot read team acme's folder, files, kubeconfig or the other run's environment" '
  pid="$(pgrep -u mt-team-acme -x sleep | head -1)"; test -n "$pid"
  out="$(printf "%s\n" "ls '"$B"'/work/acme" "cat '"$B"'/work/acme/secret.txt" "cat '"$B"'/work/acme/kube/dev/r1/config" "cat /proc/$pid/environ" "ls /proc/$pid/cwd/" "stat '"$B"'/work/acme/proj-private/f" | as-team beta dev 2>&1)"; echo "$out"
  test "$(echo "$out" | grep -c "Permission denied")" -ge 6
  ! echo "$out" | grep -q "acme-secret\|acme-kubeconfig\|token-acme-in-environ"'
check "team beta cannot become acme, or write in its home" '
  printf "%s\n" "touch '"$B"'/work/acme/x" "sudo -n true" "su acme -c id" | as-team beta dev 2>&1 | tee /tmp/b.out; ! test -e '"$B"'/work/acme/x'
check "team beta cannot read the bridge's key, state, publisher socket folder or hermes homes" '
  out="$(printf "%s\n" "cat /etc/manythreads-bridge/key" "ls '"$B"'/state" "cat '"$B"'/state/key" "ls '"$B"'/hermes" "ls '"$B"'/home" | as-team beta dev 2>&1)"; echo "$out"
  test "$(echo "$out" | grep -c "Permission denied")" -ge 5
  ! echo "$out" | grep -q "^mtb_"'
check "acme's own run still sees its folder (it is a different user, not a broken folder)" '
  echo "cat \$HOME/secret.txt; ls -d \$HOME/kube" | as-team acme dev | grep -q acme-secret'
docker exec "$name" bash -c 'pkill -u mt-team-acme -x sleep; sleep 3; true'
check "when the run ends the deploy login folder is removed (and its program group is gone)" '
  ! test -e '"$B"'/work/acme/kube/dev/r1 && ! pgrep -u mt-team-acme -x sleep'

# the shared sign-in folder: the CLIs keep their tokens there and renew them in place, whichever team's run did it
docker exec "$name" bash -c 'runuser -u manythreads-bridge -- sh -c "umask 077; echo token-v1 > '"$B"'/auth/claude/creds.json; mkdir -p '"$B"'/auth/claude/projects"'
check "both teams read and renew the one sign-in, and the files stay the group's" '
  echo "grep -qx token-v1 \$CLAUDE_CONFIG_DIR/creds.json && echo token-v2-acme > \$CLAUDE_CONFIG_DIR/creds.json && echo ok-a" | as-team acme dev | grep -qx ok-a
  echo "grep -qx token-v2-acme \$CLAUDE_CONFIG_DIR/creds.json && echo token-v3-beta >> \$CLAUDE_CONFIG_DIR/creds.json && echo ok-b" | as-team beta dev | grep -qx ok-b
  echo "umask 0077; echo made-by-beta > \$CLAUDE_CONFIG_DIR/projects/new.json; echo ok-c" | as-team beta dev | grep -qx ok-c
  echo "grep -qx made-by-beta \$CLAUDE_CONFIG_DIR/projects/new.json && echo ok-d" | as-team acme dev | grep -qx ok-d
  test "$(stat -c %G '"$B"'/auth/claude/creds.json)" = mt-agents
  test "$(stat -c %G '"$B"'/auth/claude/projects/new.json)" = mt-agents
  runuser -u manythreads-bridge -- grep -q token-v3-beta '"$B"'/auth/claude/creds.json'
check "the publisher user and users outside the group cannot read the sign-in folder" '
  ! runuser -u manythreads-publisher -- cat '"$B"'/auth/claude/creds.json
  ! runuser -u nobody -- cat '"$B"'/auth/claude/creds.json'
check "a team user cannot sudo, and the helper cannot be run by it" '
  ! runuser -u mt-team-acme -- sudo -n true
  ! runuser -u mt-team-acme -- sudo -n -- '"$H"' ensure-user zzz
  ! getent passwd mt-team-zzz >/dev/null'
check "the repository of a team is made by the team user and the publisher can read it (group), another team cannot" '
  echo "mkdir -p proj && cd proj && git init -q -b main . && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m first && git remote add origin https://github.com/acme/proj.git && echo made" | as-team acme dev | grep -qx made
  runuser -u manythreads-publisher -- git -c safe.directory="*" -C '"$B"'/work/acme/dev/proj log --oneline | grep -q first
  ! runuser -u mt-team-beta -- git -c safe.directory="*" -C '"$B"'/work/acme/dev/proj log
  ! runuser -u manythreads-publisher -- cat '"$B"'/work/acme/secret.txt'

check "the publisher serves on its socket (run by hand as its user)" '
  mkdir -p /run/manythreads-publisher && chown manythreads-publisher:manythreads-bridge /run/manythreads-publisher && chmod 750 /run/manythreads-publisher
  (runuser -u manythreads-publisher -g manythreads-bridge -- env PUBLISHER_SERVER_URL=http://127.0.0.1:'"$port"' PUBLISHER_SOCKET=/run/manythreads-publisher/publisher.sock PUBLISHER_SOCKET_MODE=660 PUBLISHER_CREDENTIAL_FROM_SITE=1 PUBLISHER_WORK=/var/lib/manythreads-bridge/work PUBLISHER_SCRIPT=/opt/manythreads-bridge/current/tools/mt-publish.sh /opt/manythreads-bridge/node/bin/node /opt/manythreads-bridge/releases/*/tools/publisher.mjs serve >/tmp/publisher.log 2>&1 &)
  sleep 2
  cat /tmp/publisher.log
  ls -l /run/manythreads-publisher/
  test "$(stat -c %a /run/manythreads-publisher/publisher.sock)" = 660
  runuser -u manythreads-bridge -- env MANYTHREADS_RUN_TOKEN=mtr_bogusbogusbogusbogusbogusbogus MT_PUBLISH_SOCKET=/run/manythreads-publisher/publisher.sock /opt/manythreads-bridge/current/tools/mt-publish check proj > /tmp/answer.txt 2>&1 || true
  cat /tmp/answer.txt
  test -s /tmp/answer.txt && ! grep -q "did not answer" /tmp/answer.txt'

echo "--- the site saw"
sed 's/^/  | /' "$work/site.log"
grep -q '^POST /api/bridge/enrol 200' "$work/site.log" && echo "ok   the enrolment call was made and accepted" || { echo "FAIL the enrolment call"; fail=$((fail + 1)); }
grep -q '^enrol agents=.*claude-code' "$work/site.log" && echo "ok   the machine reported its agents" || { echo "FAIL the agents report"; fail=$((fail + 1)); }
grep -q '^enrol agents=.*hermes' "$work/site.log" && { echo "FAIL the machine reported Hermes, which it does not have"; fail=$((fail + 1)); } || echo "ok   the machine did not report a Hermes it does not have"

echo "--- update (no code needed)"
docker exec "$name" bash -c 'bash /tmp/bridge.sh --update --no-browser --insecure-for-tests 2>&1 | tee /tmp/update-0.log' | sed 's/^/  | /' || true
check "the key survived the update"              'grep -q "^mtb_" /etc/manythreads-bridge/key'
check "the update kept the team users and rewrote the helper, table and sudo rule" 'id mt-team-acme && id mt-team-beta && test -x '"$H"' && jq -e ".agents.claude.command | test(\"claude-agent-acp\")" /etc/manythreads-bridge/team-agents.json && visudo -cf /etc/sudoers.d/manythreads-bridge && test "$(stat -c %U:%a '"$B"'/work)" = root:711'

# A stand-in Hermes: `--version` answers, `acp` runs the lines it is given (so the check can look at the team user from the inside). The same file is copied to the places below.
stub='#!/bin/sh\ncase "$1" in\n  --version) echo "hermes 0.99.0-stub"; exit 0 ;;\n  acp) while IFS= read -r l; do sh -c "$l"; done; exit 0 ;;\nesac\nexit 2\n'
put_stub() { docker exec "$name" bash -c 'mkdir -p "$(dirname "$1")" && printf "$2" > "$1" && chmod 0755 "$1"' _ "$1" "$stub"; }
update() { docker exec "$name" bash -c 'bash /tmp/bridge.sh --update --no-browser --insecure-for-tests "$@" 2>&1 | tee /tmp/update.log' _ "$@" | sed 's/^/  | /' || true; }
TABLE=/etc/manythreads-bridge/team-agents.json
CONFIG=/etc/manythreads-bridge/config.json
HELLO='runuser -u manythreads-bridge -- /opt/manythreads-bridge/node/bin/node /opt/manythreads-bridge/current/bridge.mjs --config '"$CONFIG"' --state-dir '"$B"'/state --print-hello'

echo "--- --update after Hermes was installed system-wide (/usr/local/bin)"
put_stub /usr/local/bin/hermes
update
checkx "--update finds Hermes in /usr/local/bin, records it in the table, and the bridge reports it (its runner appears)" '
  grep -q "^Hermes: found at /usr/local/bin/hermes (0.99.0-stub); its runner appears" /tmp/update.log
  jq -e ".agents.hermes.command == \"/usr/local/bin/hermes\" and .agents.hermes.args == [\"acp\"]" '"$TABLE"'
  jq -e ".server.agents | has(\"hermes\")" '"$CONFIG"'
  '"$HELLO"' | jq -e "[.agents[] | select(.agent == \"hermes-acp\" and (.version | startswith(\"0.99.0\")))] | length == 1"
  grep -q "^connected" /tmp/update.log'
checkx "the helper starts Hermes as the team user, with that team's HERMES_HOME and never a ~/.hermes" '
  out="$(echo "id -un; echo HH=\$HERMES_HOME; echo HOME=\$HOME" | MT_EXTRA_ENV="{\"HERMES_HOME\":\"'"$B"'/work/acme/hermes/dev\"}" as-team acme dev hermes 2>&1)"; echo "$out"
  echo "$out" | grep -qx mt-team-acme
  echo "$out" | grep -qx "HH='"$B"'/work/acme/hermes/dev"
  ! echo "$out" | grep -q "\.hermes"'
checkx "the check of the program left nothing behind and touched no home" '! ls -d /tmp/tmp.* 2>/dev/null | grep -q . ; ! test -e /root/.hermes && ! test -e '"$B"'/home/.hermes'

echo "--- a Hermes under /root is found but not usable (named with --hermes-bin)"
docker exec "$name" rm -f /usr/local/bin/hermes
put_stub /root/stub/hermes
update --hermes-bin /root/stub/hermes
checkx "reported in one plain sentence with the fix, left out of the table, the rest goes on" '
  grep -q "Hermes was found at /root/stub/hermes but the team users cannot use it" /tmp/update.log
  grep -q "install Hermes system-wide, for example under /opt/hermes, or pass --hermes-bin <path>" /tmp/update.log
  grep -q "^Hermes: found but not usable" /tmp/update.log
  jq -e ".agents | has(\"hermes\") | not" '"$TABLE"'
  jq -e "(.server.agents | has(\"hermes\") | not) and (.server.agents | has(\"claude\"))" '"$CONFIG"'
  '"$HELLO"' | jq -e "[.agents[].agent] | index(\"hermes-acp\") == null"
  grep -q "^connected" /tmp/update.log'

echo "--- a Hermes the team users cannot enter is found but not usable (the check runs it as them)"
put_stub /opt/private/hermes
docker exec "$name" chmod 0700 /opt/private
update --hermes-bin /opt/private/hermes
checkx "the reason is what the system said, and nothing is installed or downloaded" '
  grep -q "Hermes was found at /opt/private/hermes but the team users cannot use it (.*Permission denied" /tmp/update.log
  jq -e ".agents | has(\"hermes\") | not" '"$TABLE"''

echo "--- no option: a Hermes only under /root/.local/bin is named as not usable"
put_stub /root/.local/bin/hermes
docker exec "$name" bash -c 'rm -rf /opt/private /root/stub'
update
checkx "found where the person who runs this may have it, not usable, left out" '
  grep -q "Hermes was found at /root/.local/bin/hermes but the team users cannot use it" /tmp/update.log
  jq -e ".agents | has(\"hermes\") | not" '"$TABLE"''

echo "--- no option: Hermes in /opt/<name>/bin is found (and wins over the one under /root)"
put_stub /opt/hermes/bin/hermes
update
checkx "found in /opt/hermes/bin, recorded, no warning" '
  grep -q "^Hermes: found at /opt/hermes/bin/hermes (0.99.0-stub)" /tmp/update.log
  ! grep -q "^warning: Hermes" /tmp/update.log
  jq -e ".agents.hermes.command == \"/opt/hermes/bin/hermes\"" '"$TABLE"''

echo "--- --hermes-bin names it; a later --update with no option keeps what the table recorded"
docker exec "$name" bash -c 'mkdir -p /srv/tools/bin && cp /opt/hermes/bin/hermes /srv/tools/bin/hermes && rm -rf /opt/hermes /root/.local/bin/hermes'
update --hermes-bin /srv/tools/bin/hermes
update
checkx "the program outside the usual places is used through --hermes-bin, and still used by the next plain --update" '
  grep -q "^Hermes: found at /srv/tools/bin/hermes (0.99.0-stub)" /tmp/update.log
  jq -e ".agents.hermes.command == \"/srv/tools/bin/hermes\"" '"$TABLE"''
checkx "through all of it no program was asked for Hermes' download host or for any Hermes installer" '
  test -s /var/log/curl-urls.log
  ! grep -qi "nousresearch\|hermes" /var/log/curl-urls.log'

echo "--- uninstall --purge (a key a rotation wrote under the state folder goes too)"
docker exec "$name" bash -c 'printf "%s\n" "mtb_$(printf "%064d" 0)" >/var/lib/manythreads-bridge/state/key'
docker exec "$name" bash /tmp/bridge.sh --uninstall --purge --insecure-for-tests 2>&1 | sed 's/^/  | /' || true
check "program, config and units are gone"       '! test -e /opt/manythreads-bridge && ! test -e /etc/manythreads-bridge && ! test -e /etc/systemd/system/manythreads-bridge.service && ! test -e /etc/systemd/system/manythreads-publisher.service'
check "no key is left behind"                    '! test -e /var/lib/manythreads-bridge/state/key'
check "both users are gone"                      '! id manythreads-bridge && ! id manythreads-publisher'
check "the team users, their group, the helper and the sudo rule are gone" '! id mt-team-acme && ! id mt-team-beta && ! getent group mt-agents && ! test -e /etc/sudoers.d/manythreads-bridge && ! test -e '"$H"' && ! getent passwd | grep -q "^mt-team-"'
grep -q '^POST /api/bridge/uninstall' "$work/site.log" && echo "ok   the site was told" || echo "note the site was not told (the stub has no uninstall route)"

echo "--- $fail failed"
[ "$fail" -eq 0 ]
