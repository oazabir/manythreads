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

# A new exported Zod schema adds a file snapshot, and with CI unset `toMatchFileSnapshot` WRITES the missing file and
# passes: the suite would be green while the snapshot exists only on this machine, and the next Sync-Up (rsync
# --delete) would delete it. Every snapshot is committed, so the tree before the run is the reference: a run that
# CHANGES this directory wrote one, and the operator has to copy it back and commit it.
snapshots() { git status --porcelain -- packages/shared/test/schema-compat/snapshots || true; }

snap_before=$(snapshots)

stage "tests (vitest, maxWorkers=3)"
pnpm test --maxWorkers=3

stage "snapshots (schema-compat must not have written any)"
snap_after=$(snapshots)
if [ "$snap_after" != "$snap_before" ]; then
  printf '%s\n' "$snap_after"
  echo "the test run wrote snapshots: run Sync-Down.ps1, commit them, then re-run the gate" >&2
  exit 1
fi

printf '\nremote gates OK (install + lint + typecheck + tests)\n'
