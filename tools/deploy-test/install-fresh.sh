#!/usr/bin/env bash
# install-fresh.sh: the one-command installer (deploy/install/install.sh) on a brand-new machine (PLAN P27-21).
#
#   flock /tmp/manythreads-test.lock tools/deploy-test/install-fresh.sh --release-json FILE --chart DIR [--memory 12g] [--tls selfsigned]
#   tools/deploy-test/install-fresh.sh --print-steps                      # prints what it would do, changes nothing
#
# What it does:
#   1. refuses to start while the disk is more than 85 % full, memory is short, a CI run (tools/devbox/ci.sh) or a stage is up, another copy runs, or a file it needs
#      is missing (the release.json must pass tools/devbox/release-manifest.mjs --check, and every image in it must be reachable by the machine, so this is for a release
#      that is already pushed, or for images served from a registry the machine can reach);
#   2. starts a systemd Ubuntu container (the recipe of docs/spikes/install-measured.md: --privileged, --cgroupns=private, cgroup2 mounted fresh, the k3s state folders
#      on Docker volumes, its own Docker network, a memory limit), installs curl, jq and openssl in it;
#   3. copies install.sh, the host command, the release.json and the chart in and runs `install.sh --release-url FILE --chart DIR` as root, with the answers given here;
#   4. checks: `manythreads status` works, /readyz answers 200 through HTTPS, the first administrator signs in with the printed password and is made to choose a new one
#      (mustChangePassword), `manythreads doctor` has no failure, a second run says "already installed", and `install.sh --uninstall --remove-k3s` leaves no k3s behind;
#   5. removes the container, the network, the volumes and the files it wrote, whatever the outcome. It never touches the host's own cluster or any live namespace.
# Exit code 0 only when every check passed. The log is K3S_FRESH_LOG-style: INSTALL_FRESH_LOG (default /tmp/install-fresh.log).
#
# Settings (environment): INSTALL_FRESH_IMAGE (default jrei/systemd-ubuntu:24.04), INSTALL_FRESH_MAX_DISK (percent, default 85), INSTALL_FRESH_KEEP=1 (leave it in place;
# remove it with `docker rm -fv` and `docker network rm`).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
cd "$REPO"

IMAGE=${INSTALL_FRESH_IMAGE:-jrei/systemd-ubuntu:24.04}
MAX_DISK=${INSTALL_FRESH_MAX_DISK:-85}
MEMORY=12g
TLS=selfsigned
RELEASE_JSON=''
CHART=''
PRINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release-json) shift; RELEASE_JSON="${1:-}" ;;
    --chart) shift; CHART="${1:-}" ;;
    --memory) shift; MEMORY="${1:-}" ;;
    --tls) shift; TLS="${1:-}" ;;
    --print-steps) PRINT=1 ;;
    -h|--help) sed -n '2,/^set -e/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

STEPS=(
  "start a systemd container ($IMAGE, --privileged, --cgroupns=private, volumes for /var/lib/rancher/k3s and /var/lib/kubelet, --memory $MEMORY)"
  "install curl, jq and openssl in it"
  "copy install.sh, manythreads, release.json and the chart into it"
  "install.sh --release-url <release.json> --chart <chart> --tls $TLS --admin-email install-test@example.org"
  "check: manythreads status; /readyz 200 over HTTPS; the first administrator signs in and must choose a new password; manythreads doctor"
  "check: a second run of install.sh says 'already installed'"
  "check: install.sh --uninstall --yes --remove-k3s leaves no k3s and no /etc/manythreads"
  "remove the container, network, volumes and files"
)
if [ "$PRINT" = 1 ]; then printf '%s\n' "${STEPS[@]}" | nl -w2 -s'. '; exit 0; fi

LOG=${INSTALL_FRESH_LOG:-/tmp/install-fresh.log}
exec > >(tee "$LOG") 2>&1

NAME="mt-install-fresh-$$"
NET="$NAME"
VOL_K3S="$NAME-k3s"
VOL_KUBELET="$NAME-kubelet"
WORK=""
STARTED=$(date +%s)
RESULT=FAILED

say() { printf '\n[%s +%ss] %s\n' "$(date -u +%H:%M:%S)" "$(( $(date +%s) - STARTED ))" "$*"; }
die() { say "REFUSED: $*"; exit 2; }
fail() { say "CHECK FAILED: $*"; exit 1; }
disk_percent() { df --output=pcent / | tail -n 1 | tr -dc '0-9'; }
avail_mb() { free -m | awk '/^Mem:/ {print $7}'; }
mem_mb() { # 12g -> 12288
  case "$1" in *g|*G) echo $(( ${1%[gG]} * 1024 )) ;; *m|*M) echo "${1%[mM]}" ;; *) echo 0 ;; esac
}
inside() { docker exec -i "$NAME" "$@"; }

# --- 1. preconditions -------------------------------------------------------------------------------------------------------------------------------------------
for tool in docker curl jq node; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
[ -n "$RELEASE_JSON" ] && [ -r "$RELEASE_JSON" ] || die "give --release-json FILE (the release.json of a pushed release)"
[ -n "$CHART" ] && [ -f "$CHART/Chart.yaml" ] || die "give --chart DIR (a chart folder, for example deploy/helm/manythreads)"
[ "$(mem_mb "$MEMORY")" -ge 7400 ] || die "--memory must be 8g or more (the installer itself refuses a machine under 7400 MB)"
[ "$(disk_percent)" -lt "$MAX_DISK" ] || die "the disk is $(disk_percent) % full (the limit is $MAX_DISK %); free some space first"
[ "$(avail_mb)" -ge $(( $(mem_mb "$MEMORY") + 2048 )) ] || die "only $(avail_mb) MB of memory is free; this test needs its $MEMORY plus 2 GB for the rest of the machine"
if pgrep -fx 'bash tools/devbox/ci.sh.*' >/dev/null 2>&1; then die "a CI run (tools/devbox/ci.sh) is in progress; it shares this machine"; fi
if docker ps -a --format '{{.Names}}' | grep -q '^mt-install-fresh-'; then die "another install-fresh container exists; remove it first"; fi
if docker ps -a --format '{{.Names}}' | grep -q '^mt-k3s-fresh-'; then die "a k3s-fresh container is up; it shares this machine"; fi
# One read-only look at the machine's own cluster: a stage in it means a test of someone else is using this machine's memory.
if command -v kubectl >/dev/null && kubectl --request-timeout=10s get namespace manythreads-stage -o name >/dev/null 2>&1; then die "a stage is up (namespace manythreads-stage); run stage.sh down first"; fi
node tools/devbox/release-manifest.mjs check "$RELEASE_JSON" >/dev/null 2>&1 || die "$RELEASE_JSON does not pass tools/devbox/release-manifest.mjs check"

DISK_BEFORE=$(disk_percent)
IMAGES_BEFORE=$(docker images -q --no-trunc | sort -u)
say "start: disk ${DISK_BEFORE} %, free memory $(avail_mb) MB, base image $IMAGE"

# --- 5. clean-up, registered first so every later failure still runs it -------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  set +e
  if [ "${INSTALL_FRESH_KEEP:-}" = 1 ]; then
    say "INSTALL_FRESH_KEEP=1: leaving container $NAME, network $NET, volumes $VOL_K3S $VOL_KUBELET and $WORK in place"
    return
  fi
  say "clean-up"
  docker rm -fv "$NAME" >/dev/null 2>&1
  docker volume rm -f "$VOL_K3S" "$VOL_KUBELET" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  [ -z "$WORK" ] || rm -rf "$WORK"
  local now id
  now=$(docker images -q --no-trunc | sort -u)
  for id in $(comm -13 <(printf '%s\n' "$IMAGES_BEFORE") <(printf '%s\n' "$now")); do docker rmi -f "$id" >/dev/null 2>&1; done
  docker builder prune -f --keep-storage 3gb >/dev/null 2>&1
  say "$RESULT. disk ${DISK_BEFORE} % before, $(disk_percent) % after; log: $LOG"
  return "$code"
}
trap cleanup EXIT

# --- 2. the machine ---------------------------------------------------------------------------------------------------------------------------------------------
WORK=$(mktemp -d /tmp/mt-install-fresh.XXXXXX)
say "start the container $NAME"
docker network create "$NET" >/dev/null
docker volume create "$VOL_K3S" >/dev/null
docker volume create "$VOL_KUBELET" >/dev/null
# k3s inside Docker: its state folders on volumes (an overlay cannot be mounted over an overlay), its own cgroup namespace with cgroup2 mounted fresh (never the host's
# /sys/fs/cgroup: the inner kubelet would put its pods in the host's cgroup root), systemd as the first process.
docker run -d --name "$NAME" --hostname "$NAME" --privileged --cgroupns=private --network "$NET" --memory "$MEMORY" \
  -v "$VOL_K3S:/var/lib/rancher/k3s" -v "$VOL_KUBELET:/var/lib/kubelet" --tmpfs /run --tmpfs /run/lock \
  "$IMAGE" bash -c 'umount /sys/fs/cgroup 2>/dev/null; mount -t cgroup2 none /sys/fs/cgroup; exec /sbin/init' >/dev/null
for _ in $(seq 1 60); do
  state=$(inside systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break ;; esac
  sleep 2
done
case "${state:-}" in running|degraded) ;; *) docker logs --tail 30 "$NAME" || true; die "systemd in the container did not come up in 2 minutes" ;; esac

say "install curl, jq and openssl in it"
inside bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl jq openssl ca-certificates iproute2 >/dev/null'

# --- 3. the install ---------------------------------------------------------------------------------------------------------------------------------------------
say "copy the installer, the host command, the release and the chart in"
inside mkdir -p /root/inst
docker cp deploy/install/install.sh "$NAME:/root/inst/install.sh"
docker cp deploy/install/manythreads "$NAME:/root/inst/manythreads"
# the host command beside it is this tree's copy: the release's hash for it is replaced by that copy's (a release built from another tree would otherwise stop the install)
jq --arg h "$(sha256sum deploy/install/manythreads | cut -d' ' -f1)" '.hostCommandSha256 = $h' "$RELEASE_JSON" >"$WORK/release.json"
docker cp "$WORK/release.json" "$NAME:/root/inst/release.json"
docker cp "$CHART" "$NAME:/root/inst/chart"
say "run install.sh"
inside bash -c "cd /root/inst && bash install.sh --release-url /root/inst/release.json --chart /root/inst/chart --tls $TLS --admin-email install-test@example.org" | tee "$WORK/install.out"

# --- 4. the checks ----------------------------------------------------------------------------------------------------------------------------------------------
say "check: status"
inside manythreads status | tee "$WORK/status.out"
grep -q 'Running' "$WORK/status.out" || fail "manythreads status shows no running pod"

say "check: /readyz over HTTPS"
code=$(inside curl -sk -o /dev/null -w '%{http_code}' "$(inside manythreads url)/readyz")
[ "$code" = 200 ] || fail "/readyz answered $code"

say "check: the first administrator signs in and must choose a new password"
pass=$(inside manythreads admin-password | tr -d '\r' | awk '/^[A-Za-z0-9]{20,}$/ {print; exit}')
[ -n "$pass" ] || fail "manythreads admin-password printed no password"
url=$(inside manythreads url)
body=$(jq -n --arg e install-test@example.org --arg p "$pass" '{email:$e,password:$p}')
session=$(printf '%s' "$body" | inside curl -sk -c /tmp/jar -H 'content-type: application/json' --data-binary @- "$url/api/auth/password/sign-in")
printf '%s' "$session" | jq -e '.mustChangePassword == true' >/dev/null || fail "the sign-in did not say mustChangePassword: $session"

say "check: doctor"
inside manythreads doctor | tee "$WORK/doctor.out"
if grep -qi 'FAIL' "$WORK/doctor.out"; then fail "manythreads doctor reports a failure"; fi

say "check: a second run says already installed"
again=$(inside bash -c "cd /root/inst && bash install.sh --release-url /root/inst/release.json --chart /root/inst/chart --tls $TLS --admin-email install-test@example.org" 2>&1 || true)
printf '%s\n' "$again" | grep -qi 'already installed' || fail "the second run did not say 'already installed': $again"

say "check: uninstall"
inside bash -c "cd /root/inst && bash install.sh --uninstall --yes --remove-k3s" >/dev/null 2>&1 || true
inside test ! -e /etc/manythreads || fail "/etc/manythreads is still there after --uninstall"
inside test ! -e /usr/local/bin/k3s || fail "k3s is still there after --uninstall --remove-k3s"

RESULT=PASSED
say "all checks passed"
