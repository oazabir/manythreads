#!/usr/bin/env bash
# remote-gates.sh — runs ON the devbox after Sync-Up: installs dependencies, lints,
# typechecks and (unless --no-tests) runs the vitest suite against the compose dev
# Postgres on localhost:55432 (independent of the CNPG cluster behind the live site).
# Called by tools/devbox/Ship.ps1; by hand:
#   ssh devbox "cd /root/manythreads && bash tools/devbox/remote-gates.sh [--no-tests]"
set -euo pipefail
cd "$(dirname "$0")/../.."

stage() { printf '\n=== %s ===\n' "$1"; }

stage "pnpm install"
pnpm install

stage "lint (eslint + stylelint)"
pnpm lint

stage "typecheck (tsc)"
pnpm typecheck

if [ "${1:-}" = "--no-tests" ]; then
  stage "tests skipped (--no-tests)"
  exit 0
fi

stage "dev database (docker compose postgres :55432)"
pnpm db:up

stage "tests (vitest, maxWorkers=3)"
pnpm test --maxWorkers=3

printf '\nremote gates OK (install + lint + typecheck + tests)\n'
