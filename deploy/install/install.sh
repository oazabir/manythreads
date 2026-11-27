#!/usr/bin/env bash
# manythreads installer: one command from an empty Linux machine to a running manythreads on k3s (PLAN P27-04, docs/deploy/install.md).
#
#   curl -fsSL <this file's address> | sudo bash
#   curl -fsSL <this file's address> | sudo bash -s -- --domain team.example.com --admin-email me@example.com
#
# The whole script is a set of functions and one call to `main` on the last line: a download that is cut short runs nothing.
# Read it before you run it: it installs k3s (when the machine has none), helm, a database operator, and manythreads itself, and writes /etc/manythreads and /usr/local/bin/manythreads.
#
# What it does, in order: checks the machine (nothing is changed until every check has passed); installs k3s when absent; installs helm, the database operator (CloudNativePG) and, for an
# HTTPS certificate, cert-manager; writes /etc/manythreads/values.yaml; installs the release's chart with the release's images (named by digest in release.json, the file that
# says what a release is); makes the first administrator with a made-up password the person must change; prints the address and the password ONCE; installs the `manythreads` command.
# Running it again changes nothing that is already there. No password is ever written to the log (/var/log/manythreads-install.log) or put on a command line.
#
#   --domain NAME         the name people will use (its DNS must point at this machine). Without it, the machine's public address is used as <a-b-c-d>.sslip.io
#   --admin-email ADDR    the first administrator (asked for on the keyboard when missing, default admin@<address>)
#   --workspace NAME      the organization's name (default "My organization"; the first-run wizard renames it)
#   --tls MODE            auto (default) | letsencrypt | selfsigned | cloudflare | none   (see docs/deploy/install.md)
#   --origin-cert FILE --origin-key FILE    with --tls cloudflare: the Cloudflare origin certificate
#   --version X.Y.Z       the release to install (default: the one --release-url names)
#   --release-url URL     where release.json is (an https address or a file path); remembered in /etc/manythreads/install.env
#   --insecure-release-url  allow a plain http:// release address (a trial on a private network only: nothing then proves the files are the project's)
#   --chart REF           install this chart (an oci:// address, a directory or a .tgz) instead of the release's
#   --public-ip ADDR      use this as the machine's public address (otherwise it is looked up)
#   --calls               turn calls on even when the machine's choice is to ask (behind Cloudflare, calls show the server's real address)
#   --no-calls            leave calls (voice and video rooms, TURN) out of this install
#   --calls-network KIND  public | nat | local | auto (default): what kind of network the machine is on; auto tests it and prints what it found
#   --no-firewall         do not open the call ports in this machine's firewall (the exact lines are printed instead)
#   --kubeconfig FILE     use an existing cluster (k3s is not installed; cluster-wide pieces are added after one question)
#   --yes                 answer yes to the questions (uninstall, adding cluster-wide pieces)
#   --upgrade             install the release named now over the one installed (same values; a lower version is refused)
#   --uninstall           remove manythreads (asks for the word "delete"); --remove-addons also removes cert-manager and the database operator; --remove-k3s removes k3s when this script installed it
#   --calls-enable        (used by `manythreads calls enable`) turn calls on for an install that has none; with the same --calls-network, --no-firewall, --calls, --public-ip
#   --print-plan          print every step and every choice, change nothing, need no root
#   -h, --help            this text

set -euo pipefail

# ---- what is pinned -----------------------------------------------------------------------------------------------------------------------------------------
K3S_VERSION='v1.36.5+k3s1'
HELM_VERSION='v3.22.0'
HELM_SHA256_X64='1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb'
CERT_MANAGER_VERSION='v1.21.3'
CNPG_CHART_VERSION='0.29.1'
# Where release.json is when --release-url is not given. Empty until the project's download address is decided (docs/plans/onboarding-journey.md §10 q2).
DEFAULT_RELEASE_URL=''

ETC=${MANYTHREADS_ETC:-/etc/manythreads}
LOG=${MANYTHREADS_INSTALL_LOG:-/var/log/manythreads-install.log}
NS=manythreads
RELEASE=manythreads
MEMINFO=${MANYTHREADS_MEMINFO:-/proc/meminfo}
HOST_COMMAND=${MANYTHREADS_HOST_COMMAND:-/usr/local/bin/manythreads}
VAR=${MANYTHREADS_VAR:-/var/lib/manythreads}
# Calls (docs/deploy/install.md "Calls"): on | off | auto (ask where a question is needed); the network kind; the firewall switch. Set by the flags in main.
CALLS_FLAG=auto; CALLS_NET=auto; NO_FIREWALL=0
# What decide_calls found (it sets these; it runs in the main shell, not in a subshell)
CALLS_ON=0; CALLS_TYPE=off; CALLS_NODE_IP=''; CALLS_INTERNAL_IP=''; CALLS_REASON=''
# The ports calls use on the machine itself (proto:range). 7880 (LiveKit's signalling) is not among them: it is reached only through the ingress path /livekit.
CALLS_PORTS=(udp:3478 udp:50000-50100 udp:50101-50300 tcp:7881)

# ---- small things -------------------------------------------------------------------------------------------------------------------------------------------
say() { printf '%s\n' "$*"; logline "$*"; }
step() { printf '\n==> %s\n' "$*"; logline "==> $*"; }
warn() { printf 'warning: %s\n' "$*" >&2; logline "warning: $*"; }
die() { printf 'error: %s\n' "$*" >&2; logline "error: $*"; exit 1; }
logline() { [ -n "${LOG_READY:-}" ] && printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG" 2>/dev/null || true; }
have() { command -v "$1" >/dev/null 2>&1; }

# Runs a command with its output in the log; on failure says what failed and where to look. Never used for a command that prints a secret.
run() {
  local label="$1"; shift
  logline "+ $*"
  if "$@" >>"$LOG" 2>&1; then return 0; fi
  tail -n 12 "$LOG" >&2 || true
  die "$label failed (the last lines are above; the whole log is $LOG). Run this again once it is fixed: it continues where it stopped."
}

ask_yes() { # question; --yes answers yes; no keyboard answers no
  [ "${YES:-0}" -eq 1 ] && return 0
  [ -r /dev/tty ] || return 1
  local a; printf '%s [y/N] ' "$1" >/dev/tty; IFS= read -r a </dev/tty || return 1
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
ask_line() { # prompt default -> prints the answer
  local a=''
  if [ -r /dev/tty ] && [ "${YES:-0}" -eq 0 ]; then printf '%s [%s] ' "$1" "$2" >/dev/tty; IFS= read -r a </dev/tty || a=''; fi
  printf '%s' "${a:-$2}"
}

# ---- facts about the machine (each can be pointed elsewhere by the tests) ------------------------------------------------------------------------------------------
mem_mb() { awk '/^MemTotal:/ {printf "%d", $2/1024}' "$MEMINFO"; }
cpu_count() { nproc 2>/dev/null || echo 1; }
free_gb() { df -P --output=avail -BG "$1" 2>/dev/null | tail -n 1 | tr -dc '0-9'; }

# The memory rule: under 8 GB stops, 8 to 16 GB leaves the agent pods off, 16 GB or more is everything. A "16 GB" machine reports about 15.6 GB, hence 15000.
memory_class() { # mb -> too-small | small | full
  local mb="$1"
  if [ "$mb" -lt 7400 ]; then echo too-small; elif [ "$mb" -lt 15000 ]; then echo small; else echo full; fi
}
disk_class() { # free GB -> too-small | small | ok
  local gb="$1"
  if [ "$gb" -lt 40 ]; then echo too-small; elif [ "$gb" -lt 80 ]; then echo small; else echo ok; fi
}

# 1.2.3.4 -> true when it is an address the Internet can reach (not private, loopback, link-local or shared address space) # secret-scan:ignore documentation example
is_public_ipv4() {
  local ip="${1:-}" a b c d
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
  local o
  for o in "$a" "$b" "$c" "$d"; do [ "$o" -le 255 ] || return 1; done
  case "$a" in 0|10|127) return 1 ;; esac
  [ "$a" -lt 224 ] || return 1
  [ "$a.$b" != "192.168" ] || return 1
  [ "$a" -ne 172 ] || { [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1; true; }
  [ "$a" -ne 169 ] || [ "$b" -ne 254 ] || return 1
  [ "$a" -ne 100 ] || { [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1; true; }
  return 0
}
sslip_name() { printf '%s.sslip.io' "${1//./-}"; }

# What HTTPS to set up (docs/plans/onboarding-journey.md §3.6). Prints "mode host extra" where extra is a name that also reaches the site, or "-".
#   plan_tls <tls flag> <domain or ""> <public ip or ""> <primary ip>
plan_tls() {
  local flag="$1" domain="$2" pub="$3" local_ip="$4"
  case "$flag" in
    none) echo "none ${domain:-${pub:-$local_ip}} -" ;;
    cloudflare) [ -n "$domain" ] || return 2; echo "cloudflare $domain -" ;;
    selfsigned) echo "selfsigned ${domain:-${pub:-$local_ip}} -" ;;
    letsencrypt)
      if [ -n "$domain" ]; then echo "letsencrypt $domain -"
      elif [ -n "$pub" ]; then echo "letsencrypt $(sslip_name "$pub") -"
      else return 3; fi ;;
    auto)
      if [ -n "$domain" ]; then echo "letsencrypt $domain -"
      elif [ -n "$pub" ]; then echo "letsencrypt $(sslip_name "$pub") -"
      else echo "selfsigned $local_ip -"; fi ;;
    *) return 4 ;;
  esac
}

primary_ip() {
  local ip=''
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1) || true # secret-scan:ignore well-known resolver used only to find the route
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
  printf '%s' "${ip:-127.0.0.1}"
}
lookup_public_ip() {
  local ip='' url
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]') || ip=''
    is_public_ipv4 "$ip" && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

# ---- calls: voice and video rooms (docs/deploy/install.md "Calls") -------------------------------------------------------------------------------------------------
# A new install turns calls on when the machine can carry them. The choice is made here, from facts that each test can supply through the environment, and written
# to the install's own values file (never to values-install.yaml: an upgrade applies that file to installs that have no call address, and they would fail).

# an address -> 0 when it lies inside a Cloudflare proxy range (cloudflare.com/ips-v4, the published list; a missing range only means we ask less often)
is_cloudflare_ip() {
  local ip="${1:-}" a b c d n r base bits mask
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
  n=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  for r in 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22; do # secret-scan:ignore Cloudflare's published ranges
    base=${r%/*}; bits=${r#*/}
    IFS=. read -r a b c d <<<"$base"
    mask=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
    [ $(( n & mask )) -eq $(( ((a << 24) | (b << 16) | (c << 8) | d) & mask )) ] && return 0
  done
  return 1
}
# The addresses a name points at (the tests give them in MANYTHREADS_DOMAIN_IPS)
domain_ips() {
  if [ -n "${MANYTHREADS_DOMAIN_IPS+x}" ]; then printf '%s\n' "$MANYTHREADS_DOMAIN_IPS"; return 0; fi
  have getent || return 0
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' '
}
behind_cloudflare() { # tls-mode host -> 0 when the site is served through Cloudflare's proxy
  local mode="$1" host="$2" ip
  [ "$mode" != cloudflare ] || return 0
  [[ "$host" =~ ^[0-9.]+$ ]] && return 1
  case "$host" in *.sslip.io) return 1 ;; esac # a name made from an address is never behind a proxy
  for ip in $(domain_ips "$host"); do is_cloudflare_ip "$ip" && return 0; done
  return 1
}

# Can this machine reach itself at its public address (NAT loopback)? Prints yes | no | unknown. MANYTHREADS_CALLS_LOOPBACK answers it for the tests.
# A throwaway listener on port 443 is used when the port is free (a fresh machine), so the answer does not depend on anything being installed yet.
detect_loopback() { # public ip
  case "${MANYTHREADS_CALLS_LOOPBACK:-}" in yes|no|unknown) echo "$MANYTHREADS_CALLS_LOOPBACK"; return 0 ;; esac
  local pub="$1" lp='' r=unknown
  if have python3 && have ss && ! ss -H -ltn 'sport = :443' 2>/dev/null | grep -q .; then
    python3 -c 'import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 443)); s.listen(8); s.settimeout(1)
end=time.time()+8
while time.time()<end:
    try: s.accept()[0].close()
    except Exception: pass' >/dev/null 2>&1 &
    lp=$!; sleep 1
  fi
  if timeout 4 bash -c ">/dev/tcp/$pub/443" 2>/dev/null; then r=yes; elif [ -n "$lp" ]; then r=no; fi
  [ -z "$lp" ] || { kill "$lp" 2>/dev/null || true; wait "$lp" 2>/dev/null || true; }
  echo "$r"
}

# What calls to set up. Prints "type node-ip internal-ip reason": type is public | nat | local | off; an address is "-" when there is none.
#   plan_calls <tls mode> <public ip or ""> <primary ip> <network: auto|public|nat|local> <loopback: yes|no|unknown>
plan_calls() {
  local mode="$1" pub="$2" local_ip="$3" net="$4" loop="$5"
  if [ "$mode" = none ]; then echo "off - - plain HTTP: browsers block the camera and the microphone on a page without HTTPS"; return 0; fi
  if [ -z "$pub" ] && [[ "$local_ip" =~ ^(127\.|$) ]]; then echo "off - - no usable address was found on this machine: give --public-ip"; return 0; fi
  case "$net" in
    public) [ -n "$pub" ] || pub="$local_ip"; echo "public $pub - you said this machine has a public address" ;;
    nat)
      [ -n "$pub" ] || { echo "off - - --calls-network nat needs the public address (give --public-ip)"; return 0; }
      echo "nat $pub $local_ip you said this machine is behind a router that cannot reach itself by its public address" ;;
    local) echo "local $local_ip - you said this machine is on a local network only" ;;
    auto)
      if [ -z "$pub" ]; then
        if is_public_ipv4 "$local_ip"; then echo "public $local_ip - the machine's own address is a public one"
        else echo "local $local_ip - no public address was found: calls work for people on the same local network"; fi
      elif [ "$pub" = "$local_ip" ]; then echo "public $pub - the public address is on this machine itself"
      elif [ "$loop" = yes ]; then echo "public $pub - the machine reaches itself by its public address (a router that loops back)"
      elif [ "$loop" = no ]; then echo "nat $pub $local_ip the machine is behind a router that cannot reach itself by its public address, so browsers get both addresses"
      else echo "nat $pub $local_ip it could not be tested whether the router loops back to this machine, so browsers get both addresses"; fi ;;
    *) echo "off - - unknown network kind $net" ;;
  esac
}

# Asks one yes/no question on the keyboard; --yes and a missing keyboard answer no (a question that reveals something is never answered for the person).
# MANYTHREADS_CALLS_ANSWER (yes|no) answers it for the tests.
ask_strict() {
  case "${MANYTHREADS_CALLS_ANSWER:-}" in yes) return 0 ;; no) return 1 ;; esac
  [ "${YES:-0}" -eq 0 ] || return 1
  { : </dev/tty; } 2>/dev/null || return 1
  local a; printf '%s [y/N] ' "$1" >/dev/tty; IFS= read -r a </dev/tty || return 1
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Decides and says what it decided. Sets CALLS_ON, CALLS_TYPE, CALLS_NODE_IP, CALLS_INTERNAL_IP, CALLS_REASON.
#   decide_calls <tls mode> <host> <public ip or ""> <primary ip>
decide_calls() {
  local mode="$1" host="$2" pub="$3" local_ip="$4" out loop=unknown t n i reason
  CALLS_ON=0; CALLS_TYPE=off; CALLS_NODE_IP=''; CALLS_INTERNAL_IP=''; CALLS_REASON=''
  if [ "$CALLS_FLAG" = off ]; then CALLS_REASON="you chose --no-calls"; say "calls: off ($CALLS_REASON)"; return 0; fi
  if [ "$mode" = none ]; then
    CALLS_REASON="plain HTTP: browsers block the camera and the microphone without HTTPS"
    say "calls: off ($CALLS_REASON). Use HTTPS (--tls selfsigned, letsencrypt or cloudflare) and then run: sudo manythreads calls enable"
    return 0
  fi
  if [ -n "${KUBECONFIG_ARG:-}" ] && [ "$CALLS_FLAG" != on ]; then
    CALLS_REASON="this install uses a cluster that was already there (--kubeconfig); the call address goes through Traefik's ingress, which that cluster may not have. Add --calls if it does, or run: sudo manythreads calls enable"
    say "calls: off ($CALLS_REASON)"; return 0
  fi
  if behind_cloudflare "$mode" "$host" && [ "$CALLS_FLAG" != on ]; then
    say "This site is served through Cloudflare. Calls need the audio to reach this machine directly (UDP ports that Cloudflare does not carry), so anyone who joins a call can learn this server's real address."
    if ! ask_strict "Turn calls on anyway?"; then
      CALLS_REASON="behind Cloudflare, and calls would reveal the server's real address; add --calls (or run: sudo manythreads calls enable --calls) to turn them on"
      say "calls: off ($CALLS_REASON)"; return 0
    fi
  fi
  if [ "$CALLS_NET" = auto ] && [ -n "$pub" ] && [ "$pub" != "$local_ip" ]; then loop=$(detect_loopback "$pub"); fi
  out=$(plan_calls "$mode" "$pub" "$local_ip" "$CALLS_NET" "$loop")
  read -r t n i reason <<<"$out"
  if [ "$t" = off ]; then CALLS_REASON="$reason"; say "calls: off ($reason)"; return 0; fi
  CALLS_ON=1; CALLS_TYPE="$t"; CALLS_NODE_IP="$n"; CALLS_REASON="$reason"; [ "$i" = - ] || CALLS_INTERNAL_IP="$i"
  say "calls: on. Machine type \"$t\": $reason."
  say "  call address: $n${CALLS_INTERNAL_IP:+; local address given too: $CALLS_INTERNAL_IP}"
  [ "$CALLS_NET" != auto ] || say "  (found: public address ${pub:-none}, this machine's address $local_ip, reaches itself by the public address: $loop; to decide it yourself use --calls-network public, nat or local)"
}

# The values of this install's calls, as yaml lines. A new install writes them into values.yaml; `manythreads calls enable` into calls.yaml.
calls_values() { # type node-ip internal-ip host
  local type="$1" node="$2" internal="$3" host="$4"
  echo "# Calls (voice and video rooms), machine type $type. TURN is on without TLS (tlsPort 0); the audio ports are opened in this machine's firewall by the installer."
  echo "media:"
  echo "  enabled: true"
  # publicUrl is left out on purpose: the chart makes it wss://<domain>/livekit, so a new name (`manythreads set-domain`) moves the signalling too
  echo "  ingressPath: /livekit"
  echo "  nodeIp: $node"
  echo "  useExternalIp: false"
  [ "$type" != nat ] || echo "  advertiseInternalIp: true"
  echo "  turn:"
  echo "    enabled: true"
  echo "    domain: $host"
  echo "    tlsPort: 0"
  echo "    udpPort: 3478"
  case "$type" in
    nat) echo "    allowRestrictedPeerCidrs: [$internal/32]" ;;
    local) echo "    allowRestrictedPeerCidrs: [$node/32]" ;;
  esac
}

# ---- the firewall (only a firewall that is active is touched, and never with --no-firewall) ----------------------------------------------------------------------
firewall_kind() { # prints ufw | firewalld | iptables | none: the first tool that is active here
  if have ufw && ufw status 2>/dev/null | grep -qi '^Status: active'; then echo ufw; return 0; fi
  if have firewall-cmd && [ "$(firewall-cmd --state 2>/dev/null)" = running ]; then echo firewalld; return 0; fi
  if have iptables && iptables -S INPUT 2>/dev/null | grep -v -e '--dport 7880' | grep -Eq -e '^-P INPUT (DROP|REJECT)' -e ' -j (DROP|REJECT)'; then echo iptables; return 0; fi
  echo none
}
firewall_has() { # kind proto range -> 0 when that port is already allowed
  local kind="$1" proto="$2" range="$3" colon="${3/-/:}"
  case "$kind" in
    ufw) ufw status 2>/dev/null | grep -Eq "^(${range}|${colon})(/${proto})?[[:space:]]+ALLOW" ;;
    firewalld) firewall-cmd --list-ports 2>/dev/null | tr ' ' '\n' | grep -qx "$range/$proto" ;;
    iptables) iptables -C INPUT -p "$proto" --dport "$colon" -j ACCEPT 2>/dev/null ;;
    *) return 0 ;;
  esac
}
# The pods reach LiveKit's signalling (TCP 7880, on the machine's own network) from the pod network; that stays allowed and nothing else is, so 7880 is closed from outside.
POD_CIDR=${MANYTHREADS_POD_CIDR:-10.42.0.0/16}
firewall_lines() { # kind -> the lines a person runs by hand
  local kind="$1" e proto range
  case "$kind" in
    firewalld)
      for e in "${CALLS_PORTS[@]}"; do proto=${e%%:*}; range=${e#*:}; echo "firewall-cmd --permanent --add-port=$range/$proto"; done
      echo "firewall-cmd --permanent --zone=trusted --add-source=$POD_CIDR"; echo "firewall-cmd --reload" ;;
    iptables)
      for e in "${CALLS_PORTS[@]}"; do proto=${e%%:*}; range=${e#*:}; echo "iptables -I INPUT -p $proto --dport ${range/-/:} -j ACCEPT"; done
      echo "iptables -I INPUT -p tcp --dport 7880 -j DROP"; echo "iptables -I INPUT -p tcp --dport 7880 -s $POD_CIDR -j ACCEPT"; echo "iptables -I INPUT -p tcp --dport 7880 -i lo -j ACCEPT" ;;
    *)
      for e in "${CALLS_PORTS[@]}"; do proto=${e%%:*}; range=${e#*:}; echo "ufw allow ${range/-/:}/$proto"; done
      echo "ufw allow from $POD_CIDR to any port 7880 proto tcp"; echo "ufw deny 7880/tcp" ;;
  esac
}
# Keeps TCP 7880 for the pods and this machine: a DROP for everyone else, the two accepts above it.
close_7880_iptables() {
  iptables -C INPUT -p tcp --dport 7880 -j DROP 2>/dev/null && return 0
  run "closing 7880 to outsiders" iptables -I INPUT -p tcp --dport 7880 -j DROP
  run "letting the pods reach 7880" iptables -I INPUT -p tcp --dport 7880 -s "$POD_CIDR" -j ACCEPT
  run "letting this machine reach 7880" iptables -I INPUT -p tcp --dport 7880 -i lo -j ACCEPT
  if have netfilter-persistent; then netfilter-persistent save >>"$LOG" 2>&1 || true; else say "  (the iptables rules for 7880 last until the machine restarts; run: sudo manythreads calls enable after a restart, or save them with your system's tool)"; fi
}
firewall_open() { # kind: opens each missing call port, and keeps 7880 for the pods only
  local kind="$1" e proto range reload=0
  for e in "${CALLS_PORTS[@]}"; do
    proto=${e%%:*}; range=${e#*:}
    if firewall_has "$kind" "$proto" "$range"; then say "  ${proto^^} $range: open already"; continue; fi
    case "$kind" in
      ufw) run "opening $range/$proto in ufw" ufw allow "${range/-/:}/$proto" ;;
      firewalld) run "opening $range/$proto in firewalld" firewall-cmd --permanent --add-port="$range/$proto"; reload=1 ;;
      iptables) run "opening $range/$proto in iptables" iptables -I INPUT -p "$proto" --dport "${range/-/:}" -j ACCEPT ;;
    esac
    say "  ${proto^^} $range: opened"
  done
  case "$kind" in
    ufw)
      # the pods first (a rule that comes earlier wins), then a refusal for everyone else when ufw's default would let 7880 in
      ufw status 2>/dev/null | grep -Eq "^7880/tcp[[:space:]]+ALLOW[[:space:]]+$POD_CIDR" || run "letting the pods reach 7880 in ufw" ufw allow from "$POD_CIDR" to any port 7880 proto tcp
      ufw status verbose 2>/dev/null | grep -Eqi '^Default:.*(deny|reject) \(incoming\)' || run "closing 7880 in ufw" ufw deny 7880/tcp ;;
    firewalld) firewall-cmd --permanent --zone=trusted --query-source="$POD_CIDR" >/dev/null 2>&1 || { run "trusting the pod network in firewalld" firewall-cmd --permanent --zone=trusted --add-source="$POD_CIDR"; reload=1; } ;;
    iptables) close_7880_iptables ;;
  esac
  if [ "$reload" -eq 1 ]; then run "reloading firewalld" firewall-cmd --reload; fi
  say "  TCP 7880 (LiveKit's signalling) is reached only through the address's /livekit path; it is not opened to outside"
}
firewall_hint() { # the tool whose lines are the most use to print
  local k; k=$(firewall_kind)
  if [ "$k" != none ]; then echo "$k"; elif have firewall-cmd; then echo firewalld; elif have iptables && ! have ufw; then echo iptables; else echo ufw; fi
}
calls_firewall() { # opens the ports, or prints what to run
  local kind; kind=$(firewall_kind)
  if [ "$NO_FIREWALL" -eq 1 ]; then
    say "firewall: left alone (--no-firewall). If this machine has a firewall, run these lines (and open the same ports in your provider's network firewall, if it has one):"
    firewall_lines "$(firewall_hint)" | sed 's/^/  /'
  elif [ "$kind" = none ]; then
    say "firewall: no active firewall (ufw, firewalld or iptables rules) was found here, so nothing on this machine blocks the call ports."
    if have iptables; then say "  TCP 7880 (LiveKit's signalling) would be open to everyone on this machine's network, so it is closed with an iptables rule that lets only the pods and this machine in:"; close_7880_iptables
    else say "  TCP 7880 (LiveKit's signalling) is open to anyone who can reach this machine; close it to outsiders (the pods reach it from $POD_CIDR)."; fi
    say "  If your provider has a network firewall (a security group), open UDP 3478, UDP 50000-50100, UDP 50101-50300 and TCP 7881 there (not 7880)."
  else
    say "firewall: $kind is active; checking the call ports"
    firewall_open "$kind"
    say "  If your provider also has a network firewall (a security group), open UDP 3478, 50000-50100, 50101-50300 and TCP 7881 there too."
  fi
}

# After a helm install that had calls on: the firewall, then the media pod
calls_after_install() {
  step "Calls: the firewall and the media pod"
  calls_firewall
  if kubectl -n "$NS" rollout status deploy/manythreads-media --timeout=300s >>"$LOG" 2>&1; then say "the media pod is ready"
  else warn "the media pod is not ready yet (kubectl -n $NS describe pod -l app.kubernetes.io/component=media); check later with: sudo manythreads calls check"; fi
}

# `manythreads calls enable` (the host command downloads this installer, checks it against release.json, and runs it with --calls-enable): the same decision as a new install
# makes, for an install that has no calls (or whose address changed). It writes /etc/manythreads/calls.yaml, which every later upgrade applies too. Safe to run again.
calls_enable_existing() { # public ip, primary ip
  local pub="$1" local_ip="$2" tmode host chart
  [ -f "$ETC/install.env" ] || die "manythreads is not installed on this machine (no $ETC/install.env)"
  [ "$CALLS_FLAG" != off ] || die "--no-calls and calls enable say opposite things"
  setup_kube_env
  have helm || die "helm was not found"
  tmode=$(state_get TLS_MODE); host=$(state_get HOST); chart="$VAR/chart"
  [ -f "$chart/values-install.yaml" ] || die "the chart of this release is not kept on this machine ($chart); run: manythreads upgrade"
  { [ -f "$chart/templates/media.yaml" ] && grep -q '^  advertiseInternalIp:' "$chart/values.yaml" 2>/dev/null; } || die "the chart of this install ($(state_get VERSION)) is older than calls; run: sudo manythreads upgrade, then calls enable"
  step "Calls (voice and video rooms)"
  decide_calls "$tmode" "$host" "$pub" "$local_ip"
  if [ "$CALLS_ON" -eq 0 ]; then say "nothing was changed."; return 1; fi
  mkdir -p "$ETC"; chmod 700 "$ETC"
  calls_values "$CALLS_TYPE" "$CALLS_NODE_IP" "$CALLS_INTERNAL_IP" "$host" >"$ETC/calls.yaml"; chmod 600 "$ETC/calls.yaml"
  helm_install "$chart" "Turning calls on (the media pod starts; the images may be pulled)"
  kubectl -n "$NS" get deploy/manythreads-media >/dev/null 2>&1 || die "the chart made no media pod (is media.enabled false in a file that is read after $ETC/calls.yaml?); calls are not on"
  calls_after_install
  state_put CALLS 1; state_put CALLS_TYPE "$CALLS_TYPE"; state_put CALLS_NODE_IP "$CALLS_NODE_IP"
  say "Calls are on. Check them with: sudo manythreads calls check"
}

# ---- the checks (a failure is one plain line; nothing has been changed yet) --------------------------------------------------------------------------------------
check_machine() { # prints problems as "error: ..." / "warning: ..." lines, returns 1 when there is an error
  local bad=0 mb gb cpus
  if [ "$(uname -s)" != Linux ]; then echo "error: this installer is for Linux"; return 1; fi
  case "$(uname -m)" in x86_64|amd64) ;; *) echo "error: this machine's processor ($(uname -m)) is not supported yet (x86-64 is)"; bad=1 ;; esac
  if [ -r /etc/os-release ]; then
    local id version
    id=$(. /etc/os-release; echo "${ID:-}"); version=$(. /etc/os-release; echo "${VERSION_ID:-}")
    case "$id:$version" in ubuntu:22.04|ubuntu:24.04|debian:12) ;; *) echo "warning: $id $version is not one of the tested systems (Ubuntu 22.04, 24.04, Debian 12); it may still work" ;; esac
  fi
  [ -d /run/systemd/system ] || { echo "error: this machine does not run systemd"; bad=1; }
  mb=$(mem_mb)
  case "$(memory_class "$mb")" in
    too-small) echo "error: manythreads needs at least 8 GB of memory; this machine has $(( (mb + 512) / 1024 )) GB"; bad=1 ;;
    small) echo "warning: this machine has $(( (mb + 512) / 1024 )) GB of memory: the agent pods (Claude Code and Codex in a pod) are left off, and one team pod runs at a time. 16 GB or more runs everything" ;;
  esac
  gb=$(free_gb "${FREE_DISK_PATH:-/var}")
  case "$(disk_class "${gb:-0}")" in
    too-small) echo "error: manythreads needs at least 40 GB of free disk space; this machine has ${gb:-0} GB free"; bad=1 ;;
    small) echo "warning: ${gb} GB of disk is free; 80 GB or more is comfortable (the images are about 10 GB, and every team's work volume grows)" ;;
  esac
  cpus=$(cpu_count)
  [ "$cpus" -ge 4 ] || echo "warning: this machine has $cpus CPU cores; 4 or more is comfortable"
  return "$bad"
}

check_tools() {
  local c
  for c in curl tar sha256sum awk sed; do have "$c" || die "$c is needed and was not found (on Debian or Ubuntu: apt-get install curl tar coreutils gawk sed)"; done
}

# A port in use by something that is not k3s's own Traefik / API server
port_busy() {
  local port="$1"
  have ss || return 1
  ss -H -ltnp "sport = :$port" 2>/dev/null | grep -qv -e 'k3s' -e 'traefik' -e '^$' 2>/dev/null
}
check_ports() {
  local p
  for p in 80 443 6443; do
    if port_busy "$p"; then die "port $p is used by another program on this machine; stop it, or install on another machine"; fi
  done
}

check_network() {
  local url=https://ghcr.io/v2/
  # the registry answers 401 to a request with no sign-in: that is "reachable"
  curl -fsS --max-time 15 -o /dev/null "$url" 2>/dev/null || [ "$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$url")" = 401 ] || die "this machine cannot reach ghcr.io on port 443 (the images come from there)"
  if ! have k3s && [ -z "${KUBECONFIG_ARG:-}" ]; then
    curl -fsS --max-time 15 -o /dev/null https://get.k3s.io 2>/dev/null || die "this machine cannot reach get.k3s.io on port 443 (k3s is installed from there)"
  fi
}

check_clock() {
  have timedatectl || return 0
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo yes)" = yes ] || warn "this machine's clock is not synchronized: certificates may be refused (timedatectl set-ntp true)"
}

# ---- release.json ---------------------------------------------------------------------------------------------------------------------------------------------
INSECURE_RELEASE_URL=${MANYTHREADS_INSECURE_RELEASE_URL:-0}
fetch() { # url|path dest
  case "$1" in
    http://*) [ "$INSECURE_RELEASE_URL" = 1 ] || die "the release address $1 is plain http, so nothing would prove the files are the project's; use an https address (or --insecure-release-url on a private network)"
              curl -fsSL --max-time 120 -o "$2" "$1" ;;
    https://*) curl -fsSL --max-time 120 -o "$2" "$1" ;;
    file://*) cp "${1#file://}" "$2" ;;
    *) cp "$1" "$2" ;;
  esac
}
rel_url_sibling() { # <release url> <file name> -> the same folder
  case "$1" in */*) printf '%s/%s' "${1%/*}" "$2" ;; *) printf '%s' "$2" ;; esac
}

# Checks a release.json the way release-manifest.mjs does, and says the first problem.
release_problem() { # file -> prints a sentence, or nothing when it is good
  local f="$1" name ref
  jq -e . "$f" >/dev/null 2>&1 || { echo "release.json is not JSON"; return; }
  [ "$(jq -r '.schema // 0' "$f")" = 1 ] || { echo "release.json has an unknown schema"; return; }
  jq -r '.version // ""' "$f" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || { echo "release.json has no valid version"; return; }
  for name in server web postgres-cnpg hermes-pod workbench claude-pod; do
    ref=$(jq -r --arg n "$name" '.images[$n] // ""' "$f")
    [[ "$ref" =~ ^ghcr\.io/[a-z0-9-]+/manythreads-$name@sha256:[0-9a-f]{64}$ ]] || { echo "release.json names no digest for the image $name"; return; }
  done
  jq -r '.installSha256 // ""' "$f" | grep -Eq '^[0-9a-f]{64}$' || { echo "release.json has no SHA-256 of install.sh"; return; }
  jq -r '.hostCommandSha256 // ""' "$f" | grep -Eq '^[0-9a-f]{64}$' || { echo "release.json has no SHA-256 of the manythreads command"; return; }
  jq -r '.chart.ref // ""' "$f" | grep -Eq '^oci://' || { echo "release.json names no chart"; return; }
}

# Versions compare as numbers: 0.27.0 < 0.27.10 < 0.28.0 (a pre-release suffix is ignored)
version_lt() { # a b: a < b
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "${1%%-*}" "${2%%-*}" | sort -V | head -n1)" = "${1%%-*}" ] && [ "${1%%-*}" != "${2%%-*}" ]
}

# ---- the values file ----------------------------------------------------------------------------------------------------------------------------------------
# write_values <file> <release.json> <mode> <host> <extra> <email> <le-server> <claude-pod: true|false> <ip list, comma separated or ""> [calls values: the lines calls_values prints]
write_values() {
  local out="$1" rel="$2" mode="$3" host="$4" extra="$5" email="$6" leserver="$7" claude="$8" ips="${9:-}" calls="${10:-}"
  {
    echo "# Written by install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) for release $(jq -r .version "$rel"). It is read on every upgrade; change it with \`manythreads set-domain\` or by hand."
    echo "# Given to helm after the chart's own values-install.yaml, so what is here wins."
    echo "domain: $host"
    if [ -n "$extra" ] && [ "$extra" != - ]; then echo "extraDomains: [$extra]"; fi
    if [ "$mode" = none ]; then echo "publicUrl: http://$host"; fi
    echo "tls:"
    echo "  mode: $mode"
    echo "  wildcard: false"
    if [ "$mode" = letsencrypt ]; then
      echo "  letsencrypt:"
      echo "    email: $email"
      echo "    server: $leserver"
    fi
    if [ "$mode" = selfsigned ] && [ -n "$ips" ]; then
      echo "  selfSigned:"
      echo "    ipAddresses: [$ips]"
    fi
    echo "server:"; echo "  image: $(jq -r ".images[\"server\"]" "$rel")"
    echo "web:"; echo "  image: $(jq -r ".images[\"web\"]" "$rel")"
    echo "postgres:"; echo "  image: $(jq -r ".images[\"postgres-cnpg\"]" "$rel")"
    echo "hermesPods:"; echo "  images:"; echo "    hermes: $(jq -r ".images[\"hermes-pod\"]" "$rel")"; echo "    workbench: $(jq -r ".images[\"workbench\"]" "$rel")"
    echo "claudePod:"; echo "  enabled: $claude"; echo "  image: $(jq -r ".images[\"claude-pod\"]" "$rel")"
    if [ -n "$calls" ]; then printf '%s\n' "$calls"; fi
  } >"$out"
}

# ---- reading and writing the state file ----------------------------------------------------------------------------------------------------------------------------
state_get() { [ -f "$ETC/install.env" ] && sed -n "s/^$1=//p" "$ETC/install.env" | tail -n1 || true; }
state_put() { # key value
  mkdir -p "$ETC"; touch "$ETC/install.env"; chmod 600 "$ETC/install.env"
  grep -v "^$1=" "$ETC/install.env" >"$ETC/install.env.new" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >>"$ETC/install.env.new"
  mv "$ETC/install.env.new" "$ETC/install.env"; chmod 600 "$ETC/install.env"
}

# ---- the steps ------------------------------------------------------------------------------------------------------------------------------------------------
install_k3s() {
  if have k3s || [ -n "${KUBECONFIG_ARG:-}" ]; then say "k3s: using the cluster that is here"; return 0; fi
  step "Installing k3s $K3S_VERSION"
  # Traefik keeps visitors' addresses (the sign-in lockout counts them); read by k3s when it starts
  mkdir -p /var/lib/rancher/k3s/server/manifests
  cat >/var/lib/rancher/k3s/server/manifests/traefik-config.yaml <<'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        externalTrafficPolicy: Local
EOF
  logline "+ curl get.k3s.io | sh"
  curl -fsSL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC='--write-kubeconfig-mode 600' sh -s - >>"$LOG" 2>&1 || die "k3s did not install (see $LOG)"
  state_put K3S_INSTALLED_BY_US 1
  for _ in $(seq 1 60); do k3s kubectl get nodes 2>/dev/null | grep -q ' Ready' && return 0; sleep 3; done
  die "k3s started but the node never became Ready (see: journalctl -u k3s)"
}

setup_kube_env() {
  if [ -n "${KUBECONFIG_ARG:-}" ]; then export KUBECONFIG="$KUBECONFIG_ARG"; else export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi
  have kubectl || { have k3s && { mkdir -p /usr/local/bin; ln -sf "$(command -v k3s)" /usr/local/bin/kubectl; }; } || true
  have kubectl || die "kubectl was not found (k3s provides it)"
}

install_helm() {
  have helm && { say "helm: $(helm version --short 2>/dev/null | head -n1)"; return 0; }
  step "Installing helm $HELM_VERSION"
  local tmp; tmp=$(mktemp -d)
  run "download of helm" curl -fsSL -o "$tmp/helm.tgz" "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz"
  echo "$HELM_SHA256_X64  $tmp/helm.tgz" | sha256sum -c - >>"$LOG" 2>&1 || die "the helm download does not match its SHA-256; nothing was installed"
  tar -xzf "$tmp/helm.tgz" -C "$tmp"
  install -m 0755 "$tmp/linux-amd64/helm" /usr/local/bin/helm
  rm -rf "$tmp"
}

install_addons() { # <need cert-manager: 1|0>
  local want_cm="$1"
  if ! helm status cnpg -n cnpg-system >/dev/null 2>&1; then
    if [ -n "${KUBECONFIG_ARG:-}" ] && ! ask_yes "Add the database operator (CloudNativePG) to this cluster? It is cluster-wide."; then die "the database operator is needed"; fi
    step "Installing the database operator (CloudNativePG $CNPG_CHART_VERSION)"
    run "helm repo add cnpg" helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update
    run "the database operator" helm upgrade --install cnpg cnpg/cloudnative-pg --version "$CNPG_CHART_VERSION" -n cnpg-system --create-namespace \
      --set resources.requests.memory=64Mi --set resources.limits.memory=256Mi --wait --timeout 5m
  else say "database operator: already installed"; fi
  if [ "$want_cm" = 1 ] && ! helm status cert-manager -n cert-manager >/dev/null 2>&1; then
    if [ -n "${KUBECONFIG_ARG:-}" ] && ! ask_yes "Add cert-manager (makes the HTTPS certificate) to this cluster? It is cluster-wide."; then die "cert-manager is needed for this HTTPS choice"; fi
    step "Installing cert-manager $CERT_MANAGER_VERSION"
    run "helm repo add jetstack" helm repo add jetstack https://charts.jetstack.io --force-update
    run "cert-manager" helm upgrade --install cert-manager jetstack/cert-manager --version "$CERT_MANAGER_VERSION" -n cert-manager --create-namespace \
      --set crds.enabled=true --set resources.requests.memory=64Mi --set resources.limits.memory=256Mi \
      --set webhook.resources.requests.memory=32Mi --set webhook.resources.limits.memory=128Mi \
      --set cainjector.resources.requests.memory=64Mi --set cainjector.resources.limits.memory=256Mi --wait --timeout 5m
  fi
}

# Puts the chart in a folder: an oci:// address is pulled, a directory is used as it is, a .tgz is unpacked. Prints the chart's folder.
prepare_chart() { # ref version workdir
  local ref="$1" version="$2" work="$3"
  case "$ref" in
    oci://*) run "pulling the chart" helm pull "$ref" --version "$version" --untar --untardir "$work"; echo "$work/manythreads" ;;
    *.tgz) mkdir -p "$work"; tar -xzf "$ref" -C "$work"; echo "$work/manythreads" ;;
    *) echo "$ref" ;;
  esac
}

helm_install() { # chart-dir [what is being done]
  local chart="$1"
  [ -f "$chart/values-install.yaml" ] || die "the chart has no values-install.yaml (is this a release chart?)"
  step "${2:-Installing manythreads (this pulls the images: it takes several minutes the first time)}"
  # no --wait: the backups claim stays Pending until the first nightly job (MISTAKES.md, "Install-fresh"); the steps below wait for what matters
  local files=(-f "$chart/values-install.yaml" -f "$ETC/values.yaml") extra
  # what `manythreads calls enable`, `set-domain` and `allow-git-host` wrote is kept by an upgrade (calls.yaml before domain.yaml: set-domain moves the call address)
  for extra in calls.yaml domain.yaml git-hosts.yaml; do [ ! -f "$ETC/$extra" ] || files+=(-f "$ETC/$extra"); done
  run "installing the chart" helm upgrade --install "$RELEASE" "$chart" -n "$NS" --create-namespace "${files[@]}" --timeout 15m
  # the chart stays on the machine: `manythreads set-domain` and `upgrade` use it
  if [ "$chart" != "$VAR/chart" ]; then mkdir -p "$VAR"; rm -rf "$VAR/chart"; cp -r "$chart" "$VAR/chart"; fi
}

wait_ready() {
  step "Waiting for the database, the server and the web pod"
  for _ in $(seq 1 120); do kubectl -n "$NS" get cluster.postgresql.cnpg.io/manythreads-pg >/dev/null 2>&1 && break; sleep 2; done
  run "waiting for the database" kubectl -n "$NS" wait cluster.postgresql.cnpg.io/manythreads-pg --for=condition=Ready --timeout=900s
  run "waiting for the server" kubectl -n "$NS" rollout status deploy/manythreads-server --timeout=900s
  run "waiting for the web pod" kubectl -n "$NS" rollout status deploy/manythreads-web --timeout=600s
  for _ in $(seq 1 60); do
    kubectl -n "$NS" exec deploy/manythreads-server -- node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0
    sleep 3
  done
  die "the server did not answer /readyz (kubectl -n $NS logs deploy/manythreads-server)"
}

# Makes the first administrator once. Prints nothing; the password goes to the Secret and to a file the printout reads (mode 0600, removed after).
make_admin() { # email workspace passfile
  local email="$1" workspace="$2" passfile="$3" out status
  if kubectl -n "$NS" get secret manythreads-first-admin >/dev/null 2>&1; then say "the first administrator exists already"; return 0; fi
  step "Making the first administrator"
  out=$(kubectl -n "$NS" exec -i deploy/manythreads-server -- pnpm --filter @manythreads/server admin first-admin --email "$email" --workspace "$workspace" 2>>"$LOG") || die "the first administrator could not be made (see $LOG)"
  status=$(printf '%s\n' "$out" | sed -n 's/^FIRST_ADMIN_STATUS=//p')
  if [ "$status" = exists ]; then say "a workspace exists already: no administrator was made"; return 0; fi
  [ "$status" = created ] || die "the first-admin command answered something unexpected (see $LOG)"
  umask 077
  printf '%s\n' "$out" | sed -n 's/^FIRST_ADMIN_PASSWORD=//p' >"$passfile"
  [ -s "$passfile" ] || die "the first-admin command printed no password"
  # the Secret is made from a file, so the password is on no command line
  kubectl -n "$NS" create secret generic manythreads-first-admin --from-literal=email="$email" --from-file=password="$passfile" >>"$LOG" 2>&1 || die "the sign-in could not be kept in the cluster"
}

cert_fingerprint() { # prints the SHA-256 of the site's certificate (hex, no colons) from the Secret
  kubectl -n "$NS" get secret manythreads-tls -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d | openssl x509 -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1
}

print_box() { # address email passfile version mode fingerprint [calls line]
  local addr="$1" email="$2" passfile="$3" version="$4" mode="$5" fp="$6" calls="${7:-}" pass=''
  [ ! -s "$passfile" ] || pass=$(cat "$passfile")
  printf '\n'
  printf 'manythreads %s is running.\n' "$version"
  printf '  Open:      %s\n' "$addr"
  printf '  Sign in:   %s\n' "$email"
  if [ -n "$pass" ]; then
    printf '  Password:  %s   (shown once; `sudo manythreads admin-password` shows it again until you change it)\n' "$pass"
  else
    printf '  Password:  not shown again here; `sudo manythreads admin-password` shows it until you change it\n'
  fi
  printf '  Next:      sign in and follow "Finish setting up".\n'
  printf '  Keep safe: `sudo manythreads backup-key` prints the key that unlocks stored secrets; save it in your password manager.\n'
  [ -z "$calls" ] || printf '  Calls:     %s\n' "$calls"
  case "$mode" in
    selfsigned) printf '  Certificate: self-signed (SHA-256 %s). Your browser will warn once: that is expected; compare it with this fingerprint before you accept.\n' "$fp" ;;
    none) printf '  Warning:   plain HTTP: for a trial only. Passwords cross the network unprotected.\n' ;;
  esac
  printf '\n'
}

install_host_command() { # release url, release.json
  local url="$1" rel="$2" tmp want got
  tmp=$(mktemp); want=$(jq -r .hostCommandSha256 "$rel")
  fetch "$(rel_url_sibling "$url" manythreads)" "$tmp" || die "could not download the manythreads command"
  got=$(sha256sum "$tmp" | cut -d' ' -f1)
  [ "$got" = "$want" ] || die "the manythreads command does not match release.json (expected $want, got $got); nothing was installed"
  install -m 0755 "$tmp" "$HOST_COMMAND"; rm -f "$tmp"
}

# Waits (up to 5 minutes) for the certificate manythreads-tls to be Ready; returns 1 when it is not
settle_letsencrypt() {
  for _ in $(seq 1 60); do
    [ "$(kubectl -n "$NS" get certificate manythreads-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ] && return 0
    sleep 5
  done
  return 1
}

# ---- the plan ---------------------------------------------------------------------------------------------------------------------------------------------------
print_plan() { # tls-mode host extra version release-url claude-class [calls line]
  local mode="$1" host="$2" extra="$3" version="$4" url="$5" mem="$6" calls="${7:-}"
  echo "manythreads install plan (nothing is changed by --print-plan)"
  echo "  release:       ${version:-the one $url names}  (release.json: ${url:-not set})"
  echo "  address:       $host   (HTTPS: $mode$( [ -n "$extra" ] && [ "$extra" != - ] && echo ", also reachable as $extra"))"
  case "$mem" in full) echo "  agent pods:    on (16 GB or more)" ;; small) echo "  agent pods:    off (8 to 16 GB of memory)" ;; *) echo "  agent pods:    off" ;; esac
  [ -z "$calls" ] || echo "  calls:         $calls"
  echo "steps:"
  echo "  1. checks: Linux x86-64, systemd, root, memory, disk, CPU, ports 80/443/6443, clock, the network"
  if have k3s || [ -n "${KUBECONFIG_ARG:-}" ]; then echo "  2. k3s: the cluster that is here is used"; else echo "  2. install k3s $K3S_VERSION (Traefik keeps visitors' addresses)"; fi
  echo "  3. install helm $HELM_VERSION (if missing), the database operator $CNPG_CHART_VERSION$( [ "$mode" = letsencrypt ] || [ "$mode" = selfsigned ] && echo ", cert-manager $CERT_MANAGER_VERSION")"
  echo "  4. write $ETC/values.yaml (mode 0600) from the release's images by digest"
  echo "  5. helm install the release's chart in the namespace $NS (no --wait; the install waits for the database, server and web itself)"
  echo "  6. make the first administrator (admin first-admin), keep the password in the Secret manythreads-first-admin, print it once"
  echo "  7. calls (unless off): open UDP 3478, 50000-50100, 50101-50300 and TCP 7881 in the firewall that is active (or print the lines to run), keep TCP 7880 closed to outsiders, wait for the media pod"
  echo "  8. install $HOST_COMMAND and write $ETC/install.env"
  echo "files: $ETC/values.yaml, $ETC/install.env, $HOST_COMMAND, $LOG"
}

# ---- main -------------------------------------------------------------------------------------------------------------------------------------------------------
main() {
  local domain='' email='' workspace='My organization' tls=auto origin_cert='' origin_key='' want_version='' release_url="${MANYTHREADS_RELEASE_URL:-$DEFAULT_RELEASE_URL}" chart_arg='' public_ip='' mode=install
  local remove_addons=0 remove_k3s=0 plan=0
  YES=0; KUBECONFIG_ARG=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) shift; [ $# -gt 0 ] || die "--domain needs a name"; domain="$1" ;;
      --admin-email) shift; [ $# -gt 0 ] || die "--admin-email needs an address"; email="$1" ;;
      --workspace) shift; [ $# -gt 0 ] || die "--workspace needs a name"; workspace="$1" ;;
      --tls) shift; [ $# -gt 0 ] || die "--tls needs auto, letsencrypt, selfsigned, cloudflare or none"; tls="$1" ;;
      --origin-cert) shift; origin_cert="${1:-}" ;;
      --origin-key) shift; origin_key="${1:-}" ;;
      --version) shift; want_version="${1#v}" ;;
      --release-url) shift; [ $# -gt 0 ] || die "--release-url needs an address"; release_url="$1" ;;
      --insecure-release-url) INSECURE_RELEASE_URL=1 ;;
      --chart) shift; chart_arg="${1:-}" ;;
      --public-ip) shift; public_ip="${1:-}" ;;
      --kubeconfig) shift; KUBECONFIG_ARG="${1:-}"; [ -r "$KUBECONFIG_ARG" ] || die "cannot read the kubeconfig $KUBECONFIG_ARG" ;;
      --calls) CALLS_FLAG=on ;;
      --no-calls) CALLS_FLAG=off ;;
      --calls-network) shift; [ $# -gt 0 ] || die "--calls-network needs auto, public, nat or local"; CALLS_NET="$1" ;;
      --no-firewall) NO_FIREWALL=1 ;;
      --calls-enable) mode=calls ;;
      --yes|-y) YES=1 ;;
      --upgrade) mode=upgrade ;;
      --uninstall) mode=uninstall ;;
      --remove-addons) remove_addons=1 ;;
      --remove-k3s) remove_k3s=1 ;;
      --print-plan) plan=1 ;;
      -h|--help) sed -n '2,/^$/p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; return 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  case "$tls" in auto|letsencrypt|selfsigned|cloudflare|none) ;; *) die "--tls wants auto, letsencrypt, selfsigned, cloudflare or none" ;; esac
  case "$CALLS_NET" in auto|public|nat|local) ;; *) die "--calls-network wants auto, public, nat or local" ;; esac
  if [ "$tls" = cloudflare ]; then
    [ -n "$domain" ] || die "--tls cloudflare needs --domain"
    [ -n "$origin_cert" ] && [ -n "$origin_key" ] && [ -f "$origin_cert" ] && [ -f "$origin_key" ] || die "--tls cloudflare needs --origin-cert FILE and --origin-key FILE (the Cloudflare origin certificate)"
  fi
  if [ -z "$release_url" ] && [ "$mode" != uninstall ]; then release_url=$(state_get RELEASE_URL); fi

  # ---- what would be done -------------------------------------------------------------------------------------------------------------------------------------
  local local_ip pub='' mb class
  local_ip=$(primary_ip)
  if [ -n "$public_ip" ]; then pub="$public_ip"; else pub=$(lookup_public_ip || true); fi
  mb=$(mem_mb); class=$(memory_class "$mb")

  if [ "$plan" -eq 1 ]; then
    local pm ph pe
    read -r pm ph pe < <(plan_tls "$tls" "$domain" "$pub" "$local_ip" || echo "selfsigned $local_ip -")
    local pc pt pn pi pr
    if [ "$CALLS_FLAG" = off ]; then pc="off (--no-calls)"
    elif [ "$pm" = none ]; then pc="off (plain HTTP: browsers block the camera and the microphone without HTTPS)"
    elif behind_cloudflare "$pm" "$ph"; then pc="$( [ "$CALLS_FLAG" = on ] && echo on || echo 'asked first: the site is behind Cloudflare, so calls reveal the real address; off when nobody can be asked')"
    else
      read -r pt pn pi pr <<<"$(plan_calls "$pm" "$pub" "$local_ip" "$CALLS_NET" unknown)"
      pc="$pt: $pr (call address $pn; whether the router loops back is tested at install time)"
    fi
    print_plan "$pm" "$ph" "$pe" "$want_version" "$release_url" "$class" "$pc"
    return 0
  fi

  [ "$(id -u)" -eq 0 ] || [ -n "${MANYTHREADS_INSTALL_FOR_TESTS:-}" ] || die "run it as root: put sudo before bash"
  mkdir -p "$(dirname "$LOG")"; touch "$LOG"; chmod 600 "$LOG"; LOG_READY=1
  logline "install.sh started: $*"

  case "$mode" in
    uninstall) uninstall_all "$remove_addons" "$remove_k3s"; return 0 ;;
    calls) calls_enable_existing "$pub" "$local_ip"; return $? ;;
  esac

  # ---- the checks ---------------------------------------------------------------------------------------------------------------------------------------------
  step "Checking this machine"
  check_tools
  local problems rc=0
  # MANYTHREADS_INSTALL_FOR_TESTS (the script's own tests only) skips the checks of the real machine
  if [ -z "${MANYTHREADS_INSTALL_FOR_TESTS:-}" ]; then problems=$(check_machine) || rc=$?; else problems=''; fi
  [ -z "$problems" ] || printf '%s\n' "$problems" >&2
  [ "$rc" -eq 0 ] || die "this machine cannot run manythreads (see above); nothing was changed"
  have jq || { have apt-get && run "installing jq" apt-get install -y jq; }
  have jq || die "jq is needed (on Debian or Ubuntu: apt-get install jq)"
  have openssl || warn "openssl was not found: the certificate fingerprint cannot be printed"
  [ -n "$release_url" ] || die "this copy of the installer does not know where release.json is: give --release-url <address>"
  if [ -z "${MANYTHREADS_INSTALL_FOR_TESTS:-}" ]; then check_ports_unless_installed; check_clock; check_network; fi

  # ---- the release --------------------------------------------------------------------------------------------------------------------------------------------
  local work rel version
  work=$(mktemp -d); WORK="$work"; trap 'rm -rf "${WORK:-}"' EXIT
  rel="$work/release.json"
  fetch "$release_url" "$rel" || die "could not read release.json at $release_url"
  local problem; problem=$(release_problem "$rel"); [ -z "$problem" ] || die "$problem; nothing was changed"
  version=$(jq -r .version "$rel")
  if [ -n "$want_version" ] && [ "$want_version" != "$version" ]; then die "the release at $release_url is $version, not $want_version"; fi

  local installed; installed=$(state_get VERSION)
  if [ "$mode" = install ] && [ -n "$installed" ]; then
    say "already installed ($installed)."
    [ "$installed" = "$version" ] || say "this release is $version; run again with --upgrade to move to it."
    local addr; addr=$(state_get ADDRESS); [ -z "$addr" ] || say "Open: $addr"
    [ ! -x "$HOST_COMMAND" ] || "$HOST_COMMAND" doctor || true
    return 0
  fi
  if [ "$mode" = upgrade ]; then
    [ -n "$installed" ] || die "nothing is installed here: run it without --upgrade"
    if version_lt "$version" "$installed"; then die "this release ($version) is older than the installed one ($installed): migrations only go forward"; fi
  fi

  # ---- the choices --------------------------------------------------------------------------------------------------------------------------------------------
  local tmode thost textra
  if [ "$mode" = upgrade ]; then
    tmode=$(state_get TLS_MODE); thost=$(state_get HOST); textra=-
  else
    local plan_out
    plan_out=$(plan_tls "$tls" "$domain" "$pub" "$local_ip") || die "could not decide the HTTPS setup: --tls letsencrypt needs --domain or a public address (use --public-ip)"
    read -r tmode thost textra <<<"$plan_out"
  fi
  [ -n "$email" ] || email=$(ask_line "The first administrator's email" "admin@$thost")
  [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "that is not an email address: $email"
  local claude=false; [ "$class" = full ] && claude=true
  # calls: only a new install decides; an upgrade never changes what an install has (an install without a call address would fail to upgrade)
  local calls_block=''
  if [ "$mode" = install ]; then
    step "Calls (voice and video rooms)"
    decide_calls "$tmode" "$thost" "$pub" "$local_ip"
    [ "$CALLS_ON" -eq 0 ] || calls_block=$(calls_values "$CALLS_TYPE" "$CALLS_NODE_IP" "$CALLS_INTERNAL_IP" "$thost")
  fi

  # ---- doing it -----------------------------------------------------------------------------------------------------------------------------------------------
  install_k3s
  setup_kube_env
  install_helm
  local want_cm=0; { [ "$tmode" = letsencrypt ] || [ "$tmode" = selfsigned ]; } && want_cm=1
  install_addons "$want_cm"

  mkdir -p "$ETC"; chmod 700 "$ETC"
  if [ "$mode" = install ]; then
    # a self-signed certificate also names this machine's own address, so the address people use on the local network works too
    local ips=''
    if [ "$tmode" = selfsigned ] && [ "$local_ip" != "$thost" ] && [[ "$local_ip" =~ ^[0-9.]+$ ]]; then ips="$local_ip"; fi
    write_values "$ETC/values.yaml" "$rel" "$tmode" "$thost" "$textra" "$email" staging "$claude" "$ips" "$calls_block"
  else
    # an upgrade keeps the file and moves only the images
    refresh_images "$ETC/values.yaml" "$rel"
  fi
  chmod 600 "$ETC/values.yaml"

  if [ "$tmode" = cloudflare ]; then
    kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS" >>"$LOG" 2>&1
    kubectl -n "$NS" create secret tls manythreads-origin-cert --cert="$origin_cert" --key="$origin_key" --dry-run=client -o yaml | kubectl apply -f - >>"$LOG" 2>&1
  fi

  local chart_ref chart
  chart_ref=${chart_arg:-$(jq -r .chart.ref "$rel")}
  chart=$(prepare_chart "$chart_ref" "$(jq -r .chart.version "$rel")" "$work/chart")
  [ -d "$chart" ] || die "the chart was not found at $chart_ref"

  helm_install "$chart"

  # HTTPS by Let's Encrypt: staging first (a name that cannot be proven, or a closed port 80, shows up here without spending the real certificate's rate limit)
  if [ "$tmode" = letsencrypt ] && [ "$mode" = install ]; then
    step "Getting the HTTPS certificate (a trial certificate first, then the real one)"
    if settle_letsencrypt; then
      sed -i 's/^    server: staging$/    server: production/' "$ETC/values.yaml"
      kubectl -n "$NS" delete secret manythreads-tls --ignore-not-found >>"$LOG" 2>&1 || true
      helm_install "$chart"
      settle_letsencrypt || { warn "the real certificate was not issued in time; it keeps trying in the background (kubectl -n $NS describe certificate manythreads-tls)"; }
    else
      warn "Let's Encrypt could not prove $thost (is port 80 reachable from the Internet, and does the name point here?). Using a self-signed certificate instead."
      tmode=selfsigned
      local ips2=''; [ "$local_ip" = "$thost" ] || ips2="$local_ip"
      write_values "$ETC/values.yaml" "$rel" selfsigned "$thost" "$textra" "$email" staging "$claude" "$ips2" "$calls_block"
      helm_install "$chart"
      settle_letsencrypt || warn "the self-signed certificate is not ready yet"
    fi
  elif [ "$tmode" = selfsigned ]; then
    settle_letsencrypt || warn "the self-signed certificate is not ready yet"
  fi

  wait_ready
  if [ "$mode" = install ] && [ "$CALLS_ON" -eq 1 ]; then calls_after_install; fi
  local passfile="$work/first-password"; : >"$passfile"; chmod 600 "$passfile"
  if [ "$mode" = install ]; then make_admin "$email" "$workspace" "$passfile"; fi

  install_host_command "$release_url" "$rel"
  local scheme=https; [ "$tmode" = none ] && scheme=http
  local address="$scheme://$thost" fp=''
  [ "$tmode" != selfsigned ] || fp=$(cert_fingerprint)
  state_put VERSION "$version"; state_put TLS_MODE "$tmode"; state_put HOST "$thost"; state_put ADDRESS "$address"; state_put RELEASE_URL "$release_url"
  [ -z "$fp" ] || state_put CERT_SHA256 "$fp"
  state_put ADMIN_EMAIL "$email"
  local calls_line=''
  if [ "$mode" = install ]; then
    state_put CALLS "$CALLS_ON"; state_put CALLS_TYPE "$CALLS_TYPE"; state_put CALLS_NODE_IP "$CALLS_NODE_IP"
    if [ "$CALLS_ON" -eq 1 ]; then calls_line="on ($CALLS_TYPE); check them with: sudo manythreads calls check"
    else calls_line="off ($CALLS_REASON)"; fi
  fi
  print_box "$address" "$email" "$passfile" "$version" "$tmode" "$fp" "$calls_line"
}

check_ports_unless_installed() {
  # the machine's own k3s holds the ports after a first install, and a re-run must not call that "busy"
  if have k3s && systemctl is-active --quiet k3s 2>/dev/null; then return 0; fi
  check_ports
}

refresh_images() { # values-file release.json: replaces the image lines the installer wrote (server, web, postgres, hermes, workbench, claude-pod)
  local f="$1" rel="$2" name ref
  for name in server web; do
    ref=$(jq -r --arg n "$name" '.images[$n]' "$rel")
    sed -i "/^$name:\$/,/^[a-z]/ s#^  image: .*#  image: $ref#" "$f"
  done
  ref=$(jq -r '.images["postgres-cnpg"]' "$rel"); sed -i "/^postgres:\$/,/^[a-z]/ s#^  image: .*#  image: $ref#" "$f"
  ref=$(jq -r '.images["hermes-pod"]' "$rel"); sed -i "s#^    hermes: .*#    hermes: $ref#" "$f"
  ref=$(jq -r '.images["workbench"]' "$rel"); sed -i "s#^    workbench: .*#    workbench: $ref#" "$f"
  ref=$(jq -r '.images["claude-pod"]' "$rel"); sed -i "/^claudePod:\$/,/^[a-z]/ s#^  image: .*#  image: $ref#" "$f"
}

uninstall_all() { # remove_addons remove_k3s
  local addons="$1" k3s_too="$2" word=''
  setup_kube_env 2>/dev/null || true
  say "This removes manythreads from this machine: the release, its database and every team's volumes and apps (the namespaces $NS, ${NS}-bots and the team app namespaces this install made, found by their label)."
  if [ "${YES:-0}" -eq 1 ]; then word=delete
  elif [ -r /dev/tty ]; then printf 'Type the word delete to go on: ' >/dev/tty; IFS= read -r word </dev/tty || word=''; fi
  [ "$word" = delete ] || die "not removed (the word delete was not typed)"
  if kubectl -n "$NS" get secret manythreads-server-secrets >/dev/null 2>&1 && ask_yes "Print the key that unlocks stored secrets first? (save it before everything is removed)"; then
    "$HOST_COMMAND" backup-key || true
  fi
  helm uninstall "$RELEASE" -n "$NS" >>"$LOG" 2>&1 || true
  local ns
  # Only what this install labelled as its own (the chart puts manythreads.io/apps=true on a team's app namespace): a namespace of somebody else that happens to be called
  # apps-something on a cluster that was there before is never touched, whatever its name.
  for ns in "$NS" "${NS}-bots" $(kubectl get ns -l 'app.kubernetes.io/part-of=manythreads,manythreads.io/apps=true' -o name 2>/dev/null | sed -n 's#^namespace/\(.*\)#\1#p'); do
    case "$ns" in default|kube-*|"") continue ;; esac
    kubectl delete ns "$ns" --ignore-not-found --wait=false >>"$LOG" 2>&1 || true
  done
  if [ "$addons" -eq 1 ]; then helm uninstall cert-manager -n cert-manager >>"$LOG" 2>&1 || true; helm uninstall cnpg -n cnpg-system >>"$LOG" 2>&1 || true; fi
  if [ "$k3s_too" -eq 1 ]; then
    if [ "$(state_get K3S_INSTALLED_BY_US)" = 1 ] && [ -x /usr/local/bin/k3s-uninstall.sh ]; then /usr/local/bin/k3s-uninstall.sh >>"$LOG" 2>&1 || true
    else warn "k3s was not installed by this script, so it is kept"; fi
  fi
  rm -f "$HOST_COMMAND"
  rm -f "$ETC/values.yaml" "$ETC/install.env"
  say "manythreads was removed."
}

if [ -z "${MANYTHREADS_INSTALL_SOURCE_ONLY:-}" ]; then main "$@"; fi
