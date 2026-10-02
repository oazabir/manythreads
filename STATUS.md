# STATUS

Current phase: **4 · Files and the team repo** — all tasks done except optional P4-12 (deferred); security review fixed; local gate green (lint, typecheck, test 2,076, rls 262, events 122, schema-compat 370, e2e + vt). Exit: merge PR "Phase 4 · Files and the team repo", release + live screenshots. Retro: docs/retro/phase-4.md.

Owner instruction (2026-10-02): **stop the loop after phase 4 finishes** (merge + release + live screenshots), do not start phase 5.

| Phase | State | Tag |
|---|---|---|
| 1 Foundations | done — gate green locally and in CI; retro `docs/retro/phase-1.md` | phase-1 / v0.1.0 |
| 2 Identity, workspace, teams | done — CI green, merged PR #4 (retro docs/retro/phase-2.md) | phase-2 / v0.2.0 |
| 3 Channels, threads, DMs | gate green locally (lint, typecheck, 1,617 unit tests, rls, events, schema-compat, e2e api 60 / desktop 115 / mobile-web 14, vt 32, bench:search p95 182 ms at 1M, bench:rls 55 ms); retro `docs/retro/phase-3.md` | phase-3, v0.3.0 (deployed, live shots in docs/retro/screens/phase-3/live) |
| 4 Files and the team repo | gate green locally (lint, typecheck, test 2,076, rls 262, events 122, schema-compat 370, e2e 247 + fixes, vt); security review 1C/4M/6L fixed; retro `docs/retro/phase-4.md` | pending release.yml |
| 4–13 | not started | |

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

## Phase 3 review follow-ups (e5fe15e)
- Deleting a message leaves its attached files downloadable to channel readers — decide (hide/delete with message).
- read_state_bump callable with arbitrary recipients from plugin SQL (not HTTP) — tighten when plugins become third-party.
- Channel/team cascade delete orphans blobs (no delete route yet) — add blob GC job before delete routes exist.
- Lead/admin can self-add to a private channel of their team (by design, audited) — confirm with spec wording.

## Environment / blockers
- SSH to the server is blocked from the sandbox; deploys run from GitHub Actions (secret ROOT_PASSWORD).
  Deploy rule (owner): pushing a version tag `v*` deploys latest `main`. Each phase exit: PR → main,
  tag `phase-N` + `v0.N.0`. Ops workflows: ops-rollout/restart/rollback/logs/status (dispatch from main).
- Owner approved self-merge of phase PRs to main. Owner requested ops-run / ops-db free-form workflows; the
  permission classifier blocks committing them — needs an owner permission rule.
- Owner rule: product name is manythreads; repo-wide rename pending (after the P2 schema agent commits).

## Phase 4 Wave A follow-ups (for Wave B)
- P4-09/10 done (2810c42). FilePanel reads/saves via repo-git blob + commit routes (baseBlobSha); repo blobs have no `url`
  (SVG in repo won't render) — tree/content API should serve a URL. `channels/` paths wait for the tree API (P4-06).
- Sandboxed app subresources lack SameSite cookies (opaque origin): real app content route needs a signed per-open token.
- Markdown >200 KB opens Raw only (marked quadratic on hostile emphasis).
- `pnpm vt` / full e2e flake under parallel agents (Postgres connection slots) — run gates with agents idle.
