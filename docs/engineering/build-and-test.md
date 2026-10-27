# Build and test

The commands that build, lint and test manythreads, and the rules every coding agent follows while doing so.

## Commands
```
pnpm install            pnpm lint     pnpm typecheck     pnpm build
pnpm test               # vitest, all packages (needs DB: pnpm db:up)
pnpm test:rls  pnpm test:events  pnpm test:schema-compat  pnpm test:memory-cross-team  (later: test:runtime-rules)
pnpm memory:up / memory:down   # Hindsight (compose profile `memory`, port 8888); docs/plugins/memory-hindsight.md
pnpm s3:up              # MinIO for storage-s3 tests (MANYTHREADS_TEST_S3=1)
pnpm db:up / db:down    # dev Postgres 19 via deploy/compose (port 55432, user manythreads_owner)
pnpm e2e                # playwright (runs from e2e/; never `playwright` from root);  pnpm e2e --project=api
                        # specs that write data use their own stack (startStack / useIsolatedStack); ports auto-picked
pnpm vt / vt:update     # plate visual comparison (tools/plates)
pnpm --filter @manythreads/tools-bench bench:server   # benchmarks
```
Keep command output small: pipe through `tail -n 40` or grep for failures. Never paste whole logs.

**The GitHub runner carries code only.** The `ci` workflow copies the tree to the devbox and
runs `tools/devbox/ci.sh` there: the build, the whole test suite (unit, integration and the
browser tests) and the deploy all happen on the devbox, which owns the cluster. The candidate
is deployed first into its own k3s namespace (`manythreads-ci`, `values-ci.yaml`) and checked
there — it answers, a persona signs in, the seeded world is there; only then is the same build
promoted to the live namespace (`manythreads`). The test suite itself runs with the instances
it starts for itself (a fresh database, an empty world, an idle world), never against that one
release. Never install or run Playwright on a GitHub runner: its image has no Chromium build.

## Agent rules (for every subagent)
- Read this file and `MISTAKES.md` first. Read only the spec/plan sections your task cites.
- Do not spawn subagents. Bash, not zsh.
- Code changes must leave `pnpm lint` and `pnpm typecheck` green for touched packages.
- The shared dev Postgres has 100 connections: with other agents running use vitest `--maxWorkers=3` and run only your specs;
  full gates run when no agent is active.
- Return a short summary: what changed, paths, test results, open issues. No file dumps.
