# STATUS

Current phase: **5 · Bots, gateways, conversations and Brain** — in progress: P5-00 reflect verified, **P5-03 schema landed and green on the devbox** (see "Phase 5 so far"). Phase 4 is finished: merged PR #6, `release.yml` success 2026-10-02 14:10Z (tagged `phase-4` / `v0.4.0`, deployed), screenshots run success 14:13Z (live shots on the `screenshots` branch under `phase-4/{desktop,mobile}/`). Retro: `docs/retro/phase-4.md`.

Owner instruction (2026-10-02, later the same day): phase 4's stop instruction is fulfilled — **continue building per PLAN.md, updating STATUS.md as work lands.** Also: avoid the entries in `MISTAKES.md` and append anything new there.

**Open on main:** CI is red on the last two phase merges — `Phase 3` run 36997072944 failed on one visual pixel diff; `Phase 4` run 37017976239 failed on `e2e/files/embedded-app.spec.ts` (the fixture app's probe had written its JSON but `html[data-probed="1"]` was still not there within 15 s — 1 failed / 248 passed; 12/12 green on the devbox, so it is the runner's budget, not the logic). The wait is now 30 s (committed with this batch); a push re-runs CI on main. The phase-3 visual pixel diff is untouched — run the full `pnpm vt` before the next phase merge.

| Phase | State | Tag |
|---|---|---|
| 1 Foundations | done — gate green locally and in CI; retro `docs/retro/phase-1.md` | phase-1 / v0.1.0 |
| 2 Identity, workspace, teams | done — CI green, merged PR #4 (retro docs/retro/phase-2.md) | phase-2 / v0.2.0 |
| 3 Channels, threads, DMs | gate green locally (lint, typecheck, 1,617 unit tests, rls, events, schema-compat, e2e api 60 / desktop 115 / mobile-web 14, vt 32, bench:search p95 182 ms at 1M, bench:rls 55 ms); retro `docs/retro/phase-3.md` | phase-3, v0.3.0 (deployed, live shots in docs/retro/screens/phase-3/live) |
| 4 Files and the team repo | done — merged PR #6, released and deployed; gate green locally (lint, typecheck, test 2,076, rls 262, events 122, schema-compat 370, e2e 247, vt); security review 1C/4M/6L fixed; retro `docs/retro/phase-4.md` | phase-4 / v0.4.0 (live shots on the `screenshots` branch) |
| 5 Bots, gateways, conversations, Brain | in progress — P5-00 reflect verified, **P5-03 done** (schema + RLS + mappers + tests; devbox gate green: lint, typecheck, 2,101 tests / 53 skipped); next P5-01/P5-02 spikes, then P5-04 loader | |
| 6–13 | not started | |

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

## Phase 5 so far
- **P5-00 reflect, checked against the code (no refactor needed):** the one entity-link resolver is already the SDK's
  `ctx.links.resolve` (P3-04); `repo.repo.committed` already carries `paths` (`put`/`delete`), so a bot reload reads
  one event instead of diffing; `withActor` already carries a run (`Actor.runId` → `app.run_id`) — the new
  `run_source_log` insert policy is written on it. `Citation` goes in `shared` the moment P5-18 defines it. The
  viewer question ("did any viewer assume a person is looking?") is open for P5-18's Answer surface. Retro
  `docs/retro/phase-5.md` still to be written at the phase's end.
- **P5-03 done — schema triple in one diff:** `packages/plugins/bots` (manifest `dependsOn: ['channels']`,
  migration `0001_bots.sql` — per-plugin numbering, so `0001`, not PLAN's `0030`), `shared/entities/bot.ts`
  (`Bot`, `BotRun`, `RunSourceLogEntry` + the `BotStatus`/`BotRunTrigger`/`BotRunStatus`/`RunSourceScope` enums),
  `plugins/bots/src/rows.ts` mappers, `docs/plugins/bots.md`, `botsMigrationSource` in test-utils, enum-map entries
  in `kernel/test/schema-enums.test.ts`, 7 schema-compat snapshots.
  RLS: `bots` readable by team readers, plus workspace-visible bots for non-guest workspace members, writes system
  only (the loader owns the table); `bot_pairing_tokens` system-only with **no** app grant (session_tokens rule);
  `bot_runs` readable by team or asker, app INSERT only for the caller in a team it can read, status changes system;
  `run_source_log` readable with the run's team, appended only by the run itself (`run_id = app.run_id()`).
  Read plans hoisted (`findPerRowPolicyCalls` asserted).
- **Order note:** PLAN puts the P5-01/P5-02 spikes first, but both need the Hermes source (not in this repo) and the
  spike endpoint's bearer auth is `bot_pairing_tokens`, so the schema landed first. Spikes are next as soon as the
  Hermes source is available — they gate the rest of the phase.
- **Gate:** Windows `Check.ps1` (lint + typecheck) green over 26 workspaces; devbox `remote-gates.sh` green
  (install + lint + typecheck + tests: 135 files, 2,101 passed, 53 skipped). Two failures on the way there are in
  `MISTAKES.md`: `app.threads` is keyed by `root_message_id` (a bad FK took down every server-starting test), and
  the devbox had no Playwright browser/deps for e2e.
