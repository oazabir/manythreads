#!/bin/bash
# Publishes a card's tested branch: pushes `card-<8 characters of the card id>` of a repository of record to the project's origin and opens a pull
# request there (a person merges it in GitHub: that merge is the approval). Run by a bot as the `repo` user, through sudo, like mt-receive-pack.sh, so
# the bot never reads the token: it lives in /run/mt-push/<project>, 0400 and owned by `repo` (mt-push-sync.sh puts it there; a JSON document of the
# token and the repository address it was issued for). Only bots whose definition grants `tasks.pull_request` are in the `publishers` group that sudo allows.
#
#   sudo -u repo mt-publish.sh check   <project>
#       exit 0 and "ready" when the project has an origin and a token issued for that very origin; exit 3 and "no push credential" otherwise.
#   sudo -u repo mt-publish.sh publish <project> <card id> <tested commit> <title>      (the pull request's text on standard input)
#       refuses unless the branch head IS the tested commit; pushes the branch (never main, never a force push); opens the pull request, or finds the
#       open one of that branch; prints  pull_request_number=N  and  pull_request_url=...  and  head_sha=... .
#
# Exit codes: 0 done, 2 refused (bad input, not a repository of record), 3 no credential, 4 the branch is not at the tested commit, 5 push refused,
# 6 GitHub refused or did not answer. The token is passed to git through GIT_ASKPASS and to curl through a header read from standard input, never in an
# argument, and it is masked in everything this script prints.
#
# MT_REPOS_DIR / MT_PUSH_DIR / MT_REPO_USER / MT_GITHUB_API / MT_PUSH_URL are test hooks (a local bare "origin" and a local double of GitHub). A bot cannot set
# them: sudo clears the environment and allows only the two command shapes above.
set -euo pipefail
REPOS="${MT_REPOS_DIR:-/workspace/repos}"
PUSHDIR="${MT_PUSH_DIR:-/run/mt-push}"
RUSER="${MT_REPO_USER:-repo}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { local code="$1"; shift; echo "$*" >&2; exit "$code"; }

mode="${1:-}"; project="${2:-}"
[[ "$project" =~ ^[a-z0-9][a-z0-9._-]{0,60}$ ]] && [[ "$project" != *..* ]] || die 2 "bad project name"
dir="$REPOS/$project.git"
[ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(realpath -e "$dir")" = "$(realpath -m "$REPOS")/$project.git" ] || die 2 "no such repository of record"
[ "$(stat -c %U "$dir")" = "$RUSER" ] || die 2 "repository is not owned by $RUSER"
tokenfile="$PUSHDIR/$project"
have_token() { [ -f "$tokenfile" ] && [ ! -L "$tokenfile" ] && [ "$(stat -c %U "$tokenfile")" = "$RUSER" ] && [ -s "$tokenfile" ]; }
# the token counts only for the address it was issued for: if the project moved to another repository, the old token is refused here
token_matches_origin() { [ -n "$origin" ] && [ "$(jq -r '.origin // empty' -- "$tokenfile" 2>/dev/null)" = "$origin" ] && [ -n "$(jq -r '.token // empty' -- "$tokenfile" 2>/dev/null)" ] && [ -n "$(jq -r '.branch // empty' -- "$tokenfile" 2>/dev/null)" ]; }

origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
# The origin must be plain https (the same rule as mt-repo-create.sh) and name exactly <host>/<owner>/<repo>.
plain() { [[ "$1" =~ ^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*/?$ ]]; }
parse_origin() {
  plain "$origin" || return 1
  local rest="${origin#https://}" path
  ohost="${rest%%/*}"; path="${rest#*/}"; path="${path%/}"; path="${path%.git}"
  oowner="${path%%/*}"; orepo="${path#*/}"
  [[ "$oowner" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] && [[ "$orepo" =~ ^[A-Za-z0-9._-]{1,100}$ ]] && [ "$orepo" != . ] && [ "$orepo" != .. ] || return 1
  ohost="$(printf '%s' "$ohost" | tr 'A-Z' 'a-z')"
}

case "$mode" in
  check)
    [ "$#" -eq 2 ] || die 2 "usage: mt-publish.sh check <project>"
    if [ -n "$origin" ] && parse_origin && have_token && token_matches_origin; then echo ready; exit 0; fi
    echo "no push credential"; exit 3 ;;
  publish) ;;
  *) die 2 "usage: mt-publish.sh check <project> | publish <project> <card id> <tested commit> <title>" ;;
esac

[ "$#" -eq 5 ] || die 2 "usage: mt-publish.sh publish <project> <card id> <tested commit> <title>"
card="$3"; sha="$4"; title="$5"
[[ "$card" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die 2 "bad card id"
[[ "$sha" =~ ^[0-9a-f]{7,64}$ ]] || die 2 "bad commit"
[ "${#title}" -ge 1 ] && [ "${#title}" -le 200 ] && [[ "$title" != *$'\n'* ]] || die 2 "the title is one line of 1 to 200 characters"
have_token && token_matches_origin || die 3 "no push credential"
[ -n "$origin" ] && parse_origin || die 2 "the repository's origin is not a plain https GitHub address"
token="$(jq -r '.token' -- "$tokenfile")"
mask() { local t; t="$(cat)"; printf '%s\n' "${t//"$token"/***}"; }

branch="card-${card:0:8}"
# the branch a pull request is aimed at is the project's main branch, as the token was issued for it (not whatever the repository's HEAD says)
base="$(jq -r '.branch' -- "$tokenfile")"
[[ "$base" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ ]] && [ "$branch" != "$base" ] || die 2 "cannot tell the project's main branch"
head="$(git -C "$dir" rev-parse --verify -q "refs/heads/$branch^{commit}" || true)"
[ -n "$head" ] || die 4 "the branch $branch is not in the repository of record: push it first"
tested="$(git -C "$dir" rev-parse --verify -q "$sha^{commit}" || true)"
[ -n "$tested" ] && [ "$tested" = "$head" ] || die 4 "the branch $branch is at ${head:0:12}, not at the tested commit ${sha:0:12}: test the branch head again"

# Push the one branch, as a plain (never forced) push of the exact commit. A branch that already exists on the origin elsewhere is refused by the origin.
export GIT_ASKPASS="$HERE/mt-askpass.sh" MT_TOKEN_FILE="$tokenfile" GIT_TERMINAL_PROMPT=0
pushurl="${MT_PUSH_URL:-$origin}"
if ! out="$(git -C "$dir" -c credential.helper= push --no-verify "$pushurl" "$head:refs/heads/$branch" 2>&1)"; then
  printf '%s\n' "$out" | mask >&2
  die 5 "the push of $branch to the origin was refused"
fi

if [ -n "${MT_GITHUB_API:-}" ]; then api="$MT_GITHUB_API"
elif [ "$ohost" = github.com ]; then api="https://api.github.com"
else api="https://$ohost/api/v3"; fi
repo_api="$api/repos/$oowner/$orepo/pulls"
gh() {  # gh <method> <url> [data file]: the token goes in a header read from stdin, the answer's body to stdout, the status on the last line
  local method="$1" url="$2" data="${3:-}"
  local args=(-sS --max-time 30 -X "$method" -H @- -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: manythreads-mt-publish' -w '\n%{http_code}')
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data-binary "@$data")
  printf 'Authorization: Bearer %s\n' "$token" | curl "${args[@]}" "$url"
}

# GitHub moves an open pull request to a freshly pushed head a moment after the push is accepted, so a head that is not yet ours is asked for again
# (up to thirty times, two seconds apart; MT_PR_TRIES and MT_PR_WAIT are test hooks) before it counts as a pull request at another commit.
tries="${MT_PR_TRIES:-30}"
while :; do
  existing="$(gh GET "$repo_api?head=$oowner:$branch&base=$base&state=open" 2>&1 || true)"
  status="${existing##*$'\n'}"; json="${existing%$'\n'*}"
  [ "$status" = 200 ] || { printf '%s\n' "GitHub answered $status when listing pull requests: $(jq -r '.message? // empty' <<<"$json" 2>/dev/null | head -c 300)" | mask >&2; die 6 "GitHub refused the request"; }
  number="$(jq -r '.[0].number // empty' <<<"$json")"; url="$(jq -r '.[0].html_url // empty' <<<"$json")"
  prhead="$(jq -r '.[0].head.sha // empty' <<<"$json")"
  # an open pull request for this branch must be at the tested commit (the push above moved it there, or it already was)
  { [ -z "$number" ] || [ "$prhead" = "$head" ]; } && break
  tries=$((tries - 1))
  [ "$tries" -gt 0 ] || die 4 "the open pull request #$number is at ${prhead:0:12}, not at the tested commit ${head:0:12}"
  sleep "${MT_PR_WAIT:-2}"
done

if [ -z "$number" ]; then
  body="$(head -c 8000 || true)"
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  body="$body"$'\n\n'"---"$'\n'"Opened by manythreads for card $card, branch $branch, tested commit $head."
  jq -n --arg title "$title" --arg head "$branch" --arg base "$base" --arg body "$body" '{title: $title, head: $head, base: $base, body: $body, maintainer_can_modify: false}' > "$tmp"
  made="$(gh POST "$repo_api" "$tmp" 2>&1 || true)"
  status="${made##*$'\n'}"; json="${made%$'\n'*}"
  [ "$status" = 201 ] || { printf '%s\n' "GitHub answered $status when opening the pull request: $(jq -r '.message? // empty' <<<"$json" 2>/dev/null | head -c 300)" | mask >&2; die 6 "GitHub refused the pull request"; }
  number="$(jq -r '.number // empty' <<<"$json")"; url="$(jq -r '.html_url // empty' <<<"$json")"
fi
[[ "$number" =~ ^[0-9]+$ ]] && [[ "$url" =~ ^https?://[^[:space:]]+$ ]] || die 6 "GitHub's answer had no pull request number"
echo "project=$project"
echo "pull_request_number=$number"
echo "pull_request_url=$url"
echo "head_sha=$head"
