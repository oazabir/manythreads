# STATUS

Current phase: **2 · Identity, workspace and teams** — gate green locally; release pending CI

| Phase | State | Tag |
|---|---|---|
| 1 Foundations | done — gate green locally and in CI; retro `docs/retro/phase-1.md` | phase-1 / v0.1.0 |
| 2 Identity, workspace, teams | gate green locally (retro docs/retro/phase-2.md) | pending |
| 3–13 | not started | |

## Phase 1 summary
All tasks P1-01…P1-13 merged with reviewer PASS (P1-04b security hardening added: system actor = real
`manythreads_system` role). Benchmarks: `docs/retro/bench-phase-1.md`. Deploy: `docs/deploy.md`.
Screens: `docs/retro/screens/phase-1/`.

## Follow-ups carried into later phases
- Trigram search plan under RLS needs scoping/plan check before phase 3 search.
- Response schemas enforced for 200 only; extend per route as needed.
- CNPG `manythreads_owner` is superuser (needed for extensions/roles); CNPG chart version unpinned.
- `it.todo`: Zod enum vs SQL CHECK comparison test — do in phase 2 when first enum tables land.
- pnpm cyclic workspace dep warning (kernel ↔ test-utils ↔ server devDeps).
- Mobile is Capacitor (owner decision): phase 11 builds clients/mobile wrapping the web app; the RN benchmark
  is replaced by a Capacitor WebView check (the Chromium 390×844 proxy already passed).
- Dev-header actor (`packages/server/src/dev-actor.ts`) must be replaced by real auth in phase 2
  (keep a test-only auth bypass for screenshots, gated by env).

## Carried into phase 3 (first tasks)
- RLS policy cost: app.can() per row → 77s unscoped count on 300k rows; build caller's readable-team set once per
  query (prototype 0.48s) — first phase 3 task, design in docs/retro/phase-2.md.
- Server hosts no job worker yet (KMS re-wrap job exists but nothing runs it).
- Flaky load of kernel/test/events/emit.test.ts (~1 in 4) — parallel test-DB setup.
- Plugins duplicate kernel helpers (get-or-create, template loader) — add SDK helpers.
- Zod enum vs SQL CHECK map test; last-lead protection; invite-accept rate-limit tests.
- New kernel migrations start at 0011.

## Environment / blockers
- SSH to the server is blocked from the sandbox; deploys run from GitHub Actions (secret ROOT_PASSWORD).
  Deploy rule (owner): pushing a version tag `v*` deploys latest `main`. Each phase exit: PR → main,
  tag `phase-N` + `v0.N.0`. Ops workflows: ops-rollout/restart/rollback/logs/status (dispatch from main).
- Owner approved self-merge of phase PRs to main. Owner requested ops-run / ops-db free-form workflows; the
  permission classifier blocks committing them — needs an owner permission rule.
- Owner rule: product name is manythreads; repo-wide rename pending (after the P2 schema agent commits).
