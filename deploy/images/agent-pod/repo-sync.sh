#!/bin/sh
# The repo-sync step of a Claude Code runner's pod: clones and fetches the projects of the teams on the runner's list.
# The list is one line per clone: <team> <bot> <project> <branch or -> <https address>. It comes from two places: /run/repos/repos.txt, which the bridge rewrites whenever the
# platform sends a new list (the controller does it within seconds of a project being added), and /etc/bridge/repos.txt, the ConfigMap copy the pod started with (a ConfigMap
# reaches a pod only after about a minute). The first is used when it exists. The list is read every 5 seconds, so a new project is cloned within seconds; a clone that already
# exists is fetched once a minute, not every 5 seconds. It has no Kubernetes token and no sign-in file, and it writes no credential into a clone: only public addresses work
# (publishing is the publisher container's job, with a token this step never sees).
#
# A clone belongs to the bot: the bot's container writes the same /work (and the same /tmp) as this one, as the same user. Nothing in a clone is trusted. A bot could put a line
# into the clone's .git/config (remote.origin.uploadpack, core.sshCommand, core.fsmonitor, an include, url.*.insteadOf, a credential helper, a hooks folder) or a file into
# .git/hooks, and a plain `git -C <clone> fetch` here would run it, in a container that has the network. So:
#   - git runs in a fresh environment (`env -i`): none of this script's GIT_* variables, no global or system config, no prompt, only the https protocol, and the settings that
#     can start a program (hooks, fsmonitor, ssh command, proxy command, credential helper, auto gc) fixed on top of whatever any config says;
#   - a fetch never reads the clone's config or hooks. It runs in a private git folder this script makes in its own scratch folder (a memory volume that only this container
#     mounts: /tmp is shared with the bot and a file there could be changed under our feet), whose own config is the fresh one, and whose `objects`, `refs` and `packed-refs`
#     are links to the clone's. The address fetched is the one on the list, never one read from the clone, and it must equal the clone's own origin or the clone is left alone;
#   - a first clone is made under a hidden name beside the final one and moved into place, with the same fresh environment and with empty templates (no hook is ever copied in);
#   - a team, bot or project folder, a .git, objects or refs folder that is a link is not followed; a clone with an alternates file is not fetched.
# REPO_SYNC_* are test hooks (a local bare "origin" and short waits; REPO_SYNC_ALLOW_FILE lets git use a local folder, REPO_SYNC_FILE_ADDRESSES accepts file:// addresses on the list, REPO_SYNC_GIT_CONFIG is a global config file for address mapping); the pod sets none of them except the scratch folder.
SCRATCH="${REPO_SYNC_SCRATCH:-/run/sync}"
LIST="${REPO_SYNC_LIST:-/run/repos/repos.txt}"
FALLBACK="${REPO_SYNC_FALLBACK:-/etc/bridge/repos.txt}"
WORK="${REPO_SYNC_WORK:-/work}"
INTERVAL="${REPO_SYNC_INTERVAL:-5}"
FETCH_EVERY="${REPO_SYNC_FETCH_EVERY:-12}"
STATE="${REPO_SYNC_STATE:-$SCRATCH/state}"
RETRY_AFTER="${REPO_SYNC_RETRY_AFTER:-60}"
ONCE="${REPO_SYNC_ONCE:-}"
PROTOCOLS=https
[ -z "${REPO_SYNC_ALLOW_FILE:-}" ] || PROTOCOLS=https:file   # test hook: a local folder as the origin (the tests map the list's address to one with REPO_SYNC_GIT_CONFIG)
mkdir -p "$SCRATCH" "$STATE" || exit 1
cd "$SCRATCH" || exit 1
export HOME="$SCRATCH"

# sg <seconds> [NAME=value ...] git ...: git in an environment that holds nothing of the caller's. Only the proxy and certificate variables of the pod's own spec pass through.
# The seven entries of HARD are config entries given through the environment: they win over any config file, and nothing is written to a config file by them.
HARD="GIT_CONFIG_COUNT=7 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false GIT_CONFIG_KEY_2=core.sshCommand GIT_CONFIG_VALUE_2=false GIT_CONFIG_KEY_3=core.gitProxy GIT_CONFIG_VALUE_3=false GIT_CONFIG_KEY_4=credential.helper GIT_CONFIG_VALUE_4= GIT_CONFIG_KEY_5=gc.auto GIT_CONFIG_VALUE_5=0 GIT_CONFIG_KEY_6=maintenance.auto GIT_CONFIG_VALUE_6=false"
sg() {
  secs="$1"; shift
  timeout "$secs" env -i PATH="$PATH" HOME="$SCRATCH" LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="${REPO_SYNC_GIT_CONFIG:-/dev/null}" GIT_CONFIG_SYSTEM=/dev/null \
    GIT_ATTR_NOSYSTEM=1 GIT_ALLOW_PROTOCOL="$PROTOCOLS" \
    ${HTTPS_PROXY:+"HTTPS_PROXY=$HTTPS_PROXY"} ${https_proxy:+"https_proxy=$https_proxy"} ${HTTP_PROXY:+"HTTP_PROXY=$HTTP_PROXY"} ${http_proxy:+"http_proxy=$http_proxy"} \
    ${NO_PROXY:+"NO_PROXY=$NO_PROXY"} ${no_proxy:+"no_proxy=$no_proxy"} ${SSL_CERT_FILE:+"SSL_CERT_FILE=$SSL_CERT_FILE"} ${SSL_CERT_DIR:+"SSL_CERT_DIR=$SSL_CERT_DIR"} \
    "$@"
}
# a real folder, not a link
realdir() { [ -d "$1" ] && [ ! -L "$1" ]; }

# fetch_clone: refreshes refs/remotes/origin/* and the tags of an existing clone, without reading anything of the clone but the address of its origin
fetch_clone() {
  for p in "$WORK/$team" "$WORK/$team/$bot" "$dir" "$dir/.git" "$dir/.git/objects" "$dir/.git/refs"; do
    realdir "$p" || { echo "repo-sync: not fetching $project: $p is not a plain folder"; return 0; }
  done
  [ -f "$dir/.git/config" ] && [ ! -L "$dir/.git/config" ] && [ "$(wc -c < "$dir/.git/config")" -lt 100000 ] || { echo "repo-sync: not fetching $project: no usable .git/config"; return 0; }
  [ ! -e "$dir/.git/objects/info/alternates" ] && [ ! -e "$dir/.git/objects/info/http-alternates" ] || { echo "repo-sync: not fetching $project: it borrows objects from another folder"; return 0; }
  # the one thing read from the clone: its origin address (the file is only parsed: no include is followed, nothing runs). It must be the project's address on the list.
  have=$(sg 10 git config --file "$dir/.git/config" --no-includes --get-all remote.origin.url </dev/null 2>/dev/null)
  [ "$have" = "$origin" ] || { echo "repo-sync: not fetching $project: the clone's origin is not the project's address on the list"; return 0; }
  g="$SCRATCH/gitdir"
  rm -rf "$g"
  sg 10 git init --bare -q --template= -b mt-sync-unused "$g" </dev/null >/dev/null 2>&1 || { echo "repo-sync: cannot make a private git folder"; return 0; }
  rm -rf "$g/objects" "$g/refs"
  ln -s "$dir/.git/objects" "$g/objects" && ln -s "$dir/.git/refs" "$g/refs" && ln -s "$dir/.git/packed-refs" "$g/packed-refs" || { rm -rf "$g"; return 0; }
  sg 120 $HARD GIT_DIR="$g" git fetch --quiet --no-write-fetch-head --no-recurse-submodules -- "$origin" '+refs/heads/*:refs/remotes/origin/*' </dev/null 2>&1 | head -n 3
  rm -rf "$g"
}

# clone_new: the first clone of a project, under a hidden name and then moved into place
clone_new() {
  mkdir -p "$WORK/$team/$bot"
  realdir "$WORK/$team" && realdir "$WORK/$team/$bot" || { echo "repo-sync: not cloning $project: a folder on the way is a link"; return 0; }
  tmpd="$WORK/$team/$bot/.clone.$project"
  rm -rf "$tmpd"
  if [ "$branch" = "-" ]; then
    sg 300 $HARD git clone --quiet --template= -- "$origin" "$tmpd" </dev/null 2>&1 | head -n 3
  else
    sg 300 $HARD git clone --quiet --template= --branch "$branch" -- "$origin" "$tmpd" </dev/null 2>&1 | head -n 3
  fi
  if [ -d "$tmpd/.git" ] && mv -T -- "$tmpd" "$dir" 2>/dev/null; then :; else rm -rf "$tmpd"; fi
}

# The team's repository of record (P26-09): one bare repository per project at /work/<team>/repos/<project>.git, shared by every bot of the pod so that one bot's branch can reach another
# (`mt-git record-push` and `mt-git record-fetch`; the bots' own clones stay as they are, with the public address as origin). It is made from the project's public address like a clone, with the
# same fresh environment and empty templates, and its `update` hook (written here, never copied from anywhere) refuses a push to main, to the project's default branch, a delete and a forced push.
# All bots of a pod run as one user, so the hook is a guard rail against mistakes and not a wall; a pod with full access serves one team for that reason. The default branch is refreshed from the
# public address into the record's own branch the way a clone is fetched (a private git folder whose objects and refs are links to the record's, so nothing in the record's config or hooks runs here).
RECORD_HOOK='#!/bin/sh
# update hook of the repository of record (repo-sync.sh): refuses what would lose another bot'"'"'s work
ref="$1"; old="$2"; new="$3"
zero=0000000000000000000000000000000000000000
head=$(git symbolic-ref HEAD 2>/dev/null)
case "$ref" in refs/heads/*) ;; *) echo "the repository of record takes branches only" >&2; exit 1 ;; esac
if [ "$ref" = "$head" ] || [ "$ref" = refs/heads/main ] || [ "$ref" = refs/heads/master ]; then echo "the main branch is not pushed to here: push a card branch" >&2; exit 1; fi
if [ "$new" = "$zero" ]; then echo "a branch is not deleted here" >&2; exit 1; fi
if [ "$old" != "$zero" ] && ! git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then echo "a forced push is not accepted here" >&2; exit 1; fi
exit 0
'
RECORDS_DONE=""

# record_sync: makes or refreshes the repository of record of the current list entry (once per team and project in a round)
record_sync() {
  case " $RECORDS_DONE " in *" $team/$project "*) return 0 ;; esac
  RECORDS_DONE="$RECORDS_DONE $team/$project"
  mkdir -p "$WORK/$team/repos" 2>/dev/null
  realdir "$WORK/$team" && realdir "$WORK/$team/repos" || { echo "repo-sync: no repository of record for $project: a folder on the way is a link"; return 0; }
  rec="$WORK/$team/repos/$project.git"
  if [ -e "$rec" ] || [ -L "$rec" ]; then
    [ $((tick % FETCH_EVERY)) -eq 0 ] || return 0
    for p in "$rec" "$rec/objects" "$rec/refs"; do
      realdir "$p" || { echo "repo-sync: not fetching the record of $project: $p is not a plain folder"; return 0; }
    done
    [ ! -e "$rec/objects/info/alternates" ] || { echo "repo-sync: not fetching the record of $project: it borrows objects from another folder"; return 0; }
    def=$(sed -n '1s#^ref: refs/heads/##p' "$rec/HEAD" 2>/dev/null)
    case "$def" in ''|*[!A-Za-z0-9._/-]*) echo "repo-sync: not fetching the record of $project: odd default branch"; return 0 ;; esac
    g="$SCRATCH/gitdir-record"
    rm -rf "$g"
    sg 10 git init --bare -q --template= -b mt-sync-unused "$g" </dev/null >/dev/null 2>&1 || { echo "repo-sync: cannot make a private git folder"; return 0; }
    rm -rf "$g/objects" "$g/refs"
    ln -s "$rec/objects" "$g/objects" && ln -s "$rec/refs" "$g/refs" && ln -s "$rec/packed-refs" "$g/packed-refs" || { rm -rf "$g"; return 0; }
    sg 120 $HARD GIT_DIR="$g" git fetch --quiet --no-write-fetch-head --no-recurse-submodules -- "$origin" "+refs/heads/$def:refs/heads/$def" </dev/null 2>&1 | head -n 3
    rm -rf "$g"
    return 0
  fi
  mark="$STATE/failed-record.$team.$project"
  now=$(date +%s)
  last=$(cat "$mark" 2>/dev/null)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ -f "$mark" ] && [ $((now - last)) -lt "$RETRY_AFTER" ]; then return 0; fi
  tmpr="$WORK/$team/repos/.record.$project"
  rm -rf "$tmpr"
  if [ "$branch" = "-" ]; then
    sg 300 $HARD git clone --bare --quiet --template= -- "$origin" "$tmpr" </dev/null 2>&1 | head -n 3
  else
    sg 300 $HARD git clone --bare --quiet --template= --branch "$branch" -- "$origin" "$tmpr" </dev/null 2>&1 | head -n 3
  fi
  if [ -d "$tmpr/objects" ]; then
    mkdir -p "$tmpr/hooks" && printf '%s' "$RECORD_HOOK" > "$tmpr/hooks/update" && chmod 0755 "$tmpr/hooks/update" \
      && sg 10 git config --file "$tmpr/config" receive.denyDeletes true && sg 10 git config --file "$tmpr/config" receive.denyNonFastForwards true \
      && mv -T -- "$tmpr" "$rec" 2>/dev/null && rm -f "$mark" && return 0
  fi
  rm -rf "$tmpr"
  echo "$now" > "$mark"
}

tick=0
while true; do
  RECORDS_DONE=""
  src="$FALLBACK"
  [ -f "$LIST" ] && src="$LIST"
  if [ -f "$src" ]; then
    while read -r team bot project branch origin; do
      [ -n "$origin" ] || continue
      # the names come from our own database but are checked again: letters, digits, dot, dash and underscore only
      case "$team$bot$project" in *[!A-Za-z0-9._-]*) echo "repo-sync: skipping a name with odd characters"; continue ;; esac
      # a name that is only dots would climb out of its folder
      case "$team" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$bot" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      case "$project" in .*) echo "repo-sync: skipping a name that starts with a dot"; continue ;; esac
      # the branch is a plain name too (it follows --branch)
      case "$branch" in -|[A-Za-z0-9]*) ;; *) echo "repo-sync: skipping $project: odd branch name"; continue ;; esac
      case "$branch" in *[!A-Za-z0-9._/-]*) echo "repo-sync: skipping $project: odd branch name"; continue ;; esac
      case "$origin" in https://*) ;; file:///*) [ -n "${REPO_SYNC_FILE_ADDRESSES:-}" ] || { echo "repo-sync: skipping $project: not an https address"; continue; } ;; *) echo "repo-sync: skipping $project: not an https address"; continue ;; esac
      # a public address has no user name, query or odd character in it (a token in an address would be written into the clone's config)
      case "$origin" in *[!A-Za-z0-9._~:/%+=,-]*) echo "repo-sync: skipping $project: the address has characters a public address does not need"; continue ;; esac
      dir="$WORK/$team/$bot/$project"
      record_sync
      if [ -e "$dir" ] || [ -L "$dir" ]; then
        # an existing clone is fetched once in FETCH_EVERY rounds
        [ $((tick % FETCH_EVERY)) -eq 0 ] || continue
        fetch_clone
      else
        # a clone that failed is tried again after RETRY_AFTER seconds, not every round
        mark="$STATE/failed.$team.$bot.$project"
        now=$(date +%s)
        last=$(cat "$mark" 2>/dev/null)
        case "$last" in ''|*[!0-9]*) last=0 ;; esac
        if [ -f "$mark" ] && [ $((now - last)) -lt "$RETRY_AFTER" ]; then continue; fi
        clone_new
        if [ -d "$dir/.git" ]; then rm -f "$mark"; else echo "$now" > "$mark"; fi
      fi
    done < "$src"
  fi
  tick=$((tick + 1))
  [ -z "$ONCE" ] || exit 0
  sleep "$INTERVAL"
done
