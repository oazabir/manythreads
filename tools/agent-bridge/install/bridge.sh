#!/usr/bin/env bash
# manythreads agent bridge: installer for a server (PLAN P26-14, docs/plans/agents-anywhere.md §5.2).
#
#   curl -fsSL @@SITE@@/install/bridge.sh | sudo bash -s -- --enrol <one-time code>
#   curl -fsSL @@SITE@@/install/bridge.sh | sudo bash -s -- --enrol -        (asks for the code on the keyboard: it is never in shell history or in `ps`)
#
# The whole script is one function, `main`, called on the last line: a download that is cut short runs nothing.
# Read it before you run it: it installs a program and a systemd service, and creates a user.
#
# What it does: checks the machine; gets Node 22 (yours if it is 22 or later); downloads the bridge bundle from this site and checks its hash; installs the pinned agent
# programs from a lock file (npm ci, no install scripts); makes the user `manythreads-bridge`; looks for Hermes, Claude Code and Codex on this machine and reports them;
# installs Chromium for browser checks; writes the bridge's config; enrols (one call to this site, which answers a key kept in /etc/manythreads-bridge/key, mode 0600);
# starts `manythreads-bridge.service` and waits until the site says it is connected. It does not use the sign-ins of anyone on this machine: each agent has a sign-in
# folder of its own under /var/lib/manythreads-bridge/auth, and you sign in from the Runners page.
# A second service, `manythreads-publisher.service`, runs as its own user (`manythreads-publisher`) on a socket only the bridge's user can open. `mt-publish` talks to it, so a bot
# that publishes never holds the push token: the publisher asks this site for it, per publish, with the run's own token. `git` and `jq` should be installed (the repository sync needs them).
#
#   --enrol CODE|-      the one-time code from the Runners page ("-" asks for it)
#   --update            install the bundle this site serves now, keep the key (no code needed)
#   --uninstall         stop and remove the service and the program, and tell the site (--purge also removes the work folders and the user)
#   --allow-full-access this machine's half of Codex "full access" (the other half is the switch on the Runners page)
#   --no-hermes --no-claude --no-codex --no-browser --no-publisher   leave one out (without the publisher no bot on this machine can publish)
#
# The hash of this script is shown on the Runners page. It is checked against the same site, so it guards against a broken download, not against a site that was taken over.

set -euo pipefail

main() {
  # filled in by the site when it serves this file
  local SITE='@@SITE@@' BUNDLE_SHA256='@@BUNDLE_SHA256@@' BRIDGE_VERSION='@@BRIDGE_VERSION@@'
  # pinned: Node 22 for hosts that have none (hashes from https://nodejs.org/dist/v22.23.5/SHASUMS256.txt)
  local NODE_VERSION='v22.23.5' NODE_SHA256_X64='cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8' NODE_SHA256_ARM64='2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09'
  # Hermes is installed by its official installer, pinned by checksum (the same one deploy/docker/hermes.Dockerfile pins); when upstream changes it the install stops
  local HERMES_INSTALLER_SHA256='abf338605dae6dd28d101673ac6aed7995c955745db46d47676bc591a7957209'
  local PLAYWRIGHT_VERSION='1.56.1'

  local PREFIX=/opt/manythreads-bridge ETC=/etc/manythreads-bridge DATA=/var/lib/manythreads-bridge SVC_USER=manythreads-bridge UNIT=manythreads-bridge.service
  local UNIT_FILE=/etc/systemd/system/manythreads-bridge.service
  local PUB_USER=manythreads-publisher PUB_UNIT=manythreads-publisher.service PUB_UNIT_FILE=/etc/systemd/system/manythreads-publisher.service PUB_SOCKET=/run/manythreads-publisher/publisher.sock

  local mode='' code='' allow_full=0 want_hermes=1 want_claude=1 want_codex=1 want_browser=1 want_publisher=1 purge=0 insecure=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --enrol) mode=enrol; shift; [ $# -gt 0 ] || die "--enrol needs a code, or - to type it"; code="$1" ;;
      --update) mode=update ;;
      --uninstall) mode=uninstall ;;
      --purge) purge=1 ;;
      --allow-full-access) allow_full=1 ;;
      --no-hermes) want_hermes=0 ;;
      --no-claude) want_claude=0 ;;
      --no-codex) want_codex=0 ;;
      --no-browser) want_browser=0 ;;
      --no-publisher) want_publisher=0 ;;
      --insecure-for-tests) insecure=1 ;;
      -h|--help) sed -n '2,34p' "$0" 2>/dev/null || true; return 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  [ -n "$mode" ] || die "say what to do: --enrol <code>, --update or --uninstall"

  # ---- checks ----------------------------------------------------------------------------------------------------------------------------------------------
  [ "$(uname -s)" = Linux ] || die "this installer is for Linux"
  [ "$(id -u)" -eq 0 ] || die "run it as root: put sudo before bash"
  [ -d /run/systemd/system ] || die "this machine does not run systemd"
  local arch
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "this machine's processor ($(uname -m)) is not supported (x86_64 and arm64 are)" ;; esac
  local c
  for c in curl tar sha256sum gzip; do command -v "$c" >/dev/null 2>&1 || die "$c is needed and was not found"; done
  for c in git jq; do command -v "$c" >/dev/null 2>&1 || warn "$c was not found: the team's repositories and publishing need it (on Debian or Ubuntu: apt-get install git jq)"; done
  case "$SITE" in https://*) ;; http://*) [ "$insecure" -eq 1 ] || die "the site address is not https: $SITE" ;; *) die "this copy of the script has no site address; download it from the Runners page" ;; esac

  if [ "$mode" = uninstall ]; then uninstall_all "$purge"; return 0; fi

  say "manythreads bridge $BRIDGE_VERSION for $SITE"
  check_disk "$PREFIX" 3000000
  check_disk /var 3000000
  curl -fsS --max-time 20 -o /dev/null "$SITE/install/bridge.sh.sha256" || die "cannot reach $SITE (this machine must reach it on port 443)"

  if [ "$mode" = enrol ] && [ "$code" = - ]; then
    [ -r /dev/tty ] || die "no keyboard to read the code from; pass it as --enrol <code> instead"
    printf 'One-time code from the Runners page: ' >/dev/tty
    IFS= read -r -s code </dev/tty || die "no code was typed"
    printf '\n' >/dev/tty
  fi
  if [ "$mode" = enrol ]; then
    case "$code" in mte_????????????????????????????????????????) ;; *) die "that is not an enrolment code (it starts with mte_ and has 40 more characters)" ;; esac
  fi
  if [ "$mode" = update ] && [ ! -s "$ETC/key" ]; then die "there is no key in $ETC/key: this machine is not enrolled yet; run it with --enrol <code>"; fi

  # ---- Node ------------------------------------------------------------------------------------------------------------------------------------------------
  local node=''
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; then
    node="$(command -v node)"
    say "using Node $(node -v) at $node"
  else
    local want_sha tarball
    if [ "$arch" = x64 ]; then want_sha="$NODE_SHA256_X64"; else want_sha="$NODE_SHA256_ARM64"; fi
    tarball="node-$NODE_VERSION-linux-$arch.tar.xz"
    if [ ! -x "$PREFIX/node/bin/node" ]; then
      command -v xz >/dev/null 2>&1 || die "xz is needed to unpack Node (install the xz-utils package)"
      say "downloading Node $NODE_VERSION"
      mkdir -p "$PREFIX"
      local tmp
      tmp="$(mktemp -d)"
      curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tarball" -o "$tmp/$tarball"
      printf '%s  %s\n' "$want_sha" "$tmp/$tarball" | sha256sum -c - >/dev/null || die "the Node download does not match its pinned hash"
      rm -rf "$PREFIX/node.new"
      mkdir -p "$PREFIX/node.new"
      tar -xJf "$tmp/$tarball" -C "$PREFIX/node.new" --strip-components=1
      rm -rf "$PREFIX/node"
      mv "$PREFIX/node.new" "$PREFIX/node"
      rm -rf "$tmp"
    fi
    node="$PREFIX/node/bin/node"
  fi
  local npm_dir
  npm_dir="$(dirname "$node")"

  # ---- the bundle ------------------------------------------------------------------------------------------------------------------------------------------
  local release="$PREFIX/releases/$BRIDGE_VERSION" bundle="bridge-$BRIDGE_VERSION.tgz"
  if [ ! -f "$release/.complete" ]; then
    say "downloading the bridge ($bundle)"
    local work
    work="$(mktemp -d)"
    curl -fsSL "$SITE/install/$bundle" -o "$work/$bundle"
    printf '%s  %s\n' "$BUNDLE_SHA256" "$work/$bundle" | sha256sum -c - >/dev/null || die "the bridge download does not match the hash in this script; try again, and tell the person who runs the site if it keeps happening"
    rm -rf "$release"
    mkdir -p "$release"
    tar -xzf "$work/$bundle" -C "$release" --no-same-owner
    rm -rf "$work"
    say "installing the agent programs (pinned, from the lock file)"
    ( cd "$release/agents" && PATH="$npm_dir:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error ) || die "npm ci failed; the lines above say why"
    chown -R root:root "$release"
    chmod -R go-w "$release"
    touch "$release/.complete"
  fi
  # the two commands a bot runs, written at every run so they name this machine's Node (and the release's own files, never the caller's PATH or NODE_OPTIONS)
  write_shims "$release/tools" "$node"
  ln -sfn "$release" "$PREFIX/current.new"
  mv -T "$PREFIX/current.new" "$PREFIX/current"

  # ---- the user and the folders ----------------------------------------------------------------------------------------------------------------------------
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA/home" --no-create-home --shell /usr/sbin/nologin --user-group "$SVC_USER"
  fi
  if [ "$want_publisher" -eq 1 ] && ! id "$PUB_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin --user-group "$PUB_USER"
  fi
  mkdir -p "$ETC" "$DATA/state" "$DATA/auth/claude" "$DATA/auth/codex" "$DATA/hermes" "$DATA/work" "$DATA/home"
  chown -R "$SVC_USER:$SVC_USER" "$DATA"
  # what the publisher's user must not read: the sign-ins, the bridge's key and state, the Hermes homes and the deployer's login
  chmod 0700 "$DATA/auth" "$DATA/auth/claude" "$DATA/auth/codex" "$DATA/state" "$DATA/hermes"
  chmod 0755 "$ETC"

  # ---- what this machine has (reported; the bridge runs the pinned copies, never these) ---------------------------------------------------------------------
  report_host_agents "${SUDO_USER:-}"

  # ---- the agents' programs --------------------------------------------------------------------------------------------------------------------------------
  local agents="$release/agents/node_modules" archdir="$arch"
  local claude_bin='' codex_bin='' claude_acp='' codex_acp=''
  claude_acp="$agents/.bin/claude-agent-acp"
  codex_acp="$agents/.bin/codex-acp"
  codex_bin="$agents/.bin/codex"
  claude_bin="$agents/@anthropic-ai/claude-agent-sdk-linux-$archdir/claude"
  [ -x "$claude_bin" ] || { claude_bin=''; want_claude=0; warn "the Claude Code program for this processor is not in the bundle; Claude Code is left out"; }
  [ -e "$codex_bin" ] || { want_codex=0; warn "Codex is not in the bundle; it is left out"; }

  # ---- Chromium for the browser checks ---------------------------------------------------------------------------------------------------------------------
  local browsers="$PREFIX/ms-playwright"
  if [ "$want_browser" -eq 1 ]; then
    if [ ! -d "$browsers" ] || [ -z "$(ls -A "$browsers" 2>/dev/null)" ]; then
      command -v apt-get >/dev/null 2>&1 || die "the browser's system libraries are installed with apt, and this machine has none; run again with --no-browser to leave the browser out"
      say "installing Chromium $PLAYWRIGHT_VERSION and its libraries (about 600 MB)"
      PLAYWRIGHT_BROWSERS_PATH="$browsers" PATH="$npm_dir:$PATH" "$node" "$release/agents/node_modules/playwright/cli.js" install --with-deps chromium >/dev/null || die "the browser install failed; run again with --no-browser to leave it out"
      chmod -R go+rX "$browsers"
    fi
  fi

  # ---- Hermes (only when this machine has it) --------------------------------------------------------------------------------------------------------------
  local hermes_bin=''
  if [ "$want_hermes" -eq 1 ] && host_has hermes "${SUDO_USER:-}"; then
    hermes_bin="$(install_hermes "$DATA" "$SVC_USER" "$HERMES_INSTALLER_SHA256" || true)"
    [ -n "$hermes_bin" ] || warn "Hermes could not be installed here; it is left out (the rest goes on)"
  fi

  # ---- the config ------------------------------------------------------------------------------------------------------------------------------------------
  local playwright_env=''
  [ "$want_browser" -eq 1 ] && playwright_env="$browsers"
  local pub_socket=''
  [ "$want_publisher" -eq 1 ] && pub_socket="$PUB_SOCKET"
  CFG_TOOLS="$PREFIX/current/tools" CFG_PUB_SOCKET="$pub_socket" CFG_DATA="$DATA" CFG_CLAUDE_ACP="$claude_acp" CFG_CODEX_ACP="$codex_acp" CFG_CLAUDE_BIN="$claude_bin" CFG_CODEX_BIN="$codex_bin" CFG_HERMES_BIN="$hermes_bin" \
    CFG_WANT_CLAUDE="$want_claude" CFG_WANT_CODEX="$want_codex" CFG_FULL="$allow_full" CFG_BROWSERS="$playwright_env" \
    "$node" -e '
      const e = process.env;
      const root = e.CFG_DATA;
      const profiles = {};
      const agents = {};
      const shared = e.CFG_BROWSERS ? { env: { PLAYWRIGHT_BROWSERS_PATH: e.CFG_BROWSERS } } : {};
      if (e.CFG_WANT_CLAUDE === "1") {
        profiles["claude-signin"] = { agent: "claude-code", driver: "acp", workdir: root + "/work/.signin", authHome: root + "/auth/claude", acp: { command: e.CFG_CLAUDE_ACP } };
        agents.claude = { authHome: root + "/auth/claude", acp: { command: e.CFG_CLAUDE_ACP }, ...shared };
      }
      if (e.CFG_WANT_CODEX === "1") {
        profiles["codex-signin"] = { agent: "codex", driver: "acp", workdir: root + "/work/.signin", authHome: root + "/auth/codex", acp: { command: e.CFG_CODEX_ACP } };
        agents.codex = { authHome: root + "/auth/codex", acp: { command: e.CFG_CODEX_ACP }, ...(e.CFG_FULL === "1" ? { fullAccess: "allowed" } : {}), ...shared };
      }
      if (e.CFG_HERMES_BIN) {
        agents.hermes = { hermesHome: root + "/hermes", acp: { command: e.CFG_HERMES_BIN, args: ["acp"] }, ...shared };
      }
      if (Object.keys(profiles).length === 0 && !agents.hermes) { console.error("no agent is left to run"); process.exit(2); }
      if (Object.keys(profiles).length === 0) profiles["hermes-placeholder"] = { agent: "hermes-acp", driver: "acp", workdir: root + "/work/.signin", acp: { command: e.CFG_HERMES_BIN, args: ["acp"] } };
      const config = { profiles, bin: { claude: e.CFG_CLAUDE_BIN || "claude", codex: e.CFG_CODEX_BIN || "codex" }, maxConcurrentRuns: 4, mcpTokenInFile: true, server: { root, agents, toolsDir: e.CFG_TOOLS, ...(e.CFG_PUB_SOCKET ? { publisherSocket: e.CFG_PUB_SOCKET } : {}) } };
      process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    ' >"$ETC/config.json.new" || die "could not write the config"
  chmod 0644 "$ETC/config.json.new"
  mv "$ETC/config.json.new" "$ETC/config.json"

  # ---- enrol -----------------------------------------------------------------------------------------------------------------------------------------------
  local insecure_flag=''
  [ "$insecure" -eq 1 ] && insecure_flag=' --insecure-for-tests'
  if [ "$mode" = enrol ]; then
    say "enrolling this machine"
    local hello answer
    hello="$(run_as "$SVC_USER" "$node" "$release/bridge.mjs" --config "$ETC/config.json" --state-dir "$DATA/state" --print-hello)" || die "the bridge could not describe this machine"
    # the code goes in the request body (from a variable, through a pipe), never in an argument of a program that stays running
    answer="$(CODE="$code" HELLO="$hello" "$node" -e 'const h = JSON.parse(process.env.HELLO); process.stdout.write(JSON.stringify({ code: process.env.CODE, host: h.host, agents: h.agents, bridgeVersion: h.bridgeVersion, allowFullAccess: h.allowFullAccess }));' \
      | curl -sS --max-time 30 -X POST -H 'content-type: application/json' --data-binary @- -w '\n%{http_code}' "$SITE/api/bridge/enrol")" || die "could not reach the site to enrol"
    code=''
    local http body
    http="$(printf '%s' "$answer" | tail -n 1)"
    body="$(printf '%s' "$answer" | sed '$d')"
    if [ "$http" != 200 ]; then
      case "$http" in
        404) die "the site does not accept that code. It may have been used or may have expired (codes last 15 minutes): make a new one on the Runners page." ;;
        429) die "too many wrong codes from this address; wait a quarter of an hour and try again" ;;
        *) die "the site answered $http to the enrolment" ;;
      esac
    fi
    umask 077
    printf '%s' "$body" | "$node" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const k = JSON.parse(s).key; if (!/^mtb_[0-9a-f]{64}$/.test(k)) process.exit(1); process.stdout.write(k + "\n"); });' >"$ETC/key.new" || die "the site's answer held no key"
    chmod 0600 "$ETC/key.new"
    mv "$ETC/key.new" "$ETC/key"
    umask 022
    body=''
    # a key from an earlier rotation would win over this one
    rm -f "$DATA/state/key"
  fi

  # ---- the service -----------------------------------------------------------------------------------------------------------------------------------------
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=manythreads agent bridge
Documentation=$SITE
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
LoadCredential=key:$ETC/key
Environment=HOME=$DATA/home
Environment=PATH=$npm_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production
Environment=DISABLE_AUTOUPDATER=1
ExecStart=$node $PREFIX/current/bridge.mjs --config $ETC/config.json --state-dir $DATA/state --site $SITE$insecure_flag
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  if [ "$want_publisher" -eq 1 ]; then
    # The publisher: its own user, a socket in a folder only the bridge's group can enter, and no way to read the bridge's key, sign-ins or state (0700). Per publish it asks this site
    # for the push document of one project, with the run's own token, and runs the same mt-publish.sh the pods use. (It names the release folder, not `current`: Node checks its own path.)
    cat >"$PUB_UNIT_FILE" <<EOF
[Unit]
Description=manythreads publisher (pushes a bot's branch and opens the pull request)
Documentation=$SITE
After=network-online.target
Wants=network-online.target

[Service]
User=$PUB_USER
Group=$SVC_USER
RuntimeDirectory=manythreads-publisher
RuntimeDirectoryMode=0750
UMask=0007
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PUBLISHER_SERVER_URL=$SITE
Environment=PUBLISHER_SOCKET=$PUB_SOCKET
Environment=PUBLISHER_SOCKET_MODE=660
Environment=PUBLISHER_CREDENTIAL_FROM_SITE=1
Environment=PUBLISHER_WORK=$DATA/work
Environment=PUBLISHER_SCRIPT=$release/tools/mt-publish.sh
Environment=PUBLISHER_REPO_USER=$PUB_USER
ExecStart=$node $release/tools/publisher.mjs serve
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  else
    systemctl disable --now "$PUB_UNIT" >/dev/null 2>&1 || true
    rm -f "$PUB_UNIT_FILE"
  fi
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null 2>&1
  systemctl restart "$UNIT"
  if [ "$want_publisher" -eq 1 ]; then
    systemctl enable "$PUB_UNIT" >/dev/null 2>&1
    systemctl restart "$PUB_UNIT"
  fi

  say "waiting for the site to see this machine"
  local status
  for _ in $(seq 1 45); do
    status="$(key_status "$ETC/key" "$SITE")"
    if [ "$status" = connected ]; then
      say "connected. Sign each agent in from the Runners page: $SITE/ (Settings, Runners)"
      return 0
    fi
    sleep 2
  done
  warn "the site has not seen this machine yet. Look at: journalctl -u $UNIT -n 50"
  return 1
}

# ---- helpers -------------------------------------------------------------------------------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

check_disk() {
  local dir="$1" need_kb="$2" probe="$1" avail
  while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
  avail="$(df -Pk "$probe" | awk 'NR==2 {print $4}')"
  [ "${avail:-0}" -ge "$need_kb" ] || die "less than 3 GB free on $dir"
}

# run a program as another user without sudo being installed
run_as() {
  local user="$1"; shift
  if command -v runuser >/dev/null 2>&1; then runuser -u "$user" -- "$@"; else su -s /bin/sh "$user" -c "$(printf '%q ' "$@")"; fi
}

# `mt-git` and `mt-publish`, the two commands a bot runs: small scripts that name this machine's Node and the release's own files
write_shims() {
  local dir="$1" node="$2"
  [ -d "$dir" ] || die "the bundle has no tools folder"
  printf '#!/bin/sh\nexec env -u NODE_OPTIONS -u NODE_PATH %q %q "$@"\n' "$node" "$dir/mt-git.mjs" >"$dir/mt-git"
  printf '#!/bin/sh\nexec env -u NODE_OPTIONS -u NODE_PATH %q %q client "$@"\n' "$node" "$dir/publisher.mjs" >"$dir/mt-publish"
  chmod 0755 "$dir/mt-git" "$dir/mt-publish" "$dir/mt-publish.sh" "$dir/mt-askpass.sh" "$dir/repo-sync.sh"
}

# is a program on the PATH of root or of the person who ran sudo?
host_has() {
  local prog="$1" who="${2:-}"
  command -v "$prog" >/dev/null 2>&1 && return 0
  [ -n "$who" ] && [ "$who" != root ] && run_as "$who" sh -lc "command -v $prog" >/dev/null 2>&1 && return 0
  [ -x /root/.local/bin/"$prog" ] && return 0
  return 1
}

report_host_agents() {
  local who="${1:-}" p found=''
  for p in claude codex hermes; do
    if host_has "$p" "$who"; then found="$found $p"; fi
  done
  if [ -n "$found" ]; then say "found on this machine:$found (the bridge runs its own pinned copies with sign-in folders of their own; your logins are not touched)"; else say "none of claude, codex or hermes is on this machine's PATH; the pinned copies are installed anyway"; fi
}

# Hermes by its official installer, as the bridge's user, in its own home. Prints the program's path, or nothing.
install_hermes() {
  local user="$2" sha="$3" home="$1/hermes-install" tmp
  mkdir -p "$home"
  chown "$user:$user" "$home"
  tmp="$(mktemp)"
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o "$tmp" || return 1
  printf '%s  %s\n' "$sha" "$tmp" | sha256sum -c - >/dev/null || { warn "the Hermes installer is not the one this script was checked with"; rm -f "$tmp"; return 1; }
  chmod 0644 "$tmp"
  run_as "$user" env HOME="$home" HERMES_HOME="$home/.hermes" bash "$tmp" --skip-browser --skip-computer-use >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  local bin
  bin="$(find "$home" -maxdepth 4 -name hermes -type f -perm -u+x 2>/dev/null | head -1)"
  [ -n "$bin" ] || bin="$(find "$home" -maxdepth 4 -name hermes -type l 2>/dev/null | head -1)"
  printf '%s' "$bin"
}

# "connected" or something else; the key goes in a header read from a file, not from the command line
key_status() {
  local keyfile="$1" site="$2" out
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' <"$keyfile")" | curl -sS --max-time 15 --config - "$site/api/bridge/status" 2>/dev/null || true)"
  case "$out" in *'"status":"connected"'*) printf connected ;; *) printf other ;; esac
}

uninstall_all() {
  local purge="$1" PREFIX=/opt/manythreads-bridge ETC=/etc/manythreads-bridge DATA=/var/lib/manythreads-bridge
  local site='@@SITE@@' key_file=/etc/manythreads-bridge/key
  if [ -s "$key_file" ]; then
    say "telling the site this server is going away"
    printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' <"$key_file")" | curl -sS --max-time 20 --config - -X POST "$site/api/bridge/uninstall" >/dev/null 2>&1 \
      || warn "the site could not be told; remove the server on the Runners page"
  fi
  systemctl disable --now manythreads-bridge.service manythreads-publisher.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/manythreads-bridge.service /etc/systemd/system/manythreads-publisher.service
  systemctl daemon-reload || true
  rm -rf "$PREFIX" "$ETC"
  if [ "$purge" -eq 1 ]; then
    rm -rf "$DATA"
    userdel manythreads-bridge >/dev/null 2>&1 || true
    userdel manythreads-publisher >/dev/null 2>&1 || true
    say "removed the bridge, its services, its users and its work folders"
  else
    say "removed the bridge and its service; $DATA/work is kept (run with --uninstall --purge to remove it too)"
  fi
}

main "$@"
