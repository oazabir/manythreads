#!/usr/bin/env bash
# disk-guard.sh — the disk checks of deploy.sh (P10-08). Runs ON the devbox.
#
#   disk-guard.sh check [--keep REF]... [--keep-docker REF]...
#       Prints the disk use of /. Above DISK_PRUNE_ABOVE (65 %) it first prunes what is safe and can be made again:
#         docker builder prune -af           (the build cache; -a: without it only dangling cache goes, 0.25 of 20 GB on 2026-11-10)
#         unused docker images               (never an image a container uses, running or stopped; never a --keep / --keep-docker one)
#         k3s crictl rmi --prune             (images no container uses; skipped while a --keep image is already in k3s and not yet in use,
#                                             because the prune would delete the very image this deploy is about to roll out)
#       It never touches volumes, never `docker system prune`, never a running pod's image. Then it looks again: above
#       DISK_STOP_ABOVE (70 %) it STOPS (exit 1) with the biggest items to clean, unless DEPLOY_ALLOW_HIGH_DISK=1 (a loud warning, then on).
#   disk-guard.sh import IMAGE
#       `docker save IMAGE | k3s ctr images import -` with a watch: when the disk use of / reaches DISK_ABORT_IMPORT_AT (88 %) the import
#       is stopped, df is printed and the exit status is 3. (A deploy peaked at 90 % on 2026-11-09 and the kubelet evicted the database.)
#
# Knobs (environment): DISK_PRUNE_ABOVE=65 DISK_STOP_ABOVE=70 DISK_ABORT_IMPORT_AT=88 DISK_WATCH_SECONDS=2 DEPLOY_ALLOW_HIGH_DISK=0
#                      K3S_CONTAINERD_DIR=/var/lib/rancher/k3s/agent/containerd DOCKER_DIR=/var/lib/docker
set -uo pipefail

PRUNE_ABOVE=${DISK_PRUNE_ABOVE:-65}
STOP_ABOVE=${DISK_STOP_ABOVE:-70}
ABORT_AT=${DISK_ABORT_IMPORT_AT:-88}
WATCH_SECONDS=${DISK_WATCH_SECONDS:-2}
K3S_DIR=${K3S_CONTAINERD_DIR:-/var/lib/rancher/k3s/agent/containerd}
DOCKER_DIR=${DOCKER_DIR:-/var/lib/docker}

disk_use() { df --output=pcent / 2>/dev/null | tail -n 1 | tr -dc '0-9'; }
show_disk() { echo "disk: $(df -h / | tail -n 1 | awk '{print $3 " used of " $2 ", " $4 " free, " $5 " in use"}')"; }

prune_docker_images() { # $@ = refs never to remove
  docker image prune -f >/dev/null 2>&1 || true # dangling layers
  local used ref id keep k
  used=$(docker ps -aq 2>/dev/null | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null | sort -u)
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null | while read -r ref id; do
    case "$ref" in *"<none>"*) continue ;; esac
    keep=0
    for k in "$@"; do [ "$ref" = "$k" ] && keep=1; done
    [ "$keep" = 1 ] && continue
    printf '%s\n' "$used" | grep -qxF "$id" && continue # a container uses it
    echo "  removing unused docker image $ref"
    docker rmi "$ref" >/dev/null 2>&1 || true # (docker refuses an image that is still needed)
  done
}

prune_k3s_images() { # $@ = refs of this deploy
  local present k ref
  present=$(k3s ctr -n k8s.io images ls -q 2>/dev/null || true)
  for k in "$@"; do
    for ref in "$k" "docker.io/$k"; do
      if printf '%s\n' "$present" | grep -qxF "$ref"; then
        echo "  k3s image prune skipped: $k is already in k3s and not yet used by a pod, and the prune would delete it"
        return 0
      fi
    done
  done
  k3s crictl rmi --prune >/dev/null 2>&1 || true
}

stop_message() {
  echo "ERROR: the disk is $1% in use after cleaning (the limit for a deploy is ${STOP_ABOVE}%)."
  echo "       free the disk to about 60% before deploying; a deploy peaked at 90% on 2026-11-09 and the node evicted the database."
  echo "The biggest items:"
  echo "--- docker system df"
  docker system df 2>&1 | sed 's/^/    /' || true
  echo "--- du $K3S_DIR (top level)"
  du -xh --max-depth=1 "$K3S_DIR" 2>/dev/null | sort -rh | head -n 10 | sed 's/^/    /' || true
  echo "--- du $DOCKER_DIR (top level)"
  du -xh --max-depth=1 "$DOCKER_DIR" 2>/dev/null | sort -rh | head -n 10 | sed 's/^/    /' || true
  echo "Ideas: docker rmi of copies k3s also holds, 'k3s crictl images' + 'k3s crictl rmi <id>' of images no pod uses, docker builder prune -af."
  echo "(DEPLOY_ALLOW_HIGH_DISK=1 overrides this check at your own risk.)"
}

check() {
  local keep_all=() keep_docker=() use
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --keep) keep_all+=("$2"); shift ;;
      --keep-docker) keep_docker+=("$2"); shift ;;
      *) echo "disk-guard check: unknown argument $1"; return 2 ;;
    esac
    shift
  done
  use=$(disk_use)
  show_disk
  if [ "${use:-0}" -gt "$PRUNE_ABOVE" ]; then
    echo "disk is above ${PRUNE_ABOVE}%: pruning the build cache and images nothing uses (volumes and running pods' images are left alone)"
    docker builder prune -af >/dev/null 2>&1 || true
    prune_docker_images ${keep_all[@]+"${keep_all[@]}"} ${keep_docker[@]+"${keep_docker[@]}"}
    prune_k3s_images ${keep_all[@]+"${keep_all[@]}"}
    use=$(disk_use)
    show_disk
  fi
  if [ "${use:-0}" -gt "$STOP_ABOVE" ]; then
    if [ "${DEPLOY_ALLOW_HIGH_DISK:-0}" = 1 ]; then
      echo "!!!!!!!! WARNING: the disk is ${use}% in use (limit ${STOP_ABOVE}%) and DEPLOY_ALLOW_HIGH_DISK=1 lets the deploy go on."
      echo "!!!!!!!! A deploy peaked at 90% on 2026-11-09 and the node evicted the database. Watch it; the image import aborts at ${ABORT_AT}%."
      return 0
    fi
    stop_message "$use"
    return 1
  fi
  return 0
}

import_image() { # $1 = image
  local img=$1 pid use rc
  # Its own process group (setsid), so one kill stops docker, ctr and tail together.
  setsid bash -c 'set -o pipefail; docker save "$1" | k3s ctr -n k8s.io images import - | tail -n 2' _ "$img" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    use=$(disk_use)
    if [ "${use:-0}" -ge "$ABORT_AT" ]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 0.2
      kill -KILL -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      echo "ERROR: the disk reached ${use}% (limit ${ABORT_AT}%) while importing $img into k3s; the import was stopped."
      df -h / | sed 's/^/    /'
      echo "       free the disk to about 60% before deploying; a deploy peaked at 90% on 2026-11-09 and the node evicted the database."
      return 3
    fi
    sleep "$WATCH_SECONDS"
  done
  wait "$pid"
  rc=$?
  return "$rc"
}

case "${1:-}" in
  check) shift; check "$@" ;;
  import) [ -n "${2:-}" ] || { echo "usage: disk-guard.sh import IMAGE"; exit 2; }; import_image "$2" ;;
  *) echo "usage: disk-guard.sh check [--keep REF]... [--keep-docker REF]... | import IMAGE"; exit 2 ;;
esac
