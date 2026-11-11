#!/usr/bin/env bash
# Refuses a change that adds a secret, a sign-in file or a public address (owner rule, 2026-11-11: no server credential, IP or auth.json is ever committed or pushed).
#
#   tools/devbox/check-secrets.sh --staged          the staged change (run before each commit)
#   tools/devbox/check-secrets.sh --range A..B      every commit in a range, patch by patch (run before each push: origin/main..HEAD)
#   tools/devbox/check-secrets.sh --install         makes a pre-commit and a pre-push hook in this checkout that call it
#
# It reads only the lines a change ADDS. It prints the file, the line number and the kind of finding, never the value. It also looks for the exact values
# of the passwords in ~/manythreads.passwords.env (and of any file in $MANYTHREADS_SECRET_FILES, space separated) without printing them.
# Public addresses that were already tracked before the rule are listed in tools/devbox/secret-allowlist.txt as the sha256 of "path|address" (so the file does not
# repeat them); do not add to it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "${1:-}" = "--install" ]; then
  for hook in pre-commit pre-push; do
    flag="--staged"; [ "$hook" = "pre-push" ] && flag="--range origin/main..HEAD"
    printf '#!/usr/bin/env bash\nexec "$(git rev-parse --show-toplevel)/tools/devbox/check-secrets.sh" %s\n' "$flag" > ".git/hooks/$hook"
    chmod +x ".git/hooks/$hook"
  done
  echo "Installed .git/hooks/pre-commit and .git/hooks/pre-push."
  exit 0
fi

case "${1:-}" in
  --staged) patch() { git diff --cached -U0 --no-color; } ;;
  --range) range="${2:-}"; [ -n "$range" ] || { echo "usage: $0 --range A..B" >&2; exit 2; }; patch() { git log -p -U0 --no-color --format= "$range"; } ;;
  *) echo "usage: $0 --staged | --range A..B | --install" >&2; exit 2 ;;
esac

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# The exact secret values of this machine, one per line, in a private file (never printed).
vals="$work/values"; : > "$vals"; chmod 600 "$vals"
for f in "$HOME/manythreads.passwords.env" ${MANYTHREADS_SECRET_FILES:-}; do
  [ -f "$f" ] || continue
  sed -E 's/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=//; s/^["'"'"']//; s/["'"'"']$//' "$f" | awk 'length($0) >= 8' >> "$vals"
done

# Added lines, tagged with "file:line".
patch | awk '
  /^diff --git / { file=$4; sub(/^b\//,"",file); next }
  /^\+\+\+ / { next }
  /^@@ / { match($0, /\+[0-9]+/); line=substr($0, RSTART+1, RLENGTH-1)+0; next }
  /^\+/ { print file ":" line "\t" substr($0,2); line++ }
' > "$work/added"

found=0
report() { echo "BLOCKED  $1  ($2)"; found=1; }

while IFS=$'\t' read -r where text; do
  case "$text" in *secret-scan:ignore*) continue ;; esac
  if   [[ "$text" =~ (sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}) ]];                 then report "$where" "an API key"
  elif [[ "$text" =~ (ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,} ]];                        then report "$where" "a GitHub token"
  elif [[ "$text" =~ (xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}) ]];                        then report "$where" "a cloud or chat token"
  elif [[ "$text" =~ BEGIN[[:space:]A-Z]*PRIVATE[[:space:]]KEY ]];                              then report "$where" "a private key"
  elif [[ "$text" =~ rt\.[0-9]\.[A-Za-z0-9_-]{20,} ]];                                         then report "$where" "a Codex refresh token"
  elif [[ "$text" =~ eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,} ]];        then report "$where" "a signed token (JWT)"
  elif [[ "$text" =~ \"(refresh_token|access_token|id_token|OPENAI_API_KEY|ANTHROPIC_API_KEY)\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9._-]{24,}\" ]]; then report "$where" "a sign-in file value"
  elif [[ "$text" =~ (^|[^A-Za-z0-9_])(password|passwd|secret|api_?key|token)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*[\"\']?[A-Za-z0-9+/_.-]{20,}[\"\']?[[:space:]]*$ ]] \
       && ! [[ "$text" =~ (process\.env|\$\{|\$[A-Z_]+|example|placeholder|fake|stand-in|test|dummy|xxxx|REPLACE|<) ]]; then report "$where" "a credential assignment"
  fi
  # Public IPv4 addresses (private, loopback, link-local, documentation and 0.0.0.0 ranges are fine).
  while [[ "$text" =~ ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}) ]]; do
    ip="${BASH_REMATCH[1]}"; text="${text#*"$ip"}"
    IFS=. read -r a b c d <<<"$ip"
    for o in "$a" "$b" "$c" "$d"; do [ "$o" -le 255 ] 2>/dev/null || continue 2; done
    case "$a" in 0|10|127) continue ;; esac
    [ "$a" = 169 ] && [ "$b" = 254 ] && continue
    [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && continue
    [ "$a" = 192 ] && [ "$b" = 168 ] && continue
    [ "$a" = 192 ] && [ "$b" = 0 ] && [ "$c" = 2 ] && continue
    [ "$a" = 198 ] && [ "$b" = 51 ] && [ "$c" = 100 ] && continue
    [ "$a" = 203 ] && [ "$b" = 0 ] && [ "$c" = 113 ] && continue
    [ "$a" -ge 224 ] && continue
    # a dotted version number inside a package pin is not an address
    [[ "${where}" == *package.json* || "${where}" == *lock* || "${where}" == *.json:* ]] && continue
    grep -qxF "$(printf '%s' "${where%%:*}|$ip" | sha256sum | cut -d" " -f1)" tools/devbox/secret-allowlist.txt 2>/dev/null && continue
    report "$where" "a public address"
  done
done < "$work/added"

# The exact values of this machine's passwords and keys.
if [ -s "$vals" ] && cut -f2- "$work/added" | grep -qFf "$vals"; then
  while IFS=$'\t' read -r where text; do
    printf '%s\n' "$text" | grep -qFf "$vals" && report "$where" "a value from the machine's secret files"
  done < "$work/added"
fi

# Files that must never be tracked.
names="$(patch | grep -E '^\+\+\+ b/' | sed 's#^+++ b/##')"
while IFS= read -r n; do
  case "$n" in
    "") ;;
    *auth.json|*/.codex/*|*/.claude/.credentials*|*.credentials.json|*passwords.env|*.pem|*id_rsa*|*id_ed25519*|.env|*/.env) report "$n" "a file that holds a sign-in or a key" ;;
  esac
done <<<"$names"

if [ "$found" = 1 ]; then
  echo "Nothing was committed or pushed. Remove the value (use an environment variable or a Secret), or add the comment 'secret-scan:ignore' on a line that is a harmless fixture." >&2
  exit 1
fi
echo "check-secrets: nothing found."
