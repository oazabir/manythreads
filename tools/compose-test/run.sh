#!/usr/bin/env bash
# run.sh: the Docker Compose install, tested from nothing (PLAN P10-13).
#
#   flock /tmp/manythreads-test.lock tools/compose-test/run.sh     # run the test
#   tools/compose-test/run.sh --print-plan                         # print what it would do, change nothing
#
# What it does:
#   1. refuses to start while the disk is 80 % full or more, a CI run (tools/devbox/ci.sh) or a stage is up, or another copy of this test runs;
#   2. checks out a CLEAN copy of the commit (git worktree of COMPOSE_TEST_REF, default HEAD: no node_modules, nothing uncommitted) in a work directory;
#   3. in that copy: `docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build --wait` under the project name mt-compose-<pid> on a
#      port in 19700-19799, with the fixed test passwords of tools/compose-test/test.env; expects the five containers plus the fake LLM healthy;
#   4. `manythreads-admin init` in the manythreads container (first administrator, team, Hermes runner, Brain profile, runner test);
#   5. tools/compose-test/drive.mjs: the web client is served, a provider and the aliases are set, a question is posted to Brain in its conversation,
#      and Brain's reply (through the Hermes container, LiteLLM and the fake LLM) comes back with the seeded fact;
#   6. `docker compose down -v`, checks nothing of the project is left, removes the images it built and the work directory, whatever the outcome.
# It never touches a container, volume or network that is not named mt-compose-<pid>. Exit code 0 only when everything passed; 2 = refused to start.
#
# Settings (environment): COMPOSE_TEST_REF (default HEAD), COMPOSE_TEST_WORK (parent of the work directory, default /tmp),
# COMPOSE_TEST_LOG (default /tmp/compose-test.log), COMPOSE_TEST_MAX_DISK (default 80, percent), COMPOSE_TEST_KEEP=1 (leave everything up to look at it;
# remove it yourself with `docker compose -p <project> down -v`).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

if [ "${1:-}" = "--print-plan" ]; then
  sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

LOG=${COMPOSE_TEST_LOG:-/tmp/compose-test.log}
exec > >(tee "$LOG") 2>&1

REF=${COMPOSE_TEST_REF:-HEAD}
MAX_DISK=${COMPOSE_TEST_MAX_DISK:-80}
PROJECT="mt-compose-$$"
PORT=$((19700 + $$ % 100))
ADMIN_EMAIL=admin@compose.test
ADMIN_PASSWORD=compose-test-admin-password
WORK=""
TREE=""
STARTED=$(date +%s)
RESULT=FAILED
STATS_PID=""
STATS_FILE=""
DISK_BEFORE=""
UP_SECONDS=""

say() { printf '\n[%s +%ss] %s\n' "$(date -u +%H:%M:%S)" "$(( $(date +%s) - STARTED ))" "$*"; }
die() { say "REFUSED: $*"; exit 2; }
disk_percent() { df --output=pcent / | tail -n 1 | tr -dc '0-9'; }
dc() { docker compose -p "$PROJECT" --project-directory "$TREE/deploy/compose" --env-file "$TREE/tools/compose-test/test.env" -f "$TREE/deploy/compose/docker-compose.yml" -f "$TREE/deploy/compose/docker-compose.test.yml" "$@"; }

# --- 1. preconditions ---------------------------------------------------------------------------------------------------------------------------------------------
for tool in docker git curl node; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
docker compose version >/dev/null 2>&1 || die "docker compose is not installed"
[ "$(disk_percent)" -lt "$MAX_DISK" ] || die "the disk is $(disk_percent) % full (the limit is $MAX_DISK %); free some space first"
if pgrep -fx 'bash tools/devbox/ci.sh.*' >/dev/null 2>&1; then die "a CI run (tools/devbox/ci.sh) is in progress; it shares this machine"; fi
if docker ps -a --format '{{.Names}}' | grep -q '^mt-compose-'; then die "another compose-test container exists ($(docker ps -a --format '{{.Names}}' | grep '^mt-compose-' | head -n 1)); remove it first"; fi
if command -v kubectl >/dev/null && kubectl --request-timeout=10s get namespace manythreads-stage -o name >/dev/null 2>&1; then die "a stage is up (namespace manythreads-stage); run stage.sh down first"; fi
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"; then die "port $PORT is in use"; fi

DISK_BEFORE=$(disk_percent)
say "start: project $PROJECT, port $PORT, disk ${DISK_BEFORE} %, free memory $(free -m | awk '/^Mem:/ {print $7}') MB, commit $(git -C "$REPO" rev-parse --short "$REF")"

# --- 6. clean-up, registered first so every later failure still runs it ---------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  set +e
  [ -z "$STATS_PID" ] || kill "$STATS_PID" 2>/dev/null
  if [ "${COMPOSE_TEST_KEEP:-}" = 1 ]; then
    say "COMPOSE_TEST_KEEP=1: leaving project $PROJECT (port $PORT) and $WORK in place"
    return
  fi
  if [ -n "$TREE" ] && [ -d "$TREE" ]; then
    if [ "$code" -ne 0 ]; then
      say "the state at the failure"
      dc ps -a 2>&1 | tail -n 20
      for s in manythreads hermes litellm hindsight postgres fake-llm; do printf '\n----- logs: %s\n' "$s"; dc logs --no-color --tail 40 "$s" 2>&1 | tail -n 40; done
    fi
    say "clean-up: down -v"
    dc down -v --remove-orphans --timeout 20 >/dev/null 2>&1
    local left
    left=$( { docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"; docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"; docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"; } | wc -l)
    if [ "$left" -eq 0 ]; then say "nothing of $PROJECT is left (containers, volumes, networks: 0)"; else say "LEFT OVER: $left objects of $PROJECT"; RESULT=FAILED; [ "$code" -ne 0 ] || code=1; fi
  fi
  # the images this test built: by their own tag (a tag shared with an older image of the same content only loses the tag)
  docker rmi manythreads/postgres:compose manythreads/manythreads:compose manythreads/hermes:compose manythreads/fake-llm:compose-test >/dev/null 2>&1
  docker image prune -f >/dev/null 2>&1
  # the build cache this test made (several GB); what other builds used most recently stays
  docker builder prune -f --keep-storage "${COMPOSE_TEST_KEEP_CACHE:-3gb}" >/dev/null 2>&1
  if [ -n "$TREE" ]; then git -C "$REPO" worktree remove --force "$TREE" >/dev/null 2>&1; git -C "$REPO" worktree prune; fi
  [ -z "$WORK" ] || rm -rf "$WORK"
  say "$RESULT. disk ${DISK_BEFORE} % before, $(disk_percent) % after; log: $LOG"
  return "$code"
}
trap cleanup EXIT

# --- 2. a clean copy of the commit ---------------------------------------------------------------------------------------------------------------------------------
WORK=$(mktemp -d "${COMPOSE_TEST_WORK:-/tmp}/mt-compose-work.XXXXXX")
TREE="$WORK/tree"
git -C "$REPO" worktree add --detach "$TREE" "$REF" >/dev/null 2>&1 || die "cannot check out $REF"
[ ! -e "$TREE/node_modules" ] || { say "FAILED: the copy has a node_modules directory"; exit 1; }
[ ! -e "$TREE/deploy/compose/.env" ] || { say "FAILED: the copy has a .env file (it must not be committed)"; exit 1; }

# peak memory: the sum of the project's containers, and the machine's used memory, every 5 seconds
STATS_FILE="$WORK/mem.csv"
(
  while true; do
    ids=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086
      c=$(docker stats --no-stream --format '{{.MemUsage}}' $ids 2>/dev/null | awk '{v=$1; u=v; gsub(/[0-9.]/,"",u); n=v; gsub(/[A-Za-z]/,"",n); if(u=="GiB")n*=1024; else if(u=="KiB"||u=="kB")n/=1024; else if(u=="B")n/=1048576; s+=n} END{printf "%d", s}')
      printf '%s,%s\n' "${c:-0}" "$(free -m | awk '/^Mem:/ {print $3}')" >>"$STATS_FILE"
    fi
    sleep 5
  done
) &
STATS_PID=$!

# --- 3. up ----------------------------------------------------------------------------------------------------------------------------------------------------------
export MANYTHREADS_PORT=$PORT MANYTHREADS_BIND=127.0.0.1 MANYTHREADS_PUBLIC_URL="http://localhost:$PORT"
say "docker compose up -d --build --wait (the first build takes several minutes)"
UP_STARTED=$(date +%s)
dc up -d --build --wait --wait-timeout 600
UP_SECONDS=$(( $(date +%s) - UP_STARTED ))
say "up in ${UP_SECONDS} s"
dc ps

say "check: five long-running containers, all healthy, plus the fake LLM"
for s in postgres litellm hindsight manythreads hermes fake-llm; do
  id=$(dc ps -q "$s")
  [ -n "$id" ] || { say "FAILED: no container for $s"; exit 1; }
  state=$(docker inspect -f '{{.State.Status}}/{{.State.Health.Status}}' "$id")
  [ "$state" = "running/healthy" ] || { say "FAILED: $s is $state"; exit 1; }
  printf '  %-12s %s\n' "$s" "$state"
done
n=$(dc ps -q | wc -l)
[ "$n" -eq 6 ] || { say "FAILED: $n containers are running, not 6 (five and the fake LLM)"; exit 1; }
curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null || { say "FAILED: /readyz did not answer 200 on the published port"; exit 1; }

# --- 4. admin init --------------------------------------------------------------------------------------------------------------------------------------------------
say "manythreads-admin init"
printf '%s' "$ADMIN_PASSWORD" | dc exec -T manythreads manythreads-admin init --email "$ADMIN_EMAIL" --name "Compose Admin" --workspace "Compose test" --team General
say "manythreads-admin init a second time (it must be safe to repeat)"
printf '%s' "$ADMIN_PASSWORD" | dc exec -T manythreads manythreads-admin init --email "$ADMIN_EMAIL" --name "Compose Admin" --workspace "Compose test" --team General --no-runner-test

# --- 5. the browser's part, through the API ---------------------------------------------------------------------------------------------------------------------------
say "drive: sign in, provider, aliases, a question to Brain"
BASE="http://127.0.0.1:$PORT" EMAIL="$ADMIN_EMAIL" PASSWORD="$ADMIN_PASSWORD" node "$TREE/tools/compose-test/drive.mjs"

RESULT=PASSED
PEAK=$(awk -F, 'BEGIN{m=0;h=0} {if($1>m)m=$1; if($2>h)h=$2} END{print m","h}' "$STATS_FILE" 2>/dev/null || echo "0,0")
say "RESULT: up ${UP_SECONDS} s, total $(( $(date +%s) - STARTED )) s so far, peak container memory ${PEAK%%,*} MB (all six), peak machine memory in use ${PEAK##*,} MB"
