#!/usr/bin/env bash
# pull.sh: copy a backup set from the cluster to a directory on THIS machine, and check it arrived whole. Run it from a machine that is not the
# server (a laptop, another host, a machine whose disk is backed up elsewhere): a backup on the same disk as the data is not a disaster backup.
#
#   tools/backup/pull.sh --dest /srv/manythreads-backups                  # newest set
#   tools/backup/pull.sh --dest /srv/manythreads-backups --with-secrets   # also the key material (see below)
#
# Options: --dest DIR (required), --set NAME|latest (default latest), --source-ns NS (default the live namespace), --image IMAGE,
#   --with-secrets  also save secret manythreads-server-secrets (and manythreads-s3 if present) as secrets-<namespace>.yaml, mode 600.
#                   The Secret holds the key that unlocks stored provider keys; the database backup is useless for those without it.
#                   Keep that file somewhere more private than the backups.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DEST=""
SET_ARG=latest
SOURCE_NS=$LIVE_NAMESPACE
IMAGE=""
WITH_SECRETS=false
while [ $# -gt 0 ]; do
  case $1 in
    --dest) DEST=${2:?--dest needs a value}; shift 2 ;;
    --set) SET_ARG=${2:?--set needs a value}; shift 2 ;;
    --source-ns) SOURCE_NS=${2:?--source-ns needs a value}; shift 2 ;;
    --image) IMAGE=${2:?--image needs a value}; shift 2 ;;
    --with-secrets) WITH_SECRETS=true; shift ;;
    -h | --help) sed -n '2,/^set -e/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//' >&2; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "$DEST" ] || die "--dest is required"
need kubectl
need sha256sum
mkdir -p "$DEST"

trap cleanup_created EXIT
[ -n "$IMAGE" ] || IMAGE=$(image_of_database "$SOURCE_NS")
[ -n "$IMAGE" ] || die "could not find the database image in $SOURCE_NS; pass --image"
start_reader "$SOURCE_NS" "$IMAGE"
resolve_set "$SET_ARG"
verify_set

if [ -e "$DEST/$SET" ]; then die "$DEST/$SET already exists"; fi
PART="$DEST/.incoming-$SET"
rm -rf "$PART"
mkdir "$PART"
for f in $(reader_sh "cd '$SET_DIR' && ls -1"); do
  info "copying $f"
  kubectl -n "$READER_NS" exec "$READER" -- cat "$SET_DIR/$f" >"$PART/$f"
done
(cd "$PART" && sha256sum -c sha256sums.txt >&2) || { rm -rf "$PART"; die "the copy does not match its checksums; nothing kept"; }
mv "$PART" "$DEST/$SET"
echo "set $SET copied to $DEST/$SET"

if [ "$WITH_SECRETS" = true ]; then
  out="$DEST/secrets-$SOURCE_NS.yaml"
  (
    umask 077
    kubectl -n "$SOURCE_NS" get secret manythreads-server-secrets -o yaml >"$out"
    if kubectl -n "$SOURCE_NS" get secret manythreads-s3 >/dev/null 2>&1; then
      printf -- '---\n' >>"$out"
      kubectl -n "$SOURCE_NS" get secret manythreads-s3 -o yaml >>"$out"
    fi
  )
  echo "key material saved to $out (mode 600): store it apart from the backups"
fi
