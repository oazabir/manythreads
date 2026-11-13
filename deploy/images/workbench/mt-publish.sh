#!/bin/bash
# Publishes a card's tested branch: puts ONE squashed commit of it on `card-<8 characters of the card id>` at the project's origin (GitHub or GitLab, gitlab.com or a
# self-hosted host) and opens a pull request (GitHub) or merge request (GitLab) there; a person merges it, and that merge is the approval. Run by a bot as the `repo` user,
# through sudo, like mt-receive-pack.sh, so the bot never reads the token: it lives in /run/mt-push/<project>, 0400 and owned by `repo` (mt-push-sync.sh puts it there; a JSON
# document of the token and the repository address it was issued for; a project that shares its team's token for one owner holds `via` instead, naming the
# /run/mt-push/_owner.<host>.<owner> file that holds the token). Only bots whose definition grants `tasks.pull_request` are in the `publishers` group that sudo allows.
#
# The project's own document also says: `provider` (github or gitlab; absent in a document from before GitLab support: github), `login` and `userId` (the bot account on that
# provider) and `commitAs` (bot or requester; absent: bot). GitHub addresses are `https://<host>/<owner>/<repo>`; GitLab ones may nest groups
# (`https://<host>/<group>/<subgroup>/.../<repo>`, 2 to 20 segments).
#
#   sudo -u repo mt-publish.sh check   <project>
#       exit 0 and "ready" when the project has an origin and a token issued for that very origin; exit 3 and "no push credential" when it has none;
#       exit 7 and "token refused" when the provider has turned the token down (the platform marked it; a lead must save a new one).
#   sudo -u repo mt-publish.sh publish <project> <card id> <tested commit> <title> [<author name> <author email>]      (the request's text on standard input)
#       refuses unless the branch head IS the tested commit; fetches the origin's main branch; makes ONE commit whose parent is that main tip and whose tree is the tested
#       branch merged onto it (git merge-tree: a conflict, or a main branch that moved under the work, is exit 4 "rebuild the card"; nothing new to publish is exit 4 too); its
#       message is the title, a blank line, the text on standard input (at most 8000 bytes) and the line `Card: <card id>`; its dates are the tested head's committer date, so
#       publishing the same card twice makes the same commit and the second push changes nothing. Pushes it as the branch (never main, never a force push); opens the
#       request, or finds the open one of that branch. The two author arguments come together or not at all (else exit 2).
#       Who signs: the COMMITTER is always the bot account of the document (name = login; GitHub address <id>+<login>@users.noreply.github.com, GitHub Enterprise
#       <login>@noreply.<host>, GitLab <id>-<login>@users.noreply.<host>; a document with no login or id: `manythreads-bot <noreply@manythreads.invalid>`). The AUTHOR is the
#       bot too when the document says commitAs=bot (author arguments are ignored, never trusted), or the given name and email when it says requester (then they are required:
#       exit 2 without them; a name is 1 to 100 characters without a line break, < or >, an email is one address of at most 200 characters). The identity travels in
#       GIT_AUTHOR_* / GIT_COMMITTER_* variables of the one commit-tree call, never in a config file.
#       Prints  project=  provider=  pull_request_number=N (GitLab: the merge request's iid)  pull_request_url=  head_sha=  (the squashed commit, the one the request is at)
#       tested_sha=  (the tested commit).
#
# Exit codes: 0 done, 2 refused (bad input, not a repository of record, a requester's name missing), 3 no credential, 4 the branch is not at the tested commit, or the main
# branch moved (conflict) or there is nothing to publish, 5 push refused, 6 the provider refused or did not answer (also: the main branch could not be read), 7 the provider
# turned the token down (401 or "authentication failed"; stop and tell the project's lead). The token is passed to git through GIT_ASKPASS (user name `x-access-token` for
# GitHub, `oauth2` for GitLab) and to curl through a header read from standard input, never in an argument, and it is masked in everything this script prints.
#
# MT_REPOS_DIR / MT_PUSH_DIR / MT_REPO_USER / MT_GITHUB_API / MT_GITLAB_API / MT_PUSH_URL are test hooks (a local bare "origin" and a local double of GitHub or GitLab; the push
# URL is also where the main branch is fetched from). A bot cannot set them: sudo clears the environment and allows only the two command shapes above.
#
# MT_SOURCE_DIR (the publisher container of a Claude or Codex pod, P19-09) names a bot's own working clone instead of a repository of record under MT_REPOS_DIR.
# The clone belongs to the bot, so nothing in it is trusted: the branch is fetched into a private bare repository made for this one call (no hooks, no config of the
# clone is read except its origin address), the tested-commit check, the merge and the push run on that copy (the main branch is fetched into it too), and the token still counts only for the address it was issued for.
# The rules, the exit codes and the masking are the same as for a repository of record. The caller (publisher.mjs) is the only one that sets it.
set -euo pipefail
REPOS="${MT_REPOS_DIR:-/workspace/repos}"
PUSHDIR="${MT_PUSH_DIR:-/run/mt-push}"
RUSER="${MT_REPO_USER:-repo}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { local code="$1"; shift; echo "$*" >&2; exit "$code"; }

mode="${1:-}"; project="${2:-}"
[[ "$project" =~ ^[a-z0-9][a-z0-9._-]{0,60}$ ]] && [[ "$project" != *..* ]] || die 2 "bad project name"
SOURCE="${MT_SOURCE_DIR:-}"
work=""
tmp=""
baseref=""
cleanup() { [ -z "$baseref" ] || git -C "$dir" update-ref -d "$baseref" >/dev/null 2>&1 || true; [ -z "$tmp" ] || rm -f "$tmp"; [ -z "$work" ] || rm -rf "$work"; }
trap cleanup EXIT
dir="$REPOS/$project.git"
if [ -n "$SOURCE" ]; then
  # a working clone of the bot: a real folder (not a link) with a real .git folder; its own files are never run
  [ -d "$SOURCE" ] && [ ! -L "$SOURCE" ] && [ -d "$SOURCE/.git" ] && [ ! -L "$SOURCE/.git" ] && [ -f "$SOURCE/.git/config" ] && [ ! -L "$SOURCE/.git/config" ] || die 2 "no such project folder"
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
else
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(realpath -e "$dir")" = "$(realpath -m "$REPOS")/$project.git" ] || die 2 "no such repository of record"
  [ "$(stat -c %U "$dir")" = "$RUSER" ] || die 2 "repository is not owned by $RUSER"
fi
metafile="$PUSHDIR/$project"
tokenfile="$metafile"
# a project on the team's owner token reads the token (and the refused mark) from that file, the address and branch from its own
via=""
if [ -f "$metafile" ] && [ ! -L "$metafile" ]; then via="$(jq -r '.via // empty' -- "$metafile" 2>/dev/null || true)"; fi
if [ -n "$via" ]; then
  [[ "$via" =~ ^_owner\.[a-z0-9][a-z0-9.-]{0,200}$ ]] && [[ "$via" != *..* ]] || die 3 "no push credential"
  tokenfile="$PUSHDIR/$via"
fi
# who the document is for: the provider (a document from before GitLab support has none: github), the bot account and whose name a commit carries
meta() { if [ -f "$metafile" ] && [ ! -L "$metafile" ]; then jq -r --arg k "$1" '.[$k] // empty | tostring' -- "$metafile" 2>/dev/null || true; fi; }
provider="$(meta provider)"; provider="${provider:-github}"
login="$(meta login)"; userid="$(meta userId)"; commitas="$(meta commitAs)"; commitas="${commitas:-bot}"
if [ "$provider" = gitlab ]; then pname=GitLab; else pname=GitHub; fi
refused_msg() { echo "token refused: $pname no longer accepts this project's token; a lead must save a new one on the Projects page"; }
is_refused() { [ "$(jq -r '.refused // empty' -- "$tokenfile" 2>/dev/null)" = true ]; }
have_token() { [ -f "$tokenfile" ] && [ ! -L "$tokenfile" ] && [ "$(stat -c %U "$tokenfile")" = "$RUSER" ] && [ -s "$tokenfile" ]; }
# the token counts only for the address it was issued for: if the project moved to another repository, the old token is refused here
token_matches_origin() { { [ "$provider" = github ] || [ "$provider" = gitlab ]; } && { [ "$commitas" = bot ] || [ "$commitas" = requester ]; } && [ -n "$origin" ] && [ "$(jq -r '.origin // empty' -- "$metafile" 2>/dev/null)" = "$origin" ] && [ -n "$(jq -r '.token // empty' -- "$tokenfile" 2>/dev/null)" ] && [ -n "$(jq -r '.branch // empty' -- "$metafile" 2>/dev/null)" ]; }

if [ -n "$SOURCE" ]; then origin="$(git config --file "$SOURCE/.git/config" --get remote.origin.url 2>/dev/null || true)"
else origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"; fi
# The origin must be plain https (the same rule as mt-repo-create.sh). GitHub: exactly <host>/<owner>/<repo>. GitLab: <host>/<group>[/<subgroup>...]/<repo>, 2 to 20 segments.
plain() { [[ "$1" =~ ^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*/?$ ]]; }
parse_origin() {
  plain "$origin" || return 1
  local rest="${origin#https://}" path
  ohost="${rest%%/*}"; path="${rest#*/}"; path="${path%/}"; path="${path%.git}"
  ohost="$(printf '%s' "$ohost" | tr 'A-Z' 'a-z')"
  if [ "$provider" = gitlab ]; then
    local -a segs; local seg n
    IFS=/ read -ra segs <<<"$path"
    n="${#segs[@]}"
    [ "$n" -ge 2 ] && [ "$n" -le 20 ] || return 1
    for seg in "${segs[@]}"; do [[ "$seg" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]] || return 1; done
    orepo="${segs[$((n - 1))]}"; opath="$path"; oowner="${path%/*}"
  else
    oowner="${path%%/*}"; orepo="${path#*/}"; opath="$oowner/$orepo"
    [[ "$oowner" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] && [[ "$orepo" =~ ^[A-Za-z0-9._-]{1,100}$ ]] && [ "$orepo" != . ] && [ "$orepo" != .. ] || return 1
  fi
}

case "$mode" in
  check)
    [ "$#" -eq 2 ] || die 2 "usage: mt-publish.sh check <project>"
    if [ -n "$origin" ] && parse_origin && have_token && token_matches_origin; then
      if is_refused; then refused_msg; exit 7; fi
      echo ready; exit 0
    fi
    echo "no push credential"; exit 3 ;;
  publish) ;;
  *) die 2 "usage: mt-publish.sh check <project> | publish <project> <card id> <tested commit> <title> [<author name> <author email>]" ;;
esac

# the two author arguments come together or not at all
{ [ "$#" -eq 5 ] || [ "$#" -eq 7 ]; } || die 2 "usage: mt-publish.sh publish <project> <card id> <tested commit> <title> [<author name> <author email>]"
card="$3"; sha="$4"; title="$5"; author_name="${6:-}"; author_email="${7:-}"
[[ "$card" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die 2 "bad card id"
[[ "$sha" =~ ^[0-9a-f]{7,64}$ ]] || die 2 "bad commit"
[ "${#title}" -ge 1 ] && [ "${#title}" -le 200 ] && [[ "$title" != *$'\n'* ]] || die 2 "the title is one line of 1 to 200 characters"
have_token && token_matches_origin || die 3 "no push credential"
if is_refused; then die 7 "$(refused_msg)"; fi
[ -n "$origin" ] && parse_origin || die 2 "the repository's origin is not a plain https $pname address"
# whose name the commit carries: the bot's own, or the requester's (then the name and email are needed here and are checked, never trusted)
email_re='^[^@<>[:space:]]+@[^@<>[:space:]]+\.[^@<>[:space:]]+$'
if [ "$commitas" = requester ]; then
  [ "$#" -eq 7 ] || die 2 "this project signs commits with the requester's name and email: pass them"
  [ "${#author_name}" -ge 1 ] && [ "${#author_name}" -le 100 ] && [[ "$author_name" != *[$'\n\r<>']* ]] || die 2 "the author name is 1 to 100 characters without a line break, < or >"
  [ "${#author_email}" -le 200 ] && [[ "$author_email" =~ $email_re ]] || die 2 "the author email is not an email address"
fi
token="$(jq -r '.token' -- "$tokenfile")"
mask() { local t; t="$(cat)"; printf '%s\n' "${t//"$token"/***}"; }

branch="card-${card:0:8}"
# the branch a pull request is aimed at is the project's main branch, as the token was issued for it (not whatever the repository's HEAD says)
base="$(jq -r '.branch' -- "$metafile")"
[[ "$base" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ ]] && [ "$branch" != "$base" ] || die 2 "cannot tell the project's main branch"
if [ -n "$SOURCE" ]; then
  # the one branch, fetched into a private bare repository: the push below runs there, never in the bot's folder
  work="$(mktemp -d)"
  git init --bare -q -b mt-publish-unused "$work/r.git" 2>/dev/null || die 2 "cannot make a working copy"
  # The copy borrows the clone's objects (read-only) instead of copying them: the publisher's scratch space is a small memory folder, and a whole history copied into
  # it would not fit (a real project is larger than that) and could get the pod evicted. The fetch below then only sets the branch. Nothing is run from the clone.
  [ -d "$SOURCE/.git/objects" ] && [ ! -L "$SOURCE/.git/objects" ] || die 2 "no such project folder"
  printf '%s\n' "$SOURCE/.git/objects" > "$work/r.git/objects/info/alternates"
  git -C "$work/r.git" -c safe.directory='*' fetch -q --no-tags --no-write-fetch-head -- "$SOURCE" "+refs/heads/$branch:refs/heads/$branch" >/dev/null 2>&1 || die 4 "the branch $branch is not in the project folder: commit your work on that branch first"
  dir="$work/r.git"
fi
head="$(git -C "$dir" rev-parse --verify -q "refs/heads/$branch^{commit}" || true)"
[ -n "$head" ] || die 4 "the branch $branch is not in the repository of record: push it first"
tested="$(git -C "$dir" rev-parse --verify -q "$sha^{commit}" || true)"
[ -n "$tested" ] && [ "$tested" = "$head" ] || die 4 "the branch $branch is at ${head:0:12}, not at the tested commit ${sha:0:12}: test the branch head again"

# The one commit. The origin's main branch tip is fetched (authenticated like the push) and the tested branch is merged onto it in memory (git merge-tree): the commit's parent is
# that tip and its tree is the merge, so the pull request shows one commit however many the bot made. A main branch that moved in a way that does not merge cleanly, or that
# already holds the work, is exit 4.
export GIT_ASKPASS="$HERE/mt-askpass.sh" MT_TOKEN_FILE="$tokenfile" GIT_TERMINAL_PROMPT=0
if [ "$provider" = gitlab ]; then export MT_GIT_USER=oauth2; else export MT_GIT_USER=x-access-token; fi
pushurl="${MT_PUSH_URL:-$origin}"
auth_failed() { grep -qiE 'authentication failed|invalid username or password|bad credentials|returned error: 40[13]|http basic: access denied' <<<"$1"; }
baseref="refs/mt-publish/base-$$"
if ! out="$(git -C "$dir" -c credential.helper= fetch -q --no-tags --no-write-fetch-head -- "$pushurl" "refs/heads/$base:$baseref" 2>&1)"; then
  printf '%s\n' "$out" | mask >&2
  if auth_failed "$out"; then die 7 "$(refused_msg)"; fi
  die 6 "the project's main branch $base could not be read from the origin"
fi
basetip="$(git -C "$dir" rev-parse --verify -q "$baseref^{commit}" || true)"
[ -n "$basetip" ] || die 6 "the project's main branch $base could not be read from the origin"
if ! mergeout="$(git -C "$dir" merge-tree --write-tree "$basetip" "$head" 2>/dev/null)"; then
  printf '%s\n' "$mergeout" | head -c 600 | mask >&2
  die 4 "the project's main branch $base moved and the work does not merge onto it: the card must be rebuilt on the new $base"
fi
tree="${mergeout%%$'\n'*}"
[[ "$tree" =~ ^[0-9a-f]{40,64}$ ]] || die 4 "the project's main branch $base moved and the work does not merge onto it: the card must be rebuilt on the new $base"
[ "$tree" != "$(git -C "$dir" rev-parse "$basetip^{tree}")" ] || die 4 "nothing to publish: the project's main branch $base already holds this work"

# who signs: the committer is always the bot account; the author is the bot's too unless the project signs as the requester
if [[ "$login" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]] && [[ "$userid" =~ ^[0-9]{1,20}$ ]]; then
  bot_name="$login"
  if [ "$provider" = gitlab ]; then bot_email="$userid-$login@users.noreply.$ohost"
  elif [ "$ohost" = github.com ]; then bot_email="$userid+$login@users.noreply.github.com"
  else bot_email="$login@noreply.$ohost"; fi
else
  bot_name="manythreads-bot"; bot_email="noreply@manythreads.invalid"
fi
if [ "$commitas" = requester ]; then a_name="$author_name"; a_email="$author_email"; else a_name="$bot_name"; a_email="$bot_email"; fi
# the dates are the tested head's, so the same card published again is the same commit
when="$(git -C "$dir" show -s --format=%cd --date=raw "$head")"
[[ "$when" =~ ^[0-9]+\ [+-][0-9]{4}$ ]] || die 2 "cannot read the tested commit's date"
body="$(head -c 8000 || true)"
msg="$title"$'\n\n'
[ -z "$body" ] || msg="$msg$body"$'\n\n'
msg="${msg}Card: $card"
new="$(printf '%s\n' "$msg" | GIT_AUTHOR_NAME="$a_name" GIT_AUTHOR_EMAIL="$a_email" GIT_COMMITTER_NAME="$bot_name" GIT_COMMITTER_EMAIL="$bot_email" GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git -C "$dir" commit-tree "$tree" -p "$basetip")" || die 2 "cannot make the commit"
[[ "$new" =~ ^[0-9a-f]{40,64}$ ]] || die 2 "cannot make the commit"

# Push the one branch, as a plain (never forced) push of the exact commit. A branch that already exists on the origin elsewhere is refused by the origin.
if ! out="$(git -C "$dir" -c credential.helper= push --no-verify "$pushurl" "$new:refs/heads/$branch" 2>&1)"; then
  printf '%s\n' "$out" | mask >&2
  # git reports a token the provider does not accept as a failed login (HTTP 401); a push refused for another reason (rules, history) is exit 5
  if auth_failed "$out"; then die 7 "$(refused_msg)"; fi
  die 5 "the push of $branch to the origin was refused"
fi

# the request's own text: what the bot said, then where it came from
text="$body"
[ -z "$text" ] || text="$text"$'\n\n'"---"$'\n'
text="${text}Opened by manythreads for card $card, branch $branch, tested commit $head, published as one commit $new."
tmp="$(mktemp)"

if [ "$provider" = gitlab ]; then
  api="${MT_GITLAB_API:-https://$ohost/api/v4}"
  repo_api="$api/projects/${opath//\//%2F}/merge_requests"
  api_call() {  # api_call <method> <url> [data file]: the token goes in a header read from stdin, the answer's body to stdout, the status on the last line
    local method="$1" url="$2" data="${3:-}"
    local args=(-sS --max-time 30 -X "$method" -H @- -H 'Accept: application/json' -H 'User-Agent: manythreads-mt-publish' -w '\n%{http_code}')
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data-binary "@$data")
    printf 'PRIVATE-TOKEN: %s\n' "$token" | curl "${args[@]}" "$url"
  }
  list_url="$repo_api?source_branch=$branch&target_branch=${base//\//%2F}&state=opened"
  list_what="merge requests"; make_what="the merge request"
  pick() { number="$(jq -r '.[0].iid // empty' <<<"$1")"; url="$(jq -r '.[0].web_url // empty' <<<"$1")"; prhead="$(jq -r '.[0].sha // empty' <<<"$1")"; }
  jq -n --arg title "$title" --arg src "$branch" --arg base "$base" --arg body "$text" '{source_branch: $src, target_branch: $base, title: $title, description: $body, remove_source_branch: true, squash: false}' > "$tmp"
  pick_made() { number="$(jq -r '.iid // empty' <<<"$1")"; url="$(jq -r '.web_url // empty' <<<"$1")"; }
else
  if [ -n "${MT_GITHUB_API:-}" ]; then api="$MT_GITHUB_API"
  elif [ "$ohost" = github.com ]; then api="https://api.github.com"
  else api="https://$ohost/api/v3"; fi
  repo_api="$api/repos/$opath/pulls"
  api_call() {  # api_call <method> <url> [data file]: the token goes in a header read from stdin, the answer's body to stdout, the status on the last line
    local method="$1" url="$2" data="${3:-}"
    local args=(-sS --max-time 30 -X "$method" -H @- -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: manythreads-mt-publish' -w '\n%{http_code}')
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data-binary "@$data")
    printf 'Authorization: Bearer %s\n' "$token" | curl "${args[@]}" "$url"
  }
  list_url="$repo_api?head=$oowner:$branch&base=$base&state=open"
  list_what="pull requests"; make_what="the pull request"
  pick() { number="$(jq -r '.[0].number // empty' <<<"$1")"; url="$(jq -r '.[0].html_url // empty' <<<"$1")"; prhead="$(jq -r '.[0].head.sha // empty' <<<"$1")"; }
  jq -n --arg title "$title" --arg head "$branch" --arg base "$base" --arg body "$text" '{title: $title, head: $head, base: $base, body: $body, maintainer_can_modify: false}' > "$tmp"
  pick_made() { number="$(jq -r '.number // empty' <<<"$1")"; url="$(jq -r '.html_url // empty' <<<"$1")"; }
fi

# The provider moves an open request to a freshly pushed head a moment after the push is accepted, so a head that is not yet ours is asked for again
# (up to thirty times, two seconds apart; MT_PR_TRIES and MT_PR_WAIT are test hooks) before it counts as a request at another commit.
tries="${MT_PR_TRIES:-30}"
while :; do
  existing="$(api_call GET "$list_url" 2>&1 || true)"
  status="${existing##*$'\n'}"; json="${existing%$'\n'*}"
  if [ "$status" = 401 ]; then die 7 "$(refused_msg)"; fi
  [ "$status" = 200 ] || { printf '%s\n' "$pname answered $status when listing $list_what: $(jq -r '.message? // empty' <<<"$json" 2>/dev/null | head -c 300)" | mask >&2; die 6 "$pname refused the request"; }
  pick "$json"
  # an open request for this branch must be at the squashed commit (the push above moved it there, or it already was)
  { [ -z "$number" ] || [ "$prhead" = "$new" ]; } && break
  tries=$((tries - 1))
  [ "$tries" -gt 0 ] || die 4 "the open request #$number is at ${prhead:0:12}, not at the published commit ${new:0:12}"
  sleep "${MT_PR_WAIT:-2}"
done

if [ -z "$number" ]; then
  made="$(api_call POST "$repo_api" "$tmp" 2>&1 || true)"
  status="${made##*$'\n'}"; json="${made%$'\n'*}"
  if [ "$status" = 401 ]; then die 7 "$(refused_msg)"; fi
  [ "$status" = 201 ] || { printf '%s\n' "$pname answered $status when opening $make_what: $(jq -r '.message? // empty' <<<"$json" 2>/dev/null | head -c 300)" | mask >&2; die 6 "$pname refused $make_what"; }
  pick_made "$json"
fi
[[ "$number" =~ ^[0-9]+$ ]] && [[ "$url" =~ ^https?://[^[:space:]]+$ ]] || die 6 "$pname's answer had no request number"
echo "project=$project"
echo "provider=$provider"
echo "pull_request_number=$number"
echo "pull_request_url=$url"
echo "head_sha=$new"
echo "tested_sha=$head"
