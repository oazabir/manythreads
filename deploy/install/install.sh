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
#   --chart REF           install this chart (an oci:// address, a directory or a .tgz) instead of the release's
#   --public-ip ADDR      use this as the machine's public address (otherwise it is looked up)
#   --kubeconfig FILE     use an existing cluster (k3s is not installed; cluster-wide pieces are added after one question)
#   --yes                 answer yes to the questions (uninstall, adding cluster-wide pieces)
#   --upgrade             install the release named now over the one installed (same values; a lower version is refused)
#   --uninstall           remove manythreads (asks for the word "delete"); --remove-addons also removes cert-manager and the database operator; --remove-k3s removes k3s when this script installed it
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
fetch() { # url|path dest
  case "$1" in
    https://*|http://*) curl -fsSL --max-time 120 -o "$2" "$1" ;;
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
# write_values <file> <release.json> <mode> <host> <extra> <email> <le-server> <claude-pod: true|false> <ip list, comma separated or "">
write_values() {
  local out="$1" rel="$2" mode="$3" host="$4" extra="$5" email="$6" leserver="$7" claude="$8" ips="${9:-}"
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

helm_install() { # chart-dir
  local chart="$1"
  [ -f "$chart/values-install.yaml" ] || die "the chart has no values-install.yaml (is this a release chart?)"
  step "Installing manythreads (this pulls the images: it takes several minutes the first time)"
  # no --wait: the backups claim stays Pending until the first nightly job (MISTAKES.md, "Install-fresh"); the steps below wait for what matters
  local files=(-f "$chart/values-install.yaml" -f "$ETC/values.yaml") extra
  # what `manythreads set-domain` and `manythreads allow-git-host` wrote is kept by an upgrade
  for extra in domain.yaml git-hosts.yaml; do [ ! -f "$ETC/$extra" ] || files+=(-f "$ETC/$extra"); done
  run "installing the chart" helm upgrade --install "$RELEASE" "$chart" -n "$NS" --create-namespace "${files[@]}" --timeout 15m
  # the chart stays on the machine: `manythreads set-domain` and `upgrade` use it
  mkdir -p "${MANYTHREADS_VAR:-/var/lib/manythreads}"; rm -rf "${MANYTHREADS_VAR:-/var/lib/manythreads}/chart"; cp -r "$chart" "${MANYTHREADS_VAR:-/var/lib/manythreads}/chart"
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

print_box() { # address email passfile version mode fingerprint
  local addr="$1" email="$2" passfile="$3" version="$4" mode="$5" fp="$6" pass=''
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
print_plan() { # tls-mode host extra version release-url claude-class
  local mode="$1" host="$2" extra="$3" version="$4" url="$5" mem="$6"
  echo "manythreads install plan (nothing is changed by --print-plan)"
  echo "  release:       ${version:-the one $url names}  (release.json: ${url:-not set})"
  echo "  address:       $host   (HTTPS: $mode$( [ -n "$extra" ] && [ "$extra" != - ] && echo ", also reachable as $extra"))"
  case "$mem" in full) echo "  agent pods:    on (16 GB or more)" ;; small) echo "  agent pods:    off (8 to 16 GB of memory)" ;; *) echo "  agent pods:    off" ;; esac
  echo "steps:"
  echo "  1. checks: Linux x86-64, systemd, root, memory, disk, CPU, ports 80/443/6443, clock, the network"
  if have k3s || [ -n "${KUBECONFIG_ARG:-}" ]; then echo "  2. k3s: the cluster that is here is used"; else echo "  2. install k3s $K3S_VERSION (Traefik keeps visitors' addresses)"; fi
  echo "  3. install helm $HELM_VERSION (if missing), the database operator $CNPG_CHART_VERSION$( [ "$mode" = letsencrypt ] || [ "$mode" = selfsigned ] && echo ", cert-manager $CERT_MANAGER_VERSION")"
  echo "  4. write $ETC/values.yaml (mode 0600) from the release's images by digest"
  echo "  5. helm install the release's chart in the namespace $NS (no --wait; the install waits for the database, server and web itself)"
  echo "  6. make the first administrator (admin first-admin), keep the password in the Secret manythreads-first-admin, print it once"
  echo "  7. install $HOST_COMMAND and write $ETC/install.env"
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
      --chart) shift; chart_arg="${1:-}" ;;
      --public-ip) shift; public_ip="${1:-}" ;;
      --kubeconfig) shift; KUBECONFIG_ARG="${1:-}"; [ -r "$KUBECONFIG_ARG" ] || die "cannot read the kubeconfig $KUBECONFIG_ARG" ;;
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
    print_plan "$pm" "$ph" "$pe" "$want_version" "$release_url" "$class"
    return 0
  fi

  [ "$(id -u)" -eq 0 ] || [ -n "${MANYTHREADS_INSTALL_FOR_TESTS:-}" ] || die "run it as root: put sudo before bash"
  mkdir -p "$(dirname "$LOG")"; touch "$LOG"; chmod 600 "$LOG"; LOG_READY=1
  logline "install.sh started: $*"

  case "$mode" in
    uninstall) uninstall_all "$remove_addons" "$remove_k3s"; return 0 ;;
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
    write_values "$ETC/values.yaml" "$rel" "$tmode" "$thost" "$textra" "$email" staging "$claude" "$ips"
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
      write_values "$ETC/values.yaml" "$rel" selfsigned "$thost" "$textra" "$email" staging "$claude" "$ips2"
      helm_install "$chart"
      settle_letsencrypt || warn "the self-signed certificate is not ready yet"
    fi
  elif [ "$tmode" = selfsigned ]; then
    settle_letsencrypt || warn "the self-signed certificate is not ready yet"
  fi

  wait_ready
  local passfile="$work/first-password"; : >"$passfile"; chmod 600 "$passfile"
  if [ "$mode" = install ]; then make_admin "$email" "$workspace" "$passfile"; fi

  install_host_command "$release_url" "$rel"
  local scheme=https; [ "$tmode" = none ] && scheme=http
  local address="$scheme://$thost" fp=''
  [ "$tmode" != selfsigned ] || fp=$(cert_fingerprint)
  state_put VERSION "$version"; state_put TLS_MODE "$tmode"; state_put HOST "$thost"; state_put ADDRESS "$address"; state_put RELEASE_URL "$release_url"
  [ -z "$fp" ] || state_put CERT_SHA256 "$fp"
  state_put ADMIN_EMAIL "$email"
  print_box "$address" "$email" "$passfile" "$version" "$tmode" "$fp"
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
  say "This removes manythreads from this machine: the release, its database and every team's volumes and apps (the namespaces $NS, ${NS}-bots and apps-*)."
  if [ "${YES:-0}" -eq 1 ]; then word=delete
  elif [ -r /dev/tty ]; then printf 'Type the word delete to go on: ' >/dev/tty; IFS= read -r word </dev/tty || word=''; fi
  [ "$word" = delete ] || die "not removed (the word delete was not typed)"
  if kubectl -n "$NS" get secret manythreads-server-secrets >/dev/null 2>&1 && ask_yes "Print the key that unlocks stored secrets first? (save it before everything is removed)"; then
    "$HOST_COMMAND" backup-key || true
  fi
  helm uninstall "$RELEASE" -n "$NS" >>"$LOG" 2>&1 || true
  local ns
  for ns in "$NS" "${NS}-bots" $(kubectl get ns -o name 2>/dev/null | sed -n 's#^namespace/\(apps-.*\)#\1#p'); do kubectl delete ns "$ns" --ignore-not-found --wait=false >>"$LOG" 2>&1 || true; done
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
