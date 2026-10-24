#!/usr/bin/env bash
# publish-screenshots.sh — runs ON the devbox. Copies temp/screenshots/ (pictures only) into the web pod's screenshot volume and
# rebuilds the gallery page, so https://manythreads.kahf.to/screenshots/index.html shows them. The gallery is PUBLIC: it lists
# whatever is in the folder, so only put pictures there that anyone may see (no secrets, no real people's data).
# Usage: tools/devbox/publish-screenshots.sh [folder]      (default: temp/screenshots; add --keep to not clear older pictures)
set -euo pipefail
cd "$(dirname "$0")/../.."
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
NS="${NAMESPACE:-manythreads}"
KEEP=false; SRC=""
for a in "$@"; do case "$a" in --keep) KEEP=true ;; *) SRC="$a" ;; esac; done
SRC="${SRC:-temp/screenshots}"
[ -d "$SRC" ] || { echo "no folder $SRC" >&2; exit 2; }
shopt -s nullglob
files=("$SRC"/*.png "$SRC"/*.jpg "$SRC"/*.jpeg "$SRC"/*.webp "$SRC"/*.gif)
[ "${#files[@]}" -gt 0 ] || { echo "no pictures in $SRC" >&2; exit 2; }

STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp -- "${files[@]}" "$STAGE"/
python3 - "$STAGE" <<'PY'
import html, os, sys, time
d = sys.argv[1]
names = sorted(n for n in os.listdir(d) if n != 'index.html')
figs = ''.join(
    f'<figure><a href="{html.escape(n)}"><img src="{html.escape(n)}" alt="{html.escape(n)}" loading="lazy"></a>'
    f'<figcaption>{html.escape(n)}</figcaption></figure>' for n in names)
page = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  '<title>manythreads screenshots</title><style>'
  'body{font-family:system-ui,sans-serif;margin:24px;background:rgb(245,245,244);color:rgb(28,28,30)}'
  'h1{font-size:18px}p{font-size:13px;color:rgb(90,90,92)}'
  'figure{display:inline-block;vertical-align:top;margin:8px;background:rgb(255,255,255);padding:8px;border:1px solid rgb(222,222,218);border-radius:6px}'
  'img{max-width:640px;width:100%;display:block}figcaption{font-size:12px;color:rgb(90,90,92);margin-top:6px}'
  f'</style></head><body><h1>manythreads screenshots</h1><p>{len(names)} pictures, updated {time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())}.</p>{figs}</body></html>')
open(os.path.join(d, 'index.html'), 'w').write(page)
PY

POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=web -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')
[ -n "$POD" ] || { echo "no running web pod in $NS" >&2; exit 1; }
[ "$KEEP" = true ] || kubectl -n "$NS" exec "$POD" -c web -- sh -c 'find /srv/screenshots -mindepth 1 -maxdepth 1 -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.webp" -o -name "*.gif" -o -name index.html \) -delete'
chmod -R u=rwX,go=rX "$STAGE"   # nginx's worker is not root: the files must be world-readable
tar -C "$STAGE" -cf - . | kubectl -n "$NS" exec -i "$POD" -c web -- tar -C /srv/screenshots --no-same-owner -xf -
kubectl -n "$NS" exec "$POD" -c web -- chmod -R a+rX /srv/screenshots
echo "published $(ls "$STAGE" | wc -l) files to $POD:/srv/screenshots"
curl -fsS -o /dev/null -w "https://manythreads.kahf.to/screenshots/index.html -> HTTP %{http_code}\n" https://manythreads.kahf.to/screenshots/index.html || true
