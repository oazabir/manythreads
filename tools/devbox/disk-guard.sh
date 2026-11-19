#!/usr/bin/env bash
# disk-guard.sh — the disk checks of deploy.sh (P10-08). Runs ON the devbox.
#
#   disk-guard.sh check [--keep REF]... [--keep-docker REF]...
#       Prints the disk use of /. Above DISK_PRUNE_ABOVE (75 %) it first prunes what is safe and can be made again:
#         docker builder prune -af --keep-storage DISK_KEEP_BUILD_CACHE (5gb)
#                                            (the build cache down to the most recently used 5 GB: the dependency install layers of the server and web
#                                             images live there, and a source-only deploy reuses them (P31-05); a full wipe made every deploy a full build)
#         unused docker images               (never an image a container uses, running or stopped; never a --keep / --keep-docker one)
#         unused k3s images, one by one      (never an image a container uses, running or stopped (matched by image id, so an image run by digest
#                                             only, like Postgres, is kept), never a --keep one, never the pods' sandbox (pause) image, never registry.local:5000/platform/* or hermes:stable;
#                                             skipped when the containers or the images cannot be read)
#       It never touches volumes, never `docker system prune`, never a running pod's image. Then it looks again: above
#       DISK_STOP_ABOVE (90 %, owner 2026-11-19) it STOPS (exit 1) with the biggest items to clean, unless DEPLOY_ALLOW_HIGH_DISK=1 (a loud warning, then on).
#   disk-guard.sh import IMAGE
#       `docker save IMAGE | k3s ctr images import -` with a watch: when the disk use of / reaches DISK_ABORT_IMPORT_AT (95 %, owner 2026-11-19; the kubelet evicts from 95 %) the import
#       is stopped, df is printed and the exit status is 3. (A deploy peaked at 90 % on 2026-11-09 and the kubelet evicted the database.)
#
# Knobs (environment): DISK_PRUNE_ABOVE=75 DISK_STOP_ABOVE=90 DISK_ABORT_IMPORT_AT=95 DISK_KEEP_BUILD_CACHE=5gb DISK_WATCH_SECONDS=2 DEPLOY_ALLOW_HIGH_DISK=0
#                      K3S_CONTAINERD_DIR=/var/lib/rancher/k3s/agent/containerd DOCKER_DIR=/var/lib/docker
set -uo pipefail

PRUNE_ABOVE=${DISK_PRUNE_ABOVE:-75}
STOP_ABOVE=${DISK_STOP_ABOVE:-90}
ABORT_AT=${DISK_ABORT_IMPORT_AT:-95}
WATCH_SECONDS=${DISK_WATCH_SECONDS:-2}
KEEP_BUILD_CACHE=${DISK_KEEP_BUILD_CACHE:-5gb}
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

prune_k3s_images() { # $@ = refs never to remove (this deploy's images)
  local work ids id
  work=$(mktemp -d) || return 0
  # Both lists or nothing: a prune that cannot see what runs must not guess.
  if ! k3s crictl ps -a -o json >"$work/ps.json" 2>/dev/null || ! k3s crictl images -o json >"$work/images.json" 2>/dev/null; then
    echo "  k3s image prune skipped: the containers or the images could not be read"
    rm -rf "$work"; return 0
  fi
  k3s crictl info >"$work/info.json" 2>/dev/null || echo '{}' >"$work/info.json"
  ids=$(python3 - "$work/ps.json" "$work/images.json" "$work/info.json" "$@" <<'PY'
import json, sys
ps, imgs, info, keep = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
try:
    cfg = json.load(open(info)).get("config") or {}
    sandbox = cfg.get("sandboxImage") or cfg.get("sandbox_image") or ""
except Exception:
    sandbox = ""
try:
    containers = json.load(open(ps)).get("containers") or []
    images = json.load(open(imgs)).get("images") or []
except Exception:
    sys.exit(0)
used = set()
for c in containers:
    for v in (c.get("imageRef"), (c.get("image") or {}).get("image")):
        if v:
            used.add(v)
keep_refs = set()
for k in keep:
    keep_refs.update({k, "docker.io/" + k})
for i in images:
    names = (i.get("repoTags") or []) + (i.get("repoDigests") or [])
    # the pods' sandbox (pause) image: no container names it, and without it no pod starts (k3s does not always mark it pinned)
    if i.get("pinned") or any(n == sandbox or n == "docker.io/" + sandbox or "/pause:" in n or "pause@" in n for n in names):
        continue
    if i.get("id") in used or any(d.split("@", 1)[-1] in used for d in names if "@" in d):
        continue
    if any(n in keep_refs for n in names):
        continue
    if any(n.startswith("registry.local:5000/platform/") or n.endswith("/manythreads/hermes:stable") or n == "manythreads/hermes:stable" for n in names):
        continue
    print(i.get("id", ""), " ".join(names) or "<none>")
PY
)
  rm -rf "$work"
  [ -n "$ids" ] || return 0
  while read -r id names; do
    [ -n "$id" ] || continue
    echo "  removing unused k3s image $names"
    k3s crictl rmi "$id" >/dev/null 2>&1 || true
  done <<<"$ids"
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
    echo "disk is above ${PRUNE_ABOVE}%: pruning the build cache down to ${KEEP_BUILD_CACHE} and images nothing uses (volumes and running pods' images are left alone)"
    docker builder prune -af --keep-storage "$KEEP_BUILD_CACHE" >/dev/null 2>&1 || true
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
