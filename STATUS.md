# STATUS

Current phase: **5 · Bots, gateways, conversations and Brain** — in progress: P5-00 reflect verified, **P5-03 schema and P5-04 loader + pairing landed** (both green on the devbox; see "Phase 5 so far"). Phase 4 is finished: merged PR #6, `release.yml` success 2026-10-02 14:10Z (tagged `phase-4` / `v0.4.0`, deployed), screenshots run success 14:13Z (live shots on the `screenshots` branch under `phase-4/{desktop,mobile}/`). Retro: `docs/retro/phase-4.md`.

Owner instruction (2026-10-02, later the same day): phase 4's stop instruction is fulfilled — **continue building per PLAN.md, updating STATUS.md as work lands.** Also: avoid the entries in `MISTAKES.md` and append anything new there.

Owner standing instruction (2026-10-03): after every task that is deployed and verified on the devbox, take
screenshots of the feature, save them in `temp/screenshots/` (gitignored), and open Chrome on the gallery
`temp/screenshots/index.html` to show all of them. Tooling: `e2e/screens/task.config.ts` plus one
`e2e/screens/task.<task>.shots.ts` per task (`*.shots.ts`, never `*.spec.ts`, so the normal `pnpm e2e` never picks
them up) — run `MANYTHREADS_LIVE_PASSWORD=... pnpm -C e2e exec playwright test -c screens/task.config.ts` against the
live site; each shots file rebuilds the gallery over the whole folder in `afterAll`. The shots may drive the feature
for real on live (a lead committing to the demo repo to fire the loader, a minted-then-revoked pairing token):
secrets never land in the pictures (tokens redacted, revoked in the same run).

Owner request (2026-10-04): a bot's `BOT.md` is edited by the **team's lead or a workspace admin**; only a workspace
admin **adds or removes** a bot. A non-lead member reads the roster and every tab but not edit. Implemented as a real
rule, not a hidden button: the repo writer requires an admin for a `bots/` path that is new or deleted and a lead for an
existing one (`app.can(team, 'manage')` + `app.is_workspace_admin()`), and the bot editor's `canEdit` is lead-or-admin.
The Files tree still offers `bots/` read-only to everyone but an admin (a bot is edited on its Bots page). `TEAM.md`,
`skills/` and `routines/` stay lead-or-admin (SPEC §3, restated for `bots/`).

**Open on main:** CI green — `ci` run 37144311363 on **`f24ca75`** (STATUS header) passed every step incl.
End-to-end (verify 10m6s). Before it: 37143552731 on `52013bf`, 37142818365 on `feb935c`, 37142052270 on `8316c1f`, 37141297569 on `dd4353e`, 37140658508 on `5e3774f` (flaky read-state test fix); that fix was needed
because the run before it went red on a docs-only push (`read-state.test.ts:137` used a random uuid as the
mark-read position — fixed, lesson in `MISTAKES.md`). Earlier greens: 37138533733 on `237fa30` (screenshot cycle),
37118752282 on `e7d72cf`. The `50f2fd1` red stays closed: the min-password-8 change left `'too-short'`
(9 characters) *valid*, so the old disabled-button assertion broke — every vitest suite had been updated but this one e2e literal still probed the old 12 boundary (fix `b16096e` fills `'short'`; devbox `pnpm e2e identity/account.spec.ts` 3 passed; lesson in `MISTAKES.md`). The two older reds stay closed: the embedded-app e2e race was fixed with a find-then-`framenavigated` wait (30 s budget); the phase-3 visual pixel diff (`channel-thread.visual.spec.ts` "P,6%", 6.85% vs 6%) was **test-calibration, not a product regression** — unmasked live `.replies` counters, a one-shot scroll + fixed 150 ms wait landing ≥1 px off (the doubled-text diff signature; dominant), and no forced font loading. Fixed in phase-4 `c8e0c26` (`.replies` in `liveMasks`, `fontsLoaded()`, steady-state scroll + `networkidle`); the ratio is deterministic at **4.53% in both phase-4 and phase-5 CI** (1.5 pt under the limit).

| Phase | State | Tag |
|---|---|---|
| 1 Foundations | done — gate green locally and in CI; retro `docs/retro/phase-1.md` | phase-1 / v0.1.0 |
| 2 Identity, workspace, teams | done — CI green, merged PR #4 (retro docs/retro/phase-2.md) | phase-2 / v0.2.0 |
| 3 Channels, threads, DMs | gate green locally (lint, typecheck, 1,617 unit tests, rls, events, schema-compat, e2e api 60 / desktop 115 / mobile-web 14, vt 32, bench:search p95 182 ms at 1M, bench:rls 55 ms); retro `docs/retro/phase-3.md` | phase-3, v0.3.0 (deployed, live shots in docs/retro/screens/phase-3/live) |
| 4 Files and the team repo | done — merged PR #6, released and deployed; gate green locally (lint, typecheck, test 2,076, rls 262, events 122, schema-compat 370, e2e 247, vt); security review 1C/4M/6L fixed; retro `docs/retro/phase-4.md` | phase-4 / v0.4.0 (live shots on the `screenshots` branch) |
| 5 Bots, gateways, conversations, Brain | in progress — P5-00 reflect verified, **P5-03 done**, min-password-8 landed (owner decision), **P5-04 done** (loader + pairing + events; devbox gate green: 2,126 passed / 53 skipped; CI green at `b16096e`, run 37118010707); **P5-01 + P5-02 spikes done** (slack-compat door + Hermes adapter proven, per-run URL decision); **P5-05 done** (BOT.md editor: roster + 14-tab page + red banner; 6 new e2e specs green on the devbox; gate green: 2,143 passed / 53 skipped); next P5-06 | |
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
- Owner rule (2026-10-03): GitHub Actions minutes are limited — Actions are for building and deploying to k3s only
  (`ci`, `release`, `deploy`, manual `ops-*`); everything else runs from the devbox over SSH. `screenshots.yml` is
  manual-dispatch only (its post-`release` auto-trigger is removed): phase-exit live shots run on the devbox and the
  pictures reach the `screenshots` branch from here; per-task shots already work that way (`temp/screenshots/` via
  `task.*.shots.ts` + `Sync-Down.ps1`).
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
  spike endpoint's bearer auth is `bot_pairing_tokens`, so the schema landed first. **Hermes is now installed on the
  devbox** from the official installer only (`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`;
  docs https://github.com/nousresearch/hermes-agent — never vendored into this repo). The installer's interactive
  `setup`/gateway step was skipped (no terminal in a scripted shell) and its `git clone` is flaky (a retry works).
  Both spikes ran against Hermes v0.21.5+6232 (`/root/.local/bin/hermes` — not on the non-interactive PATH;
  source `~/.hermes/hermes-agent`; deps via `uv run --project ~/.hermes/hermes-agent`).
- **P5-04 done — loader + pairing:** `bots.register` wires a `repo.repo.committed` subscription: strict parse
  (line-scanned `---` fence → `yaml` → `BotFrontmatter`) in the outbox consumer's system transaction. Valid → upsert
  (a hand-`disabled` row stays disabled), bot actor via `getOneOrCreate`, `handover.mayTag` compiled into the bot's
  `tasks.handoff` grant (upserted while present, deleted when the key leaves), `bots.bot.loaded`. Invalid → the row
  stays live as `status='invalid'` with its last-good definition and `bots.bot.invalid` carries `fieldPath` +
  `message` (**decision: no error column — the team-readable event is the alert P5-05's red banner reads**); a file
  that never loaded once → event only. Delete → row + grants gone (tokens/runs cascade), actor row kept,
  `bots.bot.removed`. Pairing: `0002_pairing.sql` `mint`/`revoke`/`resolve` SECURITY DEFINER functions (manage guard
  `coalesce(lookup_can_team…)` + `session_user`, never `is_*`) and two manage-gated routes (`POST`/`DELETE
  /api/teams/:slug/bots/:botSlug/pairing-tokens`, token shown once, sha256 stored only). **Deviation: resolve has no
  HTTP route** — plugins share behavior through the `app` schema, so the P5-09 gateway calls
  `app.bots_pairing_resolve(sha256(token))` in-process (`resolvePairingToken` exported for that and for tests).
  Three events in the shared registry; tests: `bot-md` 7, `loader` 6, `pairing` 5; 7 schema-compat snapshots;
  `docs/plugins/bots.md` documents loader, pairing and events.
- **Min password length 8 (owner decision):** the minimum went 12 → 8 everywhere — kernel/shared constants, UI copy,
  `.github/actions/lib/remote.sh`, tests, persona fixtures, 4 regenerated schema-compat snapshots. Windows
  `Check.ps1` and devbox `remote-gates.sh` both green (2,101 passed / 53 skipped); committed `9954842` (was `0fc2bdb` before the rebase onto `78ba8c2`).
- **P5-02 done — per-run tool scoping decision:** `docs/spikes/per-run-scoping.md` (committed
  `86ef2d4`). Hermes v0.21.5 has no per-run tool-scope primitive (static `mcp_servers` per
  config file; only per-invocation `-t/--resume/-p/-q` selection), while our side already carries
  the run (`app.run_id` + `run_source_log` policy from P5-00/P5-03) — so P5-09 mints **one MCP
  endpoint URL + bearer token per run** and `runtime-hermes` launches one Hermes invocation per
  run against it. The live two-concurrent-runs experiment moves to P5-09 (needs the gateway +
  conversations). Committed `86ef2d4`.
- **P5-01 done — slack-compat spike + Hermes adapter proof:** public
  `POST /api/slack-compat/chat.postMessage` (`{token, channel, thread_ts, text}` → 60/min
  limit, pairing-token resolve, `slack-compat.deliver` SYSTEM job lands the message idempotently;
  spike-only direct `app.messages` write, flagged for P5-10) in `packages/plugins/slack-compat/`
  with docs `docs/plugins/slack-compat.md` and report `docs/spikes/slack-compat.md`. Hermes side:
  bundled Slack is Socket-Mode-only (verified, cannot be repointed); new outbound adapter
  `~/.hermes/plugins/manythreads/` (reference copy `docs/spikes/slack-compat-adapter/` + proof
  scripts) holding the pairing token only. Proven: vitest 2 passed; `hermes plugins doctor` OK;
  `prove_adapter.py` (real `platform_registry`, exact wire shape) passed; `prove_live.mts` live
  loop passed (real adapter → scratch server → reply in #dev thread readable via API). Model
  authorship deferred to P5-10 (devbox holds no model credential). Next: P5-05 BOT.md editor.
- **P5-01 deployed to live (2026-10-03):** `Ship.ps1` plain: remote gates green (the run before
  caught a CRLF worktree — `* text=auto eol=lf` in `.gitattributes` now, see MISTAKES), image
  `manythreads/server:acba305dd147-b6e7cfbd`, helm rev 7, 36 migrations, `slack-compat` in the
  live plugin list, `/` 200, `/healthz`+`/readyz` ok.
- **Screenshot cycle for P5-01:** `e2e/screens/task.p5-01.shots.ts` (mint → root → door → revoke,
  token redacted + revoked in-run; new reusable `tools/devbox/task-shots.sh` does the one-off live
  password, the run and the rotation with secrets on stdin only): 1 passed. Two failures on the way
  are in MISTAKES: the first door call went through `page.request` (carries the sign-in session
  cookie → host 403 cookie-without-CSRF by design — the door needs a fresh anonymous context, the
  true Hermes shape), then `doorRes.json()` after `anon.close()` (response disposed). Gallery
  `temp/screenshots/index.html` (p5-01-door-api, p5-01-thread: the bot reply in the #dev thread
  panel), opened in Chrome. Live side effects: a few labeled `[spike P5-01]` roots + replies in
  #dev; the final revoke turned off all 7 tokens minted across the runs — no live tokens remain.
- **Push pending (owner):** commits `86ef2d4` (P5-02), `c557354` (P5-01), `43d5d8c` (STATUS/MISTAKES),
  `27bb4a7` (.gitattributes), `5ee5982` + `565bdf6` + later shots commits are ahead of `origin/main` —
  `git push` from Windows hangs on the Git Credential Manager GUI prompt (no stored github
  credential), so the owner runs it (or pushes from the devbox).
- **Gate:** Windows `Check.ps1` (lint + typecheck) green over 26 workspaces; devbox `remote-gates.sh` green
  (install + lint + typecheck + tests: 135 files, 2,101 passed, 53 skipped). Two failures on the way there are in
  `MISTAKES.md`: `app.threads` is keyed by `root_message_id` (a bad FK took down every server-starting test), and
  the devbox had no Playwright browser/deps for e2e.
- **P5-04 deployed to live (2026-10-03):** `tools/devbox/Ship.ps1` run plain (second run, exit 0 — the first died
  on the `*>&1 | Tee-Object` trap now in `MISTAKES.md`): remote gates green (2,126 passed / 53 skipped), image
  `manythreads/server:acba305dd147-eb9cc3f8`, helm rev 6, 36 migrations, `bots` plugin active, `/` 200,
  `/healthz`+`/readyz` ok. Pairing route: 401 anonymous (was 404 before the deploy), 404 signed-in with no bot row
  (the loader only sees commits made after the deploy).
- **Screenshot cycle, first run for P5-04:** `e2e/screens/task.config.ts` + `e2e/screens/task.p5-04.shots.ts`, run
  on the devbox (this machine had no Playwright browser yet — a local `playwright install chromium` stalls after the
  download, so shots run remote and `Sync-Down.ps1` brings `temp/screenshots/` home): 4 passed in 12 s. The
  `pairing round trip` test fired the live loader for real — probe mint 404 → marker commit into
  `bots/coder/BOT.md` (201, `c472255c…`) → the loader upserted the row → mint 201 → revoke `{revoked:1}`; the story
  renders with the token redacted as `temp/screenshots/p5-04-pairing-api.png`, beside the BOT.md file view, its  History with the loader commit, and the roster. Gallery `temp/screenshots/index.html`, opened in Chrome per the standing instruction. Live side effects: one invisible `<!-- refreshed … -->` marker line plus one commit in the demo repo's history; no live tokens remain.

- **P5-05 done — the BOT.md editor (roster + bot page):** the roster and one bot's page read the rows the loader wrote, the
  definition is the repo file. `shared` gained `api/bots/bots.ts` (`BotSummary` = `Bot` + `name`/`role`/`mayTag`/`invalid`, `ListBotsResponse`,
  `GetBotResponse` = row + definition path + newest 20 runs, `botMdPath`, `BOT_SLUG_RE`) and `entities/bot.ts` gained `name`/`role`;
  `plugins/bots` migration `0003_bot_display.sql` (`name`, `role`, `may_tag`; `name` backfilled from the slug), the loader upserts them,
  and `src/roster.ts` registers `GET /api/teams/:slug/bots` and `GET /api/teams/:slug/bots/:botSlug` (**no error column**: the newest
  team-readable `bots.bot.invalid` event is the row's `invalid` reason and the page's red banner). Web: `screens/bots/*` (roster, the
  fourteen tabs of SPEC §7.2 incl. Contract, `b*`-prefixed `styles/bots.css`), routes `/t/:team/bots[/:botSlug]`, sidebar Bots entry now
  `/t/<team>/bots`, Save = one `repo/commit` as the person (a **workspace admin** writes `bots/` directly; a team lead and a member get
  the read-only note and the file — the writer refuses both 403), a save based on a stale `baseBlobSha` is refused 409 rather than overwritten. Bugs found and fixed while testing (MISTAKES):
  the draft was a `useMemo` not state, so edits were dropped and Save committed a reformat of the old file; `dirty` now compares the
  canonical render, not the file bytes.
- **P5-05 verification:** Windows `Check.ps1` green (lint + typecheck, 26 workspaces); devbox `remote-gates.sh` green (141 files,
  2,143 passed / 53 skipped; one kernel/rls `read-state` test failed in the first run and passed on re-run — flaky, not related); devbox
  e2e `bots/roster.spec.ts` + `bots/botmd-editor.spec.ts` 6 passed, `shell/shell.spec.ts` + `shell/sidebar-contract.spec.ts` 15 passed
  (the shell spec moved to `/t/engineering/bots`); schema-compat 389 passed (5 new api snapshots + `entity.Bot` updated).
- **P5-05 deployed to live (2026-10-04):** `Ship.ps1` run backgrounded (exit 0): local gates green, remote gates green (2,143 passed /
  53 skipped), image `manythreads/server:acba305dd147-8f22d7ea`, helm rev 8, 37 migrations, `bots` plugin active, `/` 200,
  `/healthz`+`/readyz` ok. **Screenshot cycle:** `tools/devbox/task-shots.sh omar@kahf.example task.p5-05.shots.ts` (one-off live
  password, rotated after) — 5 passed, `Sync-Down.ps1` brought `temp/screenshots/p5-05-{roster,roster-invalid,bot-identity,bot-capabilities,bot-audit,invalid-banner}.png`
  home and the gallery `temp/screenshots/index.html` rebuilt; opened in the Preview tab (8 images, all loading). Live side effects:
  two commits in the demo repo's history (break `bots/coder/BOT.md`, then restore the exact original bytes) — the file is back as it was.
