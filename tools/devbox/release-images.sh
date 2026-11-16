#!/usr/bin/env bash
# The release's images (P27-01, docs/deploy/install.md): the images this devbox built are pushed to GHCR by digest, the chart as an OCI artifact, and
# release.json says which. The install script pulls only what release.json names.
#
#   release-images.sh plan     --version 0.27.0 [--tag <server/web tag>] [--owner <ghcr owner>]
#                              prints each image: the local reference to push and the package it goes to. Pushes nothing, needs no token.
#   release-images.sh push     --version 0.27.0 ...   pushes every image, writes .release/digests-<version>.json
#   release-images.sh chart    --version 0.27.0 ...   packages deploy/helm/manythreads and pushes it to oci://ghcr.io/<owner>/charts
#   release-images.sh manifest --version 0.27.0 ...   writes .release/release.json from the digests file and deploy/install/install.sh
#
# `push` and `chart` need a token that can write packages: MANYTHREADS_GHCR_USER and MANYTHREADS_GHCR_TOKEN in the environment (read from there
# only, handed to docker/helm on standard input, never on a command line, never printed). Without them they stop with exit 3 before touching anything.
# The GitHub runner never runs this: the devbox owns the images (docs/deploy.md, "The rule").
#
# Local references: server and web by --tag (the tag deploy.sh made, default the short sha of HEAD); hermes-pod, workbench, claude-pod and asr by the
# newest local tag of manythreads/<name>; the database image by the tag the chart's postgres.image names, in the devbox registry (127.0.0.1:30500).
# The *-fake stand-ins are never published.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RELEASE_DIR=${RELEASE_DIR:-$ROOT/.release}
DOCKER=${DOCKER:-docker}
HELM=${HELM:-helm}

die() { echo "release-images: $*" >&2; exit "${2:-1}"; }

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

COMMAND=${1:-}; [ -n "$COMMAND" ] || usage
shift || true
VERSION=""; TAG=""; OWNER=${MANYTHREADS_GHCR_OWNER:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --tag) TAG=${2:-}; shift 2 ;;
    --owner) OWNER=${2:-}; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown option $1 (see --help)" 2 ;;
  esac
done
case "$COMMAND" in plan|push|chart|manifest) ;; *) usage ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "--version is needed, like 0.27.0" 2
[[ "$OWNER" =~ ^[a-z0-9][a-z0-9-]{0,38}$ ]] || die "the GHCR account is needed: --owner <name> or MANYTHREADS_GHCR_OWNER (lower case)" 2

# The registry-side name of the database image, from the chart: registry.local:5000/<repo>:<tag>@sha256:... -> <repo>:<tag>
pg_ref() {
  sed -n 's#^  image: registry\.local:5000/\(platform/postgres-cnpg:[^@ ]*\).*#\1#p' "$ROOT/deploy/helm/manythreads/values.yaml" | head -n1
}

newest_local() { # <repo> -> the newest local tag of manythreads/<repo> that is not "stable"
  "$DOCKER" images --format '{{.Tag}} {{.CreatedAt}}' "manythreads/$1" 2>/dev/null | grep -v '^stable ' | sort -k2 -r | awk 'NR==1{print $1}'
}

# The table: name|local reference ("" when no local image is found)
resolve() {
  local t="$TAG" pg
  [ -n "$t" ] || t=$(git -C "$ROOT" rev-parse --short=12 HEAD)
  pg=$(pg_ref)
  local name tag
  echo "server|manythreads/server:$t"
  echo "web|manythreads/web:$t"
  echo "postgres-cnpg|${pg:+127.0.0.1:30500/$pg}"
  for name in hermes-pod workbench claude-pod asr; do
    tag=$(newest_local "$name" || true)
    echo "$name|${tag:+manythreads/$name:$tag}"
  done
}

package_of() { echo "ghcr.io/$OWNER/manythreads-$1"; }

need_token() {
  [ -n "${MANYTHREADS_GHCR_USER:-}" ] && [ -n "${MANYTHREADS_GHCR_TOKEN:-}" ] ||
    die "no token: MANYTHREADS_GHCR_USER and MANYTHREADS_GHCR_TOKEN (a token that can write packages) are not both set; nothing was pushed" 3
}

case "$COMMAND" in
  plan)
    echo "release $VERSION to ghcr.io/$OWNER (nothing is pushed by plan)"
    while IFS='|' read -r name ref; do
      if [ -n "$ref" ]; then printf '%-14s %-60s -> %s:%s\n' "$name" "$ref" "$(package_of "$name")" "$VERSION"
      else printf '%-14s %-60s -> %s:%s\n' "$name" "(no local image)" "$(package_of "$name")" "$VERSION"; fi
    done < <(resolve)
    echo "chart          deploy/helm/manythreads                                       -> oci://ghcr.io/$OWNER/charts/manythreads:$VERSION"
    ;;

  push)
    need_token
    mkdir -p "$RELEASE_DIR"
    # Every image must exist locally before anything is pushed: half a release is worse than none.
    missing=()
    while IFS='|' read -r name ref; do
      [ "$name" = asr ] && [ -z "$ref" ] && continue   # asr is off in the install profile; a release may leave it out
      if [ -z "$ref" ] || ! "$DOCKER" image inspect "$ref" >/dev/null 2>&1; then missing+=("$name (${ref:-no local image})"); fi
    done < <(resolve)
    [ ${#missing[@]} -eq 0 ] || die "these images are not built here, so nothing was pushed: ${missing[*]}" 4
    # Sign in to a private docker config, so the devbox's own login is never touched and the token never lands in ~/.docker.
    DOCKER_CONFIG=$(mktemp -d); export DOCKER_CONFIG
    trap 'rm -rf "$DOCKER_CONFIG"' EXIT
    printf '%s' "$MANYTHREADS_GHCR_TOKEN" | "$DOCKER" login ghcr.io -u "$MANYTHREADS_GHCR_USER" --password-stdin >/dev/null || die "ghcr.io refused the sign-in" 5
    out="$RELEASE_DIR/digests-$VERSION.json"; : >"$out.tmp"
    first=true
    echo '{' >"$out.tmp"
    while IFS='|' read -r name ref; do
      [ -n "$ref" ] || continue
      target="$(package_of "$name"):$VERSION"
      echo "--- $ref -> $target"
      "$DOCKER" tag "$ref" "$target"
      log=$("$DOCKER" push "$target" 2>&1) || { echo "$log" | tail -n 5 >&2; die "the push of $name failed" 6; }
      digest=$(printf '%s\n' "$log" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -n1)
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the push of $name printed no digest" 6
      $first || echo ',' >>"$out.tmp"; first=false
      printf '  "%s": "%s"' "$name" "$digest" >>"$out.tmp"
      echo "    $digest"
    done < <(resolve)
    printf '\n}\n' >>"$out.tmp"
    mv "$out.tmp" "$out"
    echo "wrote $out; next: release-images.sh chart, then manifest"
    ;;

  chart)
    need_token
    command -v "$HELM" >/dev/null || die "helm is not installed" 1
    mkdir -p "$RELEASE_DIR"
    reg=$(mktemp -d); export HELM_REGISTRY_CONFIG="$reg/config.json"
    trap 'rm -rf "$reg"' EXIT
    printf '%s' "$MANYTHREADS_GHCR_TOKEN" | "$HELM" registry login ghcr.io -u "$MANYTHREADS_GHCR_USER" --password-stdin >/dev/null || die "ghcr.io refused the sign-in" 5
    "$HELM" package "$ROOT/deploy/helm/manythreads" --version "$VERSION" --app-version "$VERSION" -d "$RELEASE_DIR" >/dev/null
    "$HELM" push "$RELEASE_DIR/manythreads-$VERSION.tgz" "oci://ghcr.io/$OWNER/charts" || die "the chart push failed" 6
    ;;

  manifest)
    digests="$RELEASE_DIR/digests-$VERSION.json"
    [ -f "$digests" ] || die "$digests does not exist: run push first" 4
    install="$ROOT/deploy/install/install.sh"
    [ -f "$install" ] || die "deploy/install/install.sh does not exist" 4
    sha=$(sha256sum "$install" | cut -d' ' -f1)
    node "$ROOT/tools/devbox/release-manifest.mjs" build --version "$VERSION" --owner "$OWNER" --digests "$digests" --install-sha256 "$sha" \
      --commit "$(git -C "$ROOT" rev-parse HEAD)" --out "$RELEASE_DIR/release.json"
    node "$ROOT/tools/devbox/release-manifest.mjs" check "$RELEASE_DIR/release.json"
    echo "wrote $RELEASE_DIR/release.json (attach it and deploy/install/install.sh to the GitHub release)"
    ;;
esac
