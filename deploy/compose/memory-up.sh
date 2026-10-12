#!/usr/bin/env bash
# Starts the Hindsight container (compose profile `memory`, PLAN P5-12) and waits for it to be healthy. On a Postgres volume that predates
# deploy/postgres/init/20-hindsight-db.sql the `hindsight` database does not exist yet: it is created here, once.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f deploy/compose/docker-compose.dev.yml)
"${COMPOSE[@]}" up -d --wait postgres
if ! "${COMPOSE[@]}" exec -T postgres psql -U manythreads_owner -d manythreads -Atc "SELECT 1 FROM pg_database WHERE datname = 'hindsight'" | grep -q 1; then
  "${COMPOSE[@]}" exec -T postgres psql -U manythreads_owner -d manythreads -c 'CREATE DATABASE hindsight'
fi
"${COMPOSE[@]}" --profile memory up -d --wait hindsight
