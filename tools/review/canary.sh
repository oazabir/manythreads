#!/usr/bin/env bash
# The canary (PLAN P12-04 block C 4). Proves the persona harness notices a missing message box, and notices a missing picture:
#   1. builds the web client with the message box hidden (VITE_MANYTHREADS_CANARY=hide-composer) into clients/web/dist-canary (never into dist);
#   2. runs the harness's example journeys against it: exactly the steps that use the message box must fail, and no others;
#   3. runs them against the normal build: the set must be complete; then deletes one picture and the completeness check must fail.
# Exit 0 only when all three hold. Starts three stacks one after the other (the persona projects run one worker); about 3 minutes on the devbox.
# Needs the saved snapshot (`pnpm --filter @manythreads/tools-seed snapshot build week-2`; a stack builds it itself the first time) and clients/web/dist.
# Run it under the shared lock when others test: `flock /tmp/manythreads-test.lock tools/review/canary.sh`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mt-canary.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
CANARY_DIST="$ROOT/clients/web/dist-canary"
export MANYTHREADS_JOURNEY_SET=example

say() { printf 'canary: %s\n' "$*"; }
fail() { printf 'canary: FAILED - %s\n' "$*" >&2; exit 1; }
playwright_example() {
  (cd "$ROOT/e2e" && npx playwright test --project=personas-desktop --project=personas-mobile-web --reporter=line "$@")
}

# 1. the canary build
say "building the web client with the message box hidden into clients/web/dist-canary"
rm -rf "$CANARY_DIST"
VITE_MANYTHREADS_CANARY=hide-composer pnpm --filter @manythreads/web exec vite build --outDir "$CANARY_DIST" --emptyOutDir >"$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log" >&2; fail "the canary build failed"; }
[ -f "$CANARY_DIST/index.html" ] || fail "the canary build wrote no index.html"
if [ ! -f "$ROOT/clients/web/dist/index.html" ]; then
  say "clients/web/dist is missing: building the normal client"
  pnpm --filter @manythreads/web build >"$WORK/build-normal.log" 2>&1 || { tail -20 "$WORK/build-normal.log" >&2; fail "the normal build failed"; }
fi

# 2. the canary run: failures are recorded, not thrown
say "running the example journeys on the canary build (failures expected)"
CANARY_OUT="$WORK/canary-out"
MANYTHREADS_JOURNEYS_OUT="$CANARY_OUT" MANYTHREADS_PERSONAS_CONTINUE=1 MANYTHREADS_STACK_WEB_DIST="$CANARY_DIST" playwright_example >"$WORK/canary-run.log" 2>&1 || true
(cd "$ROOT/e2e" && MANYTHREADS_JOURNEYS_OUT="$CANARY_OUT" pnpm exec tsx personas/harness/canary-cli.ts compare "$CANARY_OUT/_example") || { tail -30 "$WORK/canary-run.log" >&2; fail "the canary build did not fail exactly the message-box steps"; }

# 3. the normal run, then a picture is taken away
say "running the example journeys on the normal build"
GOOD_OUT="$WORK/good-out"
MANYTHREADS_JOURNEYS_OUT="$GOOD_OUT" playwright_example >"$WORK/good-run.log" 2>&1 || { tail -30 "$WORK/good-run.log" >&2; fail "the example journeys failed on the normal build"; }
(cd "$ROOT/e2e" && pnpm exec tsx personas/harness/canary-cli.ts complete "$GOOD_OUT/_example") || fail "the normal run is not complete"
VICTIM="$(find "$GOOD_OUT/_example" -name '*.png' | sort | head -n 1)"
[ -n "$VICTIM" ] || fail "the normal run wrote no pictures"
rm -f "$VICTIM"
say "deleted $(basename "$VICTIM")"
if (cd "$ROOT/e2e" && pnpm exec tsx personas/harness/canary-cli.ts complete "$GOOD_OUT/_example") >"$WORK/after.log" 2>&1; then
  fail "the completeness check passed with a picture missing"
fi
grep -q "$(basename "$VICTIM")" "$WORK/after.log" || { cat "$WORK/after.log" >&2; fail "the completeness check failed but did not name the missing picture"; }
say "OK: the canary build failed exactly the message-box steps and a missing picture is caught by name"
