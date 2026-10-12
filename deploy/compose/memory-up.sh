#!/usr/bin/env bash
# Starts the Hindsight container (compose profile `memory`, PLAN P5-12) and waits for it to be healthy.
#  1. Brings the dev Postgres to the state deploy/postgres/init/20-hindsight-db.sql describes (role `hindsight`, its own database, no access to
#     `manythreads`): the file only runs on a fresh volume, so it is piped in here too. It is idempotent.
#  2. Mints the LiteLLM virtual key Hindsight uses for fact extraction (limited to the alias `fast`, never the master key) when the proxy is up
#     (`pnpm llm:up`). A run that finds the key already there does nothing. Keys travel to curl on stdin (a curl config), never in argv.
#     Without the proxy the engine still starts; it cannot extract facts until the key exists.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f deploy/compose/docker-compose.dev.yml)
PSQL=("${COMPOSE[@]}" exec -T postgres psql -U manythreads_owner -d manythreads -v ON_ERROR_STOP=1 -q)
"${COMPOSE[@]}" up -d --wait postgres

# A `hindsight` database made by an earlier cut of P5-12 is owned by the superuser, and so are the tables Hindsight created in it: a new owner would
# fail half-way through its migrations. It holds dev memory only, so the way out is to drop it (the next start recreates it, empty).
OWNER=$("${PSQL[@]}" -Atc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'hindsight'")
if [ -n "$OWNER" ] && [ "$OWNER" != "hindsight" ]; then
  echo "hindsight: the dev database 'hindsight' is owned by '$OWNER' (made before the role existed). Drop it, then run this again:" >&2
  echo "  ${COMPOSE[*]} exec postgres psql -U manythreads_owner -d manythreads -c 'DROP DATABASE hindsight WITH (FORCE)'" >&2
  exit 1
fi
"${PSQL[@]}" < deploy/postgres/init/20-hindsight-db.sql

LITELLM_URL="${MANYTHREADS_LITELLM_URL:-http://127.0.0.1:4000}"
MASTER_KEY="${MANYTHREADS_LITELLM_MASTER_KEY:-sk-manythreads-dev-master}"
HINDSIGHT_KEY="${MANYTHREADS_HINDSIGHT_LLM_API_KEY:-sk-hindsight-dev}"
if curl -fsS -m 3 "$LITELLM_URL/health/readiness" >/dev/null 2>&1; then
  # 1. Is the key there already? (`key/info` answers 200 for a known key.)
  present=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -K - <<CONFIG || true
url = "$LITELLM_URL/key/info?key=$HINDSIGHT_KEY"
header = "authorization: Bearer $MASTER_KEY"
CONFIG
)
  if [ "$present" != "200" ]; then
    # 2. Mint it. A duplicate answer (400/409 "already exists") is the same state.
    answer=$(curl -sS -m 10 -w '\n%{http_code}' -K - <<CONFIG || true
url = "$LITELLM_URL/key/generate"
request = "POST"
header = "authorization: Bearer $MASTER_KEY"
header = "content-type: application/json"
data = "{\"key\":\"$HINDSIGHT_KEY\",\"models\":[\"fast\"],\"metadata\":{\"purpose\":\"hindsight fact extraction\"}}"
CONFIG
)
    status=${answer##*$'\n'}
    if [ "$status" = "200" ]; then
      echo "hindsight: LiteLLM key minted (alias fast only)"
    elif ! { [ "$status" = "400" ] || [ "$status" = "409" ]; } || ! grep -qiE 'already|duplicate' <<<"$answer"; then
      echo "hindsight: could not mint the LiteLLM key (HTTP $status)" >&2
    fi
  fi
else
  echo "hindsight: LiteLLM is not up at $LITELLM_URL (pnpm llm:up); run this again after it to mint the extraction key" >&2
fi

"${COMPOSE[@]}" --profile memory up -d --wait hindsight
