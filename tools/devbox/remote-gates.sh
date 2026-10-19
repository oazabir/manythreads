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
# --delete) would delete it. Two guards, because the before/after one alone was not enough: P5-28's route schemas were
# written during an earlier run on this box, so a later gate saw an unchanged directory and CI went red on `main`.
#   * the suite runs with CI=true, so vitest REFUSES to write a snapshot that is missing and the gate fails with the
#     same error CI reports — a snapshot that exists only here can never pass;
#   * every snapshot is committed, so a run that still changes this directory (a hand-run with `-u`, another
#     mechanism) is loud: the operator copies it back with Sync-Down.ps1 and commits it.
snapshots() { git status --porcelain -- packages/shared/test/schema-compat/snapshots || true; }

snap_before=$(snapshots)

stage "tests (vitest, maxWorkers=3; CI=true, so a missing snapshot fails as it does in CI)"
CI=true pnpm test --maxWorkers=3

stage "snapshots (schema-compat must not have written any)"
snap_after=$(snapshots)
if [ "$snap_after" != "$snap_before" ]; then
  printf '%s\n' "$snap_after"
  echo "the test run wrote snapshots: run Sync-Down.ps1, commit them, then re-run the gate" >&2
  exit 1
fi

printf '\nremote gates OK (install + lint + typecheck + tests)\n'
