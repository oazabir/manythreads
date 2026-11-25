#!/usr/bin/env bash
# manythreads agent bridge: installer for a server (PLAN P26-14, docs/plans/agents-anywhere.md §5.2).
#
#   curl -fsSL @@SITE@@/install/bridge.sh | sudo bash -s -- --enrol <one-time code>
#   curl -fsSL @@SITE@@/install/bridge.sh | sudo bash -s -- --enrol -        (asks for the code on the keyboard: it is never in shell history or in `ps`)
#   ... --enrol - --ca-sha256 <64 hex digits>   for a site that made its own certificate (self-signed mode): the command on the Add-a-server page carries the hash; the
#                                                script refuses any other certificate and the bridge then trusts that one certificate only
#
# The whole script is one function, `main`, called on the last line: a download that is cut short runs nothing.
# Read it before you run it: it installs a program and a systemd service, and creates a user.
#
# What it does: checks the machine; gets Node 22 (yours if it is 22 or later); downloads the bridge bundle from this site and checks its hash; installs the pinned agent
# programs from a lock file (npm ci, no install scripts); makes the user `manythreads-bridge`; reports the Claude Code and Codex the machine already has (the pinned copies are
# used); looks for Hermes and uses it only when the team users can run it (it never installs Hermes: owner decision 2026-11-16); installs Chromium for browser checks; writes the bridge's config; enrols (one call to this site, which answers a key kept in /etc/manythreads-bridge/key, mode 0600);
# starts `manythreads-bridge.service` and waits until the site says it is connected. It does not use the sign-ins of anyone on this machine: each agent has a sign-in
# folder of its own under /var/lib/manythreads-bridge/auth, and you sign in from the Runners page.
# A second service, `manythreads-publisher.service`, runs as its own user (`manythreads-publisher`) on a socket only the bridge's user can open. `mt-publish` talks to it, so a bot
# that publishes never holds the push token: the publisher asks this site for it, per publish, with the run's own token. `git` and `jq` should be installed (the repository sync needs them).
# One Unix user per team (P26-22): every team's runs are started as `mt-team-<team>`, never as the bridge's user, so teams that share this machine (and one agent sign-in) cannot read each
# other's folders, repositories, deploy logins or tokens. The installer adds, as root: a helper (`/opt/manythreads-bridge/helper/mt-team-helper`, root's, 0755) that makes those users and
# starts the fixed programs as them, a sudoers rule (`/etc/sudoers.d/manythreads-bridge`, checked with `visudo -cf`) that lets the bridge's user run that helper with two commands and
# nothing else, and the group `mt-agents` that shares Claude's sign-in folder. Codex's sign-in folder is the bridge user's alone: the helper gives each team's Codex run a copy in the
# team's own Codex home (P31-01). `sudo`, `setpriv`, `flock` and `useradd` must be on the machine.
#
#   --enrol CODE|-      the one-time code from the Runners page ("-" asks for it on the keyboard: a code on the command line is in `ps` for the length of the run)
#   --code-file PATH    the one-time code is the first line of this file (delete it afterwards; it is single use and lasts 15 minutes)
#   --update            install the bundle this site serves now, keep the key (no code needed)
#   --uninstall         stop and remove the service, the program, the helper and the sudo rule, and tell the site (--purge also removes the work folders, the team users, the users of the bridge
#                       and a refusal of full access; without --purge /etc/manythreads-bridge/no-full-access is kept)
#   --no-full-access    refuse "full access" on this machine (Claude Code and Codex run commands without asking; P35-01). Allowed by default: it is this machine's half, the
#                       other half is the runner's switch on the Runners page. The refusal is remembered in /etc/manythreads-bridge/no-full-access, so an --update keeps it; delete
#                       that file and run --update to allow it again; a plain --uninstall keeps it. (--allow-full-access, the old opt-in, is accepted and ignored.)
#   --hermes-bin PATH   the Hermes program to use, when it is not on root's PATH or in /usr/local/bin, /usr/bin or /opt/*/bin. This script never installs Hermes: install it
#                       system-wide first (for example under /opt/hermes). It is used only if the team users can run it (not under /root or /home, which the service cannot see)
#   --codex-model NAME  the model every Codex run on this machine uses (default gpt-6.2-sol, owner 2026-11-20, P35-11); an empty NAME leaves it to Codex's own default
#   --codex-effort LEVEL  the reasoning effort of every Codex run: low (the default, "light"), medium, high, xhigh or max; it wins over a bot's own effort; empty leaves it to the bot.
#                       Like the other options, give them again on every --update (the config is written from this run's options)
#   --run-memory SIZE   the most memory one run may use (default 4G, the most a run pod may have; it can only be lowered, to 256M at the least). With systemd 253 or later each run
#                       is started in a scope of its own (mtruns.slice) with that limit: a command that needs more is stopped by the kernel and the run goes on (P31-04)
#   --runs-memory SIZE  the most memory all runs together may use (the slice mtruns.slice; default 40 % of this machine's memory, can only be lowered). SIZE: 3G, 2048M or bytes
#   --no-hermes --no-claude --no-codex --no-browser --no-publisher   leave one out (without the publisher no bot on this machine can publish)
#
# The hash of this script is shown on the Runners page. It is checked against the same site, so it guards against a broken download, not against a site that was taken over.

set -euo pipefail

main() {
  # filled in by the site when it serves this file
  local SITE='@@SITE@@' BUNDLE_SHA256='@@BUNDLE_SHA256@@' BRIDGE_VERSION='@@BRIDGE_VERSION@@'
  # pinned: Node 22 for hosts that have none (hashes from https://nodejs.org/dist/v22.23.5/SHASUMS256.txt)
  local NODE_VERSION='v22.23.5' NODE_SHA256_X64='cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8' NODE_SHA256_ARM64='2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09'
  local PLAYWRIGHT_VERSION='1.56.1'

  local PREFIX=/opt/manythreads-bridge ETC=/etc/manythreads-bridge DATA=/var/lib/manythreads-bridge SVC_USER=manythreads-bridge UNIT=manythreads-bridge.service
  local UNIT_FILE=/etc/systemd/system/manythreads-bridge.service RUNS_SLICE_FILE=/etc/systemd/system/mtruns.slice
  local HELPER_DIR="$PREFIX/helper" HELPER="$PREFIX/helper/mt-team-helper" SUDOERS=/etc/sudoers.d/manythreads-bridge AGENTS_GROUP=mt-agents TEAM_TABLE="$ETC/team-agents.json"
  local PUB_USER=manythreads-publisher PUB_UNIT=manythreads-publisher.service PUB_UNIT_FILE=/etc/systemd/system/manythreads-publisher.service PUB_SOCKET=/run/manythreads-publisher/publisher.sock PUBLISH_GROUP=mt-publish

  local mode='' code='' code_file='' allow_full=1 no_full=0 old_full_flag=0 hermes_arg='' want_hermes=1 want_claude=1 want_codex=1 want_browser=1 want_publisher=1 purge=0 insecure=0 ca_sha='' codex_model='gpt-6.2-sol' codex_effort='low' run_memory='' runs_memory=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --enrol) mode=enrol; shift; [ $# -gt 0 ] || die "--enrol needs a code, or - to type it"; code="$1" ;;
      --code-file) mode=enrol; shift; [ $# -gt 0 ] || die "--code-file needs a path"; code_file="$1" ;;
      --update) mode=update ;;
      --uninstall) mode=uninstall ;;
      --purge) purge=1 ;;
      --no-full-access) no_full=1 ;;
      --allow-full-access) old_full_flag=1 ;;
      --hermes-bin) shift; [ $# -gt 0 ] || die "--hermes-bin needs the path of the hermes program"; hermes_arg="$1" ;;
      --codex-model) shift; [ $# -gt 0 ] || die "--codex-model needs a model name (or '' for Codex's own default)"; codex_model="$1" ;;
      --codex-effort) shift; [ $# -gt 0 ] || die "--codex-effort needs low, medium, high, xhigh or max (or '' to leave it to the bot)"; codex_effort="$1" ;;
      --run-memory) shift; [ $# -gt 0 ] || die "--run-memory needs a size (for example 3G)"; run_memory="$1" ;;
      --runs-memory) shift; [ $# -gt 0 ] || die "--runs-memory needs a size (for example 6G)"; runs_memory="$1" ;;
      --no-hermes) want_hermes=0 ;;
      --no-claude) want_claude=0 ;;
      --no-codex) want_codex=0 ;;
      --no-browser) want_browser=0 ;;
      --no-publisher) want_publisher=0 ;;
      --ca-sha256) shift; [ $# -gt 0 ] || die "--ca-sha256 needs the 64 hex digits of the site's certificate"; ca_sha="$1" ;;
      --insecure-for-tests) insecure=1 ;;
      -h|--help) sed -n '2,/^$/p' "$0" 2>/dev/null || true; return 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  [ -n "$mode" ] || die "say what to do: --enrol <code>, --update or --uninstall"
  case "$codex_model" in '') ;; *[!A-Za-z0-9._:-]*) die "--codex-model: letters, digits and . _ : - only" ;; esac
  [ "${#codex_model}" -le 64 ] || die "--codex-model: at most 64 characters"
  case "$codex_effort" in ''|low|medium|high|xhigh|max) ;; *) die "--codex-effort must be low, medium, high, xhigh or max" ;; esac
  # the memory of one run and of all runs (P31-04): a limit may only be lowered, never raised above the most a run pod may have (4 GiB)
  local run_mem_bytes=4294967296 runs_mem_bytes='' b
  if [ -n "$run_memory" ]; then
    b="$(size_bytes "$run_memory")" || die "--run-memory: a size like 3G, 2048M or a number of bytes"
    [ "$b" -le 4294967296 ] || die "--run-memory can only lower the limit of a run (at most 4G)"
    [ "$b" -ge 268435456 ] || die "--run-memory: at least 256M"
    run_mem_bytes="$b"
  fi
  if [ -n "$runs_memory" ]; then
    runs_mem_bytes="$(size_bytes "$runs_memory")" || die "--runs-memory: a size like 6G, 4096M or a number of bytes"
    [ "$runs_mem_bytes" -ge 268435456 ] || die "--runs-memory: at least 256M"
  fi
  # the key and the code go to this address: plain http only for the tests (checked first, before anything else on the machine is looked at)
  case "$SITE" in https://*) ;; http://*) [ "$insecure" -eq 1 ] || die "the site address is not https: $SITE (the key and the code would travel in the clear)" ;; *) die "this copy of the script has no site address; download it from the Runners page" ;; esac

  # ---- checks ----------------------------------------------------------------------------------------------------------------------------------------------
  [ "$(uname -s)" = Linux ] || die "this installer is for Linux"
  [ "$(id -u)" -eq 0 ] || die "run it as root: put sudo before bash"
  [ -d /run/systemd/system ] || die "this machine does not run systemd"
  local arch
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "this machine's processor ($(uname -m)) is not supported (x86_64 and arm64 are)" ;; esac
  local c
  for c in curl tar sha256sum gzip; do command -v "$c" >/dev/null 2>&1 || die "$c is needed and was not found"; done
  # the per-team users (P26-22): sudo and its checker, setpriv (util-linux) and the account tools
  if [ "$mode" != uninstall ]; then for c in sudo visudo setpriv flock timeout useradd usermod groupadd getent env; do command -v "$c" >/dev/null 2>&1 || die "$c is needed for the per-team users and was not found (on Debian or Ubuntu: apt-get install sudo util-linux passwd)"; done; fi
  if [ "$mode" != uninstall ] && ! grep -Eq '^[#@]includedir[[:space:]]+/etc/sudoers\.d' /etc/sudoers 2>/dev/null; then die "/etc/sudoers does not read /etc/sudoers.d, where the rule for the bridge goes; add the line '@includedir /etc/sudoers.d' with visudo and run this again"; fi
  for c in git jq; do command -v "$c" >/dev/null 2>&1 || warn "$c was not found: the team's repositories and publishing need it (on Debian or Ubuntu: apt-get install git jq)"; done

  if [ "$mode" = uninstall ]; then uninstall_all "$purge"; return 0; fi

  say "manythreads bridge $BRIDGE_VERSION for $SITE"
  check_disk "$PREFIX" 3000000
  check_disk /var 3000000
  if [ -n "$ca_sha" ]; then pin_site_certificate "$SITE" "$ca_sha" "$ETC/site-ca.pem"; fi
  site_curl -fsS --max-time 20 -o /dev/null "$SITE/install/bridge.sh.sha256" || die "cannot reach $SITE (this machine must reach it on port 443)"

  if [ "$mode" = enrol ] && [ -n "$code_file" ]; then
    [ -z "$code" ] || die "give the code once: --enrol or --code-file, not both"
    [ -r "$code_file" ] || die "cannot read $code_file"
    code="$(head -n 1 "$code_file" | tr -d '[:space:]')"
  elif [ "$mode" = enrol ] && [ "$code" != - ]; then
    warn "the code is on the command line, where other users of this machine can see it with ps until the script ends; next time use --enrol - or --code-file"
  fi
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
    node="$(pinned_node "$arch" "$PREFIX" "$NODE_VERSION" "$NODE_SHA256_X64" "$NODE_SHA256_ARM64")"
  fi
  local npm_dir
  npm_dir="$(dirname "$node")"

  # ---- the bundle ------------------------------------------------------------------------------------------------------------------------------------------
  local release="$PREFIX/releases/$BRIDGE_VERSION" bundle="bridge-$BRIDGE_VERSION.tgz"
  if [ ! -f "$release/.complete" ]; then
    say "downloading the bridge ($bundle)"
    local work
    work="$(mktemp -d)"
    site_curl -fsSL "$SITE/install/$bundle" -o "$work/$bundle"
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
  local previous
  previous="$(readlink -f "$PREFIX/current" 2>/dev/null || true)"
  ln -sfn "$release" "$PREFIX/current.new"
  mv -T "$PREFIX/current.new" "$PREFIX/current"
  # only this release and the one before it are kept (the service may still run the one before until it restarts): every update left 1.2 GB behind and an
  # enrolled server's disk filled with them (2026-11-25, 5 releases, 6 GB)
  local old
  for old in "$PREFIX"/releases/*; do
    [ -d "$old" ] || continue
    case "$(readlink -f "$old")" in "$(readlink -f "$release")" | "$previous") continue ;; esac
    rm -rf -- "${old:?}"
  done

  # ---- the users, the group and the folders ------------------------------------------------------------------------------------------------------------------
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA/home" --no-create-home --shell /usr/sbin/nologin --user-group "$SVC_USER"
  fi
  if [ "$want_publisher" -eq 1 ] && ! id "$PUB_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin --user-group "$PUB_USER"
  fi
  # the group that shares Claude's sign-in folder: the bridge's user and every team user are in it, and nobody else
  getent group "$AGENTS_GROUP" >/dev/null 2>&1 || groupadd --system "$AGENTS_GROUP"
  # the group that may open the publisher's socket: the publisher runs with it as its group and every team user is in it (the helper adds a new team's user), nobody else.
  # Without it a team user cannot reach the socket and no bot of an enrolled server can publish (P26-19 proof 4). The users that exist already are added here.
  if [ "$want_publisher" -eq 1 ]; then
    getent group "$PUBLISH_GROUP" >/dev/null 2>&1 || groupadd --system "$PUBLISH_GROUP"
    local tu
    for tu in $(getent passwd | awk -F: -v root="$DATA/work/" 'index($1, "mt-team-") == 1 && index($6, root) == 1 { print $1 }'); do
      id -nG "$tu" | tr ' ' '\n' | grep -qx "$PUBLISH_GROUP" || usermod -a -G "$PUBLISH_GROUP" "$tu"
    done
  fi
  id -nG "$SVC_USER" | tr ' ' '\n' | grep -qx "$AGENTS_GROUP" || usermod -a -G "$AGENTS_GROUP" "$SVC_USER"
  mkdir -p "$ETC" "$DATA/state" "$DATA/auth/claude" "$DATA/auth/codex" "$DATA/hermes" "$DATA/home" "$DATA/signin"
  # Before the per-team users the bridge's own user owned `work`; a team's folders there are the team user's now, and the folder is root's so that no link in it can be planted by the
  # bridge's user. What was there is kept beside it (its repositories are cloned again by the sync) and is the admin's to delete.
  if [ -d "$DATA/work" ] && [ ! -L "$DATA/work" ] && [ "$(stat -c %u "$DATA/work")" != 0 ]; then
    rm -rf "$DATA/work-before-teams"
    mv "$DATA/work" "$DATA/work-before-teams"
    say "the work folders of before the per-team users are kept in $DATA/work-before-teams (delete them when you do not need them)"
  fi
  mkdir -p "$DATA/work"
  chown root:root "$DATA" "$DATA/work"
  chmod 0755 "$DATA"
  chmod 0711 "$DATA/work"
  local d
  for d in state hermes home signin work-before-teams; do [ -d "$DATA/$d" ] && chown -hR "$SVC_USER:$SVC_USER" "$DATA/$d"; done
  # what the publisher's user must not read: the bridge's key and state, the Hermes homes and the deployer's login (0700). Claude's sign-in folder is the bridge's, group `mt-agents`:
  # the group may enter `auth` (root's) and use it, setgid so a file made in it by any team's user belongs to the group; Claude renews its tokens in place there.
  chmod 0700 "$DATA/state" "$DATA/hermes" "$DATA/home"
  chown "root:$AGENTS_GROUP" "$DATA/auth"
  chmod 0750 "$DATA/auth"
  chown -hR "$SVC_USER:$AGENTS_GROUP" "$DATA/auth/claude"
  find "$DATA/auth/claude" -xdev -type f -links 1 -exec chmod g+rw {} +
  find "$DATA/auth/claude" -xdev -type d -exec chmod 2770 {} +
  # Codex's sign-in folder (the "main copy") is the bridge user's alone, 0700, no group (P31-01): each team's Codex runs with a Codex home of its own (<root>/work/<team>/.codex) and the
  # helper copies the sign-in in for a run and a renewed one back. Codex chmods files it did not make, so a shared folder cannot work (MISTAKES P26-19 proof 5), and a shared one also
  # showed every team every other team's Codex sessions.
  move_codex_main_copy "$DATA" "$SVC_USER" "$UNIT"
  # (the folder `auth` itself is root's, so the bridge's user cannot swap a sign-in folder for a link that the helper, as root, would follow)
  chmod 0755 "$ETC"

  # ---- what this machine has (reported; the bridge runs the pinned Claude Code and Codex, never these) -----------------------------------------------------------
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

  # ---- Hermes: found on this machine, never installed here -------------------------------------------------------------------------------------------------
  # Hermes is the admin's to install (owner decision 2026-11-16). It is used only if the team users (group `mt-agents`) can run it; the table below records its path and the helper starts it
  # per team with that team's own HERMES_HOME (under the team's home, never anyone's ~/.hermes).
  local hermes_bin='' hermes_line='' hermes_warn=''
  if [ "$want_hermes" -eq 1 ]; then
    find_hermes "${SUDO_USER:-}" "$hermes_arg" "$TEAM_TABLE" "$AGENTS_GROUP" "$node"
    hermes_bin="$HERMES_FOUND_BIN"
    hermes_line="$HERMES_FOUND_LINE"
    hermes_warn="$HERMES_FOUND_WARN"
  else
    hermes_line="Hermes: left out (--no-hermes)"
  fi
  [ -z "$hermes_warn" ] || warn "$hermes_warn"
  say "$hermes_line"
  [ ! -d "$DATA/hermes-install" ] || say "note: $DATA/hermes-install is a Hermes an older version of this script installed; it is not used any more (delete it, and install Hermes system-wide)"

  local agents_line
  agents_line="Claude Code ($([ "$want_claude" -eq 1 ] && echo 'installed by this script' || echo 'left out')), Codex ($([ "$want_codex" -eq 1 ] && echo 'installed by this script' || echo 'left out')), $hermes_line"

  # ---- the helper for the per-team users and the rule that lets the bridge's user run it -----------------------------------------------------------------------
  # root's copy of the helper, from the bundle whose hash was checked above, in a folder only root can change; it is run by sudo as root, so the Node that runs it must be root's too
  local helper_node="$node"
  if ! root_safe_path "$helper_node"; then
    say "the Node at $helper_node can be changed by someone other than root: the helper uses its own pinned copy"
    helper_node="$(pinned_node "$arch" "$PREFIX" "$NODE_VERSION" "$NODE_SHA256_X64" "$NODE_SHA256_ARM64")"
  fi
  [ -f "$release/helper/team-helper.mjs" ] || die "the bundle has no helper"
  install -d -m 0755 -o root -g root "$HELPER_DIR"
  install -m 0644 -o root -g root "$release/helper/team-helper.mjs" "$HELPER_DIR/team-helper.mjs"
  printf '#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin %q %q "$@"\n' "$helper_node" "$HELPER_DIR/team-helper.mjs" >"$HELPER.new"
  chown root:root "$HELPER.new"
  chmod 0755 "$HELPER.new"
  mv -f "$HELPER.new" "$HELPER"
  # a scope per run (P31-04): only where systemd-run is and systemd is 253 or later (a scope takes OOMPolicy= only from 253 on; Debian 12 has 252, Ubuntu 22.04 249). The slice
  # mtruns.slice holds every run's scope; its MemoryMax (40 % of this machine, or --runs-memory if lower) keeps all runs together from taking the live site's memory.
  local scope_run='' sd_version mem_kb slice_max
  sd_version="$(systemctl --version 2>/dev/null | awk 'NR==1 { print $2 }' | tr -cd '0-9')"
  if command -v systemd-run >/dev/null 2>&1 && [ -n "$sd_version" ] && [ "$sd_version" -ge 253 ]; then
    scope_run="$(command -v systemd-run)"
    mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
    slice_max=$((mem_kb * 1024 * 40 / 100))
    if [ -n "$runs_mem_bytes" ]; then
      [ "$runs_mem_bytes" -le "$slice_max" ] || die "--runs-memory can only lower the share of all runs (at most $((slice_max / 1048576))M on this machine)"
      slice_max="$runs_mem_bytes"
    fi
    cat >"$RUNS_SLICE_FILE" <<EOF
[Unit]
Description=manythreads bot runs (one scope per run, each with its own memory limit)

[Slice]
MemoryAccounting=yes
MemoryMax=$slice_max
MemorySwapMax=0
EOF
    say "memory: each run may use $((run_mem_bytes / 1048576)) MiB and all runs together $((slice_max / 1048576)) MiB; a command that needs more is stopped and the run goes on"
  else
    rm -f "$RUNS_SLICE_FILE"
    say "memory: no scope per run here (it needs systemd-run and systemd 253 or later); a command that runs out of memory is still the first the kernel stops"
  fi
  # the table of programs the helper may start: it names a kind (claude, codex, hermes), never a program, so the table is the only place a path is. Codex's own program (`cli`) is
  # there for a team's own sign-in with an API key and its sign-out (P35-10b); Claude's sign-in program is its adapter's own (`--cli auth login`)
  CFG_DATA="$DATA" CFG_CLAUDE_ACP="$([ "$want_claude" -eq 1 ] && printf %s "$claude_acp")" CFG_CODEX_ACP="$([ "$want_codex" -eq 1 ] && printf %s "$codex_acp")" CFG_CODEX_CLI="$([ "$want_codex" -eq 1 ] && printf %s "$codex_bin")" CFG_HERMES_BIN="$hermes_bin" \
    CFG_SCOPE_RUN="$scope_run" CFG_SCOPE_BYTES="$run_mem_bytes" CFG_SCOPE_UNIT="$UNIT" \
    CFG_SYNC="$PREFIX/current/tools/repo-sync.sh" CFG_BRIDGE_USER="$SVC_USER" CFG_PUBLISHER="$([ "$want_publisher" -eq 1 ] && printf %s "$PUB_USER")" CFG_PUBLISH_GROUP="$PUBLISH_GROUP" \
    "$node" -e '
      const e = process.env;
      const agents = {};
      if (e.CFG_CLAUDE_ACP) agents.claude = { command: e.CFG_CLAUDE_ACP };
      if (e.CFG_CODEX_ACP) agents.codex = { command: e.CFG_CODEX_ACP, ...(e.CFG_CODEX_CLI ? { cli: e.CFG_CODEX_CLI } : {}) };
      if (e.CFG_HERMES_BIN) agents.hermes = { command: e.CFG_HERMES_BIN, args: ["acp"] };
      const runScope = e.CFG_SCOPE_RUN ? { runScope: { systemdRun: e.CFG_SCOPE_RUN, memoryMaxBytes: Number(e.CFG_SCOPE_BYTES), bindsTo: e.CFG_SCOPE_UNIT } } : {};
      const table = { dataRoot: e.CFG_DATA, agents, syncScript: e.CFG_SYNC, bridgeUser: e.CFG_BRIDGE_USER, ...(e.CFG_PUBLISHER ? { publisherGroup: e.CFG_PUBLISHER, publishClientsGroup: e.CFG_PUBLISH_GROUP } : {}), ...runScope };
      process.stdout.write(JSON.stringify(table, null, 2) + "\n");
    ' >"$TEAM_TABLE.new" || die "could not write the helper's table"
  chown root:root "$TEAM_TABLE.new"
  chmod 0644 "$TEAM_TABLE.new"
  mv -f "$TEAM_TABLE.new" "$TEAM_TABLE"
  # the sudo rule: the bridge's user may run the helper with two commands, as root, with no password; everything else about the words is checked by the helper itself. Written to a new
  # file and checked with visudo before it is put in place: a broken sudoers file would lock everyone out of sudo.
  cat >"$SUDOERS.new" <<EOF
# manythreads agent bridge (written by bridge.sh at every install and update; do not edit).
# The bridge's user may run the team helper, as root, with these two commands and nothing else. The helper checks the rest of the words itself.
Defaults:$SVC_USER !requiretty, !use_pty, !lecture
Cmnd_Alias MT_TEAM_HELPER = $HELPER ensure-user *, $HELPER run *
$SVC_USER ALL=(root) NOPASSWD: MT_TEAM_HELPER
EOF
  chown root:root "$SUDOERS.new"
  chmod 0440 "$SUDOERS.new"
  if ! visudo -cf "$SUDOERS.new" >/dev/null 2>&1; then
    rm -f "$SUDOERS.new"
    die "the sudo rule for the bridge did not pass visudo, so it was not installed (nothing else was changed in sudo)"
  fi
  mv -f "$SUDOERS.new" "$SUDOERS"

  # ---- the config ------------------------------------------------------------------------------------------------------------------------------------------
  # Full access (P35-01): allowed unless refused, now or at an earlier install (the refusal is a file, so an --update never widens a machine that said no).
  if [ "$old_full_flag" -eq 1 ]; then say "note: --allow-full-access is no longer needed: full access is allowed by default (refuse it with --no-full-access). The flag was ignored."; fi
  if [ "$no_full" -eq 1 ]; then
    printf 'full access refused by bridge.sh --no-full-access\n' >"$ETC/no-full-access"
    chmod 0644 "$ETC/no-full-access"
  fi
  if [ -e "$ETC/no-full-access" ]; then
    allow_full=0
    say "note: full access is refused on this machine ($ETC/no-full-access; delete it and run --update to allow it)"
  fi
  # an update that widens the machine says so: a server installed before 2026-11-20 without the old opt-in was refused by the old default only
  if [ "$mode" = update ] && [ "$allow_full" -eq 1 ] && [ -f "$ETC/config.json" ] && ! grep -q '"fullAccess": "allowed"' "$ETC/config.json"; then
    say "Full access for Claude Code and Codex is now allowed on this machine (the default since 2026-11-20); rerun with --no-full-access to refuse it."
  fi
  local playwright_env=''
  [ "$want_browser" -eq 1 ] && playwright_env="$browsers"
  local pub_socket=''
  [ "$want_publisher" -eq 1 ] && pub_socket="$PUB_SOCKET"
  CFG_HELPER="$HELPER" CFG_TOOLS="$PREFIX/current/tools" CFG_PUB_SOCKET="$pub_socket" CFG_DATA="$DATA" CFG_CLAUDE_ACP="$claude_acp" CFG_CODEX_ACP="$codex_acp" CFG_CLAUDE_BIN="$claude_bin" CFG_CODEX_BIN="$codex_bin" CFG_HERMES_BIN="$hermes_bin" \
    CFG_WANT_CLAUDE="$want_claude" CFG_WANT_CODEX="$want_codex" CFG_FULL="$allow_full" CFG_BROWSERS="$playwright_env" CFG_CODEX_MODEL="$codex_model" CFG_CODEX_EFFORT="$codex_effort" \
    "$node" -e '
      const e = process.env;
      const root = e.CFG_DATA;
      const profiles = {};
      const agents = {};
      const shared = e.CFG_BROWSERS ? { env: { PLAYWRIGHT_BROWSERS_PATH: e.CFG_BROWSERS } } : {};
      if (e.CFG_WANT_CLAUDE === "1") {
        profiles["claude-signin"] = { agent: "claude-code", driver: "acp", workdir: root + "/signin", authHome: root + "/auth/claude", acp: { command: e.CFG_CLAUDE_ACP } };
        agents.claude = { authHome: root + "/auth/claude", acp: { command: e.CFG_CLAUDE_ACP }, ...(e.CFG_FULL === "1" ? { fullAccess: "allowed" } : {}), ...shared };
      }
      if (e.CFG_WANT_CODEX === "1") {
        profiles["codex-signin"] = { agent: "codex", driver: "acp", workdir: root + "/signin", authHome: root + "/auth/codex", acp: { command: e.CFG_CODEX_ACP } };
        agents.codex = { authHome: root + "/auth/codex", acp: { command: e.CFG_CODEX_ACP }, ...(e.CFG_FULL === "1" ? { fullAccess: "allowed" } : {}), ...(e.CFG_CODEX_MODEL ? { model: e.CFG_CODEX_MODEL } : {}), ...(e.CFG_CODEX_EFFORT ? { effort: e.CFG_CODEX_EFFORT } : {}), ...shared };
      }
      if (e.CFG_HERMES_BIN) {
        agents.hermes = { hermesHome: root + "/hermes", acp: { command: e.CFG_HERMES_BIN, args: ["acp"] }, ...shared };
      }
      if (Object.keys(profiles).length === 0 && !agents.hermes) { console.error("no agent is left to run"); process.exit(2); }
      if (Object.keys(profiles).length === 0) profiles["hermes-placeholder"] = { agent: "hermes-acp", driver: "acp", workdir: root + "/signin", acp: { command: e.CFG_HERMES_BIN, args: ["acp"] } };
      const config = { profiles, bin: { claude: e.CFG_CLAUDE_BIN || "claude", codex: e.CFG_CODEX_BIN || "codex" }, maxConcurrentRuns: 4, mcpTokenInFile: true, server: { root, agents, toolsDir: e.CFG_TOOLS, teamUsers: { helper: e.CFG_HELPER }, ...(e.CFG_PUB_SOCKET ? { publisherSocket: e.CFG_PUB_SOCKET } : {}) } };
      process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    ' >"$ETC/config.json.new" || die "could not write the config"
  chmod 0644 "$ETC/config.json.new"
  mv "$ETC/config.json.new" "$ETC/config.json"

  # ---- enrol -----------------------------------------------------------------------------------------------------------------------------------------------
  local insecure_flag='' ca_env_line=''
  # a site with its own certificate (the self-signed mode): the bridge trusts that one certificate, nothing wider
  if [ -s "$ETC/site-ca.pem" ]; then ca_env_line="Environment=NODE_EXTRA_CA_CERTS=$ETC/site-ca.pem"; fi
  [ "$insecure" -eq 1 ] && insecure_flag=' --insecure-for-tests'
  if [ "$mode" = enrol ]; then
    say "enrolling this machine"
    local hello answer
    hello="$(run_as "$SVC_USER" "$node" "$release/bridge.mjs" --config "$ETC/config.json" --state-dir "$DATA/state" --print-hello)" || die "the bridge could not describe this machine"
    # the code goes in the request body (from a variable, through a pipe), never in an argument of a program that stays running
    answer="$(CODE="$code" HELLO="$hello" "$node" -e 'const h = JSON.parse(process.env.HELLO); process.stdout.write(JSON.stringify({ code: process.env.CODE, host: h.host, agents: h.agents, bridgeVersion: h.bridgeVersion, allowFullAccess: h.allowFullAccess }));' \
      | site_curl -sS --max-time 30 -X POST -H 'content-type: application/json' --data-binary @- -w '\n%{http_code}' "$SITE/api/bridge/enrol")" || die "could not reach the site to enrol"
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
$ca_env_line
ExecStart=$node $PREFIX/current/bridge.mjs --config $ETC/config.json --state-dir $DATA/state --site $SITE$insecure_flag
Restart=always
RestartSec=5
# One bot command killed for memory must not stop the bridge and every team's runs with it (systemd's default for a unit is stop); the run's programs carry oom_score_adj 1000 (P31-04).
OOMPolicy=continue
UMask=0007
# No NoNewPrivileges and no RestrictSUIDSGID: the bridge starts each team's programs through sudo (the helper, below), and a sudo that cannot become root, or a helper that cannot make
# a setgid home, would stop every run. The rule allows two commands of one root-owned file. The helper makes users, so /etc and /var/log must be writable for it.
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA /etc /var/log -/var/mail -/var/spool/mail -/run/sudo -/var/lib/sudo
ProtectKernelTunables=true
ProtectControlGroups=true

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
# the group of the socket and its folder: the team users are in it (they open the socket); the publisher's own group is added so it can read the team homes (group $PUB_USER, mode 2750)
Group=$PUBLISH_GROUP
SupplementaryGroups=$PUB_USER
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
    status="$(key_status "$(live_key_file "$DATA" "$ETC")" "$SITE")"
    if [ "$status" = connected ]; then
      say "connected. Sign each agent in from the Runners page: $SITE/ (Settings, Runners)"
      say "agents on this server: $agents_line"
      [ -z "$hermes_warn" ] || warn "$hermes_warn"
      return 0
    fi
    sleep 2
  done
  warn "the site has not seen this machine yet. Look at: journalctl -u $UNIT -n 50"
  return 1
}

# ---- helpers -------------------------------------------------------------------------------------------------------------------------------------------------

# P31-01: the machine's Codex sign-in folder becomes the bridge user's alone (0700, files 0600, no setgid, no group). Once (a marker in root's lock folder), everything in it but
# `auth.json` is deleted: until now every team's Codex wrote its sessions, history and SQLite state there, readable by every other team (owner 2026-11-20: losing that thread context is
# accepted; a thread with an old Codex session starts a new one). The bridge is stopped first so no run of the old helper writes there while it changes; the end of the script starts it.
# A folder that is a link is replaced by a real one (root never follows a link the bridge user could plant).
move_codex_main_copy() {
  local data="$1" user="$2" unit="$3" main="$1/auth/codex" locks="$1/auth/.locks"
  mkdir -p "$locks"
  chown root:root "$locks"
  chmod 0700 "$locks"
  if [ -L "$main" ]; then rm -f "$main"; fi
  mkdir -p "$main"
  if [ ! -e "$locks/codex-main-private" ]; then
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      say "stopping the bridge while the Codex sign-in folder is made private"
      systemctl stop "$unit" || true
    fi
    find "$main" -mindepth 1 -maxdepth 1 ! -name auth.json -exec rm -rf -- {} +
    if [ -L "$main/auth.json" ] || { [ -e "$main/auth.json" ] && [ ! -f "$main/auth.json" ]; }; then rm -rf -- "$main/auth.json"; fi
    : >"$locks/codex-main-private"
    chmod 0600 "$locks/codex-main-private"
    say "the Codex sign-in folder holds only the sign-in now; the teams' old Codex sessions there were removed (each team keeps its own from now on)"
  fi
  chown -h "$user:$(id -gn "$user")" "$main"
  chmod 00700 "$main"
  # The sign-in itself must be one name of one file of the bridge user's. One with a second name (a hard link) or another owner is never chowned or chmodded by root: its content is
  # copied, AS the bridge user, into a new 0600 file that replaces the name (a file the bridge user cannot read, such as a link to /etc/shadow, is only unlinked: sign in again).
  local f="$main/auth.json"
  if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then
    rm -rf -- "$f"
  elif [ -f "$f" ] && { [ "$(stat -c %h "$f")" != 1 ] || [ "$(stat -c %U "$f")" != "$user" ]; }; then
    if ! setpriv --reuid "$user" --regid "$(id -g "$user")" --init-groups -- /bin/sh -c 'umask 077; rm -f -- "$1.fresh" && timeout 5 head -c 65536 -- "$1" > "$1.fresh" && test -s "$1.fresh" && mv -f -T -- "$1.fresh" "$1"' sh "$f"; then
      rm -f -- "$f" "$f.fresh"
      warn "the Codex sign-in file was not the bridge user's own and could not be read as that user; it was removed (sign Codex in again from the Runners page)"
    else
      say "the Codex sign-in file is a file of the bridge user's own again"
    fi
  fi
  # nothing else in the folder with a second name is chowned or chmodded by root either: it could be another file of the machine
  find "$main" -xdev \( -type d -o \( -type f -links 1 \) \) -exec chown -h "$user:$(id -gn "$user")" {} +
  find "$main" -xdev -type d -exec chmod 00700 {} +
  find "$main" -xdev -type f -links 1 -exec chmod 0600 {} +
}

say() { printf '%s\n' "$*"; }
# A size in bytes: a number, or a number with K, M, G (powers of 1024; a trailing B or iB is fine). Prints nothing and fails on anything else.
size_bytes() {
  local v="${1%[bB]}" n unit
  v="${v%i}"
  case "$v" in
    ''|*[!0-9KMGkmg]*) return 1 ;;
  esac
  n="${v%[KMGkmg]}"
  unit="${v#"$n"}"
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#n}" -le 13 ] || return 1
  case "$unit" in
    '') printf '%s\n' "$n" ;;
    K|k) printf '%s\n' "$((n * 1024))" ;;
    M|m) printf '%s\n' "$((n * 1048576))" ;;
    G|g) printf '%s\n' "$((n * 1073741824))" ;;
    *) return 1 ;;
  esac
}
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The pinned Node (checked against the hash this script carries), unpacked once under the program folder; prints its path. Used when the machine has no Node 22, and for the root
# helper when the machine's own Node is in a place someone other than root can change.
pinned_node() {
  local arch="$1" prefix="$2" version="$3" sha_x64="$4" sha_arm64="$5" want_sha tarball tmp
  if [ "$arch" = x64 ]; then want_sha="$sha_x64"; else want_sha="$sha_arm64"; fi
  tarball="node-$version-linux-$arch.tar.xz"
  if [ ! -x "$prefix/node/bin/node" ]; then
    command -v xz >/dev/null 2>&1 || die "xz is needed to unpack Node (install the xz-utils package)"
    say "downloading Node $version" >&2
    mkdir -p "$prefix"
    tmp="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/$version/$tarball" -o "$tmp/$tarball"
    printf '%s  %s\n' "$want_sha" "$tmp/$tarball" | sha256sum -c - >/dev/null || die "the Node download does not match its pinned hash"
    rm -rf "$prefix/node.new"
    mkdir -p "$prefix/node.new"
    tar -xJf "$tmp/$tarball" -C "$prefix/node.new" --strip-components=1
    rm -rf "$prefix/node"
    mv "$prefix/node.new" "$prefix/node"
    rm -rf "$tmp"
  fi
  printf '%s' "$prefix/node/bin/node"
}

# True when the file, what it links to and every folder above it belong to root and nobody but root can write them: a program that root runs must not be one the bridge's user or a team can swap.
root_safe_path() {
  local p dir
  p="$(readlink -f "$1" 2>/dev/null)" || return 1
  [ -n "$p" ] || return 1
  dir="$p"
  while [ -n "$dir" ] && [ "$dir" != / ]; do
    [ "$(stat -c %u "$dir")" = 0 ] || return 1
    case "$(stat -c %A "$dir")" in ?????w????|????????w?) return 1 ;; esac
    dir="$(dirname "$dir")"
  done
  return 0
}

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

# The Claude Code and Codex that the machine has are only reported: the bridge runs its own pinned copies. (Hermes is reported by find_hermes.)
report_host_agents() {
  local who="${1:-}" p found=''
  for p in claude codex; do
    if host_has "$p" "$who"; then found="$found $p"; fi
  done
  if [ -n "$found" ]; then say "found on this machine:$found (the bridge runs its own pinned copies with sign-in folders of their own; your logins are not touched)"; else say "neither claude nor codex is on this machine's PATH; the pinned copies are installed anyway"; fi
}

# Is this path somewhere the bridge's service cannot see (its unit has ProtectHome=true and a private /tmp), or where a login lives?
hidden_from_service() {
  case "$1" in /root|/root/*|/home|/home/*|/run/user|/run/user/*|/tmp|/tmp/*|/var/tmp|/var/tmp/*) return 0 ;; esac
  return 1
}

# Can the team users run this program? Runs `<program> --version` as the user `nobody`, in the group the team users share, in a throwaway folder that is its HOME and HERMES_HOME:
# no real home (root's, the admin's or a team's) is read or changed. Prints the version on success, or one short reason on failure.
hermes_usable() {
  local bin="$1" group="$2" real tmp uid gid gids out rc=0 line tmo=''
  command -v timeout >/dev/null 2>&1 && tmo='timeout 60'
  real="$(readlink -f "$bin" 2>/dev/null || true)"
  [ -n "$real" ] || { printf 'the file is not there'; return 1; }
  if hidden_from_service "$bin" || hidden_from_service "$real"; then printf 'it is in a home or temporary folder, which the bridge service cannot see'; return 1; fi
  [ -f "$real" ] && [ -x "$bin" ] || { printf 'it is not an executable file'; return 1; }
  uid="$(id -u nobody 2>/dev/null || echo 65534)"
  gid="$(id -g nobody 2>/dev/null || echo 65534)"
  gids="$(getent group "$group" | cut -d: -f3)"
  tmp="$(mktemp -d)" || { printf 'no temporary folder to check it in'; return 1; }
  chown "$uid:$gid" "$tmp"
  chmod 0700 "$tmp"
  # `--groups` also names mt-agents, so a program only that group may read counts as usable; the 60 seconds are for a first start
  out="$(cd "$tmp" && $tmo setpriv --reuid "$uid" --regid "$gid" --groups "${gids:-$gid}" --no-new-privs -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$tmp" HERMES_HOME="$tmp/.hermes" LC_ALL=C "$bin" --version </dev/null 2>&1)" || rc=$?
  rm -rf "$tmp"
  line="$(printf '%s\n' "$out" | sed -n '/[^[:space:]]/{p;q}' | cut -c1-100)"
  if [ "$rc" -ne 0 ]; then printf '%s' "${line:-it exited with status $rc}"; return 1; fi
  printf '%s' "$(printf '%s' "$line" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*' | head -1)"
  return 0
}

# Looks for Hermes and sets HERMES_FOUND_BIN (the path to use, or empty), HERMES_FOUND_LINE (the report line) and HERMES_FOUND_WARN (one plain sentence when Hermes was
# found but cannot be used). Looks only at the program, never at any Hermes home. Order: --hermes-bin; else root's PATH, /usr/local/bin, /usr/bin, /opt/*/bin; and the program an
# earlier run recorded in the table. The programs in /root/.local/bin and in the sudo user's ~/.local/bin are looked for only to say they cannot be used (a test that the file exists).
find_hermes() {
  local who="$1" arg="$2" table="$3" group="$4" node="$5" cand c seen='' first_bad='' reason ver prev='' fix
  HERMES_FOUND_BIN='' HERMES_FOUND_LINE='' HERMES_FOUND_WARN=''
  fix="install Hermes system-wide, for example under /opt/hermes, or pass --hermes-bin <path>"
  local -a cands=()
  if [ -n "$arg" ]; then
    case "$arg" in /*) ;; *) die "--hermes-bin needs an absolute path (starting with /)" ;; esac
    cands=("$arg")
  else
    c="$(command -v hermes 2>/dev/null || true)"
    [ -z "$c" ] || cands+=("$c")
    cands+=(/usr/local/bin/hermes /usr/bin/hermes)
    for c in /opt/*/bin/hermes; do cands+=("$c"); done
    if [ -s "$table" ]; then
      prev="$("$node" -e 'try { const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).agents || {}; if (a.hermes && typeof a.hermes.command === "string") process.stdout.write(a.hermes.command); } catch (e) {}' "$table" 2>/dev/null || true)"
      [ -z "$prev" ] || cands+=("$prev")
    fi
    cands+=(/root/.local/bin/hermes)
    if [ -n "$who" ] && [ "$who" != root ]; then
      c="$(getent passwd "$who" | cut -d: -f6)"
      [ -z "$c" ] || cands+=("$c/.local/bin/hermes")
    fi
  fi
  for cand in "${cands[@]}"; do
    case "$cand" in *[[:space:]]*|*..*) continue ;; esac
    case " $seen " in *" $cand "*) continue ;; esac
    seen="$seen $cand"
    [ -e "$cand" ] || continue
    if reason="$(hermes_usable "$cand" "$group")"; then
      ver="$reason"
      HERMES_FOUND_BIN="$cand"
      HERMES_FOUND_LINE="Hermes: found at $cand${ver:+ ($ver)}; its runner appears on the Runners page"
      return 0
    fi
    [ -n "$first_bad" ] || first_bad="$cand ($reason)"
  done
  if [ -n "$first_bad" ]; then
    HERMES_FOUND_LINE="Hermes: found but not usable, so the server is set up without it"
    HERMES_FOUND_WARN="Hermes was found at ${first_bad%% (*} but the team users cannot use it (${first_bad#* (}: $fix; the server is set up without Hermes and the rest goes on."
  elif [ -n "$arg" ]; then
    HERMES_FOUND_LINE="Hermes: not found at $arg, so the server is set up without it ($fix)"
  else
    HERMES_FOUND_LINE="Hermes: not found, so the server is set up without it (this script does not install Hermes; $fix, then run this command again with --update)"
  fi
  return 0
}

# curl to the site: with the pinned certificate when this machine was installed with --ca-sha256 (a site that made its own certificate)
site_curl() {
  if [ -s /etc/manythreads-bridge/site-ca.pem ]; then curl --cacert /etc/manythreads-bridge/site-ca.pem "$@"; else curl "$@"; fi
}

# --ca-sha256 HEX (SHA-256 of the site's certificate, as shown by the page that made this command): fetch the certificate the address shows now, refuse it unless its hash is
# the given one, and keep it as the only extra certificate this machine trusts for the site (curl here, and the bridge through NODE_EXTRA_CA_CERTS).
pin_site_certificate() {
  local site="$1" want="$2" out="$3" hostport host port tmp got
  want="$(printf '%s' "$want" | tr -d ': ' | tr 'A-F' 'a-f')"
  printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$' || die "--ca-sha256 must be 64 hex digits (the SHA-256 of the site's certificate)"
  command -v openssl >/dev/null 2>&1 || die "openssl is needed to check the site's certificate and was not found"
  hostport="${site#https://}"; hostport="${hostport%%/*}"
  host="${hostport%%:*}"; port=443
  case "$hostport" in *:*) port="${hostport##*:}" ;; esac
  tmp="$(mktemp)"
  local sni=(); printf '%s' "$host" | grep -Eq '^[0-9.]+$' || sni=(-servername "$host")
  openssl s_client -connect "$host:$port" "${sni[@]}" </dev/null 2>/dev/null | openssl x509 -outform PEM >"$tmp" 2>/dev/null || { rm -f "$tmp"; die "could not read the certificate of $site (this machine must reach it on port 443)"; }
  got="$(openssl x509 -in "$tmp" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    rm -f "$tmp"
    die "the certificate that $site shows is not the one this command was made for (it has the hash $got, the command says $want). Someone else may be answering at that address: nothing was installed."
  fi
  mkdir -p "$(dirname "$out")"
  install -m 0644 "$tmp" "$out"
  rm -f "$tmp"
  say "the site's certificate matches the one in the command; this machine will trust that certificate for $host"
}

# The key the bridge connects with: the same order as the bridge's own list (`keyFiles`): the copy in its state folder (written by a key rotation) first, then the installer's.
live_key_file() {
  local data="$1" etc="$2"
  if [ -s "$data/state/key" ]; then printf '%s' "$data/state/key"; else printf '%s' "$etc/key"; fi
}

# "connected" or something else; the key goes in a header read from a file, not from the command line
key_status() {
  local keyfile="$1" site="$2" out
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' <"$keyfile")" | site_curl -sS --max-time 15 --config - "$site/api/bridge/status" 2>/dev/null || true)"
  case "$out" in *'"status":"connected"'*) printf connected ;; *) printf other ;; esac
}

uninstall_all() {
  local purge="$1" PREFIX=/opt/manythreads-bridge ETC=/etc/manythreads-bridge DATA=/var/lib/manythreads-bridge
  local site='@@SITE@@' key_file
  key_file="$(live_key_file "$DATA" "$ETC")"
  if [ -s "$key_file" ]; then
    say "telling the site this server is going away"
    printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' <"$key_file")" | site_curl -sS --max-time 20 --config - -X POST "$site/api/bridge/uninstall" >/dev/null 2>&1 \
      || warn "the site could not be told; remove the server on the Runners page"
  fi
  systemctl disable --now manythreads-bridge.service manythreads-publisher.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/manythreads-bridge.service /etc/systemd/system/manythreads-publisher.service /etc/systemd/system/mtruns.slice
  rm -rf /etc/systemd/system/manythreads-publisher.service.d
  systemctl daemon-reload || true
  # the sudo rule and the helper go first and always: nothing may be able to start a program as a team's user once the bridge is gone
  rm -f /etc/sudoers.d/manythreads-bridge /etc/sudoers.d/manythreads-bridge.new
  rm -rf "$PREFIX"
  # the config and the key go; a refusal of full access (`no-full-access`) stays unless --purge, so a later install of this machine keeps refusing (P35-01)
  if [ "$purge" -eq 1 ]; then
    rm -rf "$ETC"
  elif [ -d "$ETC" ]; then
    find "$ETC" -mindepth 1 -maxdepth 1 ! -name no-full-access -exec rm -rf {} +
    if [ -e "$ETC/no-full-access" ]; then say "kept $ETC/no-full-access: a new install of this machine still refuses full access (--uninstall --purge removes it)"; else rmdir "$ETC" 2>/dev/null || true; fi
  fi
  # the key a rotation wrote is the live one: it goes with the program, also when the work folders stay
  rm -f "$DATA/state/key"
  if [ "$purge" -eq 1 ]; then
    # the team users (their homes are under $DATA/work, which goes with the next line), then the group the sign-in folders shared
    local u
    for u in $(getent passwd | awk -F: -v root="$DATA/work/" 'index($1, "mt-team-") == 1 && index($6, root) == 1 { print $1 }'); do
      pkill -KILL -u "$u" >/dev/null 2>&1 || true
      userdel "$u" >/dev/null 2>&1 || true
    done
    rm -rf "$DATA"
    groupdel mt-publish >/dev/null 2>&1 || true
    groupdel mt-agents >/dev/null 2>&1 || true
    userdel manythreads-bridge >/dev/null 2>&1 || true
    userdel manythreads-publisher >/dev/null 2>&1 || true
    say "removed the bridge, its services, its users (the bridge's, the publisher's and one per team) and its work folders"
  else
    say "removed the bridge and its service; $DATA/work and the team users are kept (run with --uninstall --purge to remove them too)"
  fi
}

main "$@"
