#!/usr/bin/env bash
# Contact sheet of up to 12 pictures with their file names (PLAN P13-03, decision E35: Playwright's Chromium, no ImageMagick).
#   tools/review/contact-sheet.sh <out.png> "<persona · viewport · sheet n of m>" <picture.png>…
set -euo pipefail
if [ "$#" -lt 3 ]; then
  echo "usage: contact-sheet.sh <out.png> \"<persona · viewport · sheet n of m>\" <picture.png>… (at most 12)" >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$1"
TITLE="$2"
shift 2
exec "$HERE/../../node_modules/.bin/tsx" "$HERE/contact-sheet.ts" --title "$TITLE" --out "$OUT" "$@"
