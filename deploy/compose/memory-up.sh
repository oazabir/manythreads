#!/usr/bin/env bash
# Starts the Hindsight container (compose profile `memory`, PLAN P5-12) and waits for it to be healthy.
#  1. Brings the dev Postgres to the state deploy/postgres/init/20-hindsight-db.sql describes (role `hindsight`, its own database, no access to
#     `manythreads`): the file only runs on a fresh volume, so it is piped in here too. It is idempotent.
#  2. Mints the LiteLLM virtual key Hindsight uses for fact extraction (limited to the alias `fast`, never the master key) when the proxy is up
#     (`pnpm llm:up`). Repeating it is a no-op. Without the proxy the engine still starts; it cannot extract facts until the key exists.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f deploy/compose/docker-compose.dev.yml)
"${COMPOSE[@]}" up -d --wait postgres
"${COMPOSE[@]}" exec -T postgres psql -U manythreads_owner -d manythreads -v ON_ERROR_STOP=1 -q < deploy/postgres/init/20-hindsight-db.sql

LITELLM_URL="${MANYTHREADS_LITELLM_URL:-http://127.0.0.1:4000}"
MASTER_KEY="${MANYTHREADS_LITELLM_MASTER_KEY:-sk-manythreads-dev-master}"
HINDSIGHT_KEY="${MANYTHREADS_HINDSIGHT_LLM_API_KEY:-sk-hindsight-dev}"
if curl -fsS -m 3 "$LITELLM_URL/health/readiness" >/dev/null 2>&1; then
  curl -fsS -m 10 -X POST "$LITELLM_URL/key/generate" \
    -H "authorization: Bearer $MASTER_KEY" -H 'content-type: application/json' \
    -d "{\"key\":\"$HINDSIGHT_KEY\",\"models\":[\"fast\"],\"metadata\":{\"purpose\":\"hindsight fact extraction\"}}" >/dev/null \
    && echo "hindsight: LiteLLM key minted (alias fast only)"
else
  echo "hindsight: LiteLLM is not up at $LITELLM_URL (pnpm llm:up); run this again after it to mint the extraction key" >&2
fi

"${COMPOSE[@]}" --profile memory up -d --wait hindsight
