# manythreads — CLAUDE.md (AGENTS.md is a symlink to this file)

**Naming (owner rule): the product is `manythreads`. Never write the previous product name anywhere (the 6-letter Arabic word for "council") — code, packages
(`@manythreads/*`), env vars (`MANYTHREADS_*`), DB roles (`manythreads_*`), docs, UI copy, commits.**

manythreads is a self-hosted team collaboration platform (channels, threads, bots, Brain).
Build plan: `PLAN.md` (13 phases, binding decisions D1–D4 in its §3).
Contract: `docs/spec/SPEC-FINAL.md` v1.5.0. Operating model: `docs/spec/IMPLEMENTATION-GUIDE.md`.
Look and copy: `docs/spec/mockups-all.html` (huge — never read it whole; grep the section id:
onboarding app teams bots botgeneric setup workshop email surfaces connections cabinet brain).
Progress: `STATUS.md`. Known mistakes to avoid: `MISTAKES.md` — read it before starting work.

## Stack (pinned)
- Node 22, pnpm 10 workspaces, TypeScript strict, ESM only (`"type": "module"`), `moduleResolution: bundler`
  everywhere. Packages export TS source (`"exports": {".": "./src/index.ts"}`); run with `tsx`, no build step.
- Server: Fastify 5 + `fastify-type-provider-zod` (Zod type provider on every route), `@fastify/websocket`.
- Schemas: **Zod 4** in `packages/shared` (D1). Types via `z.infer`. JSON Schema via `z.toJSONSchema`.
- DB: **Postgres 19** (image `manythreads/postgres:19` = `postgres:19beta4` + pgvector 0.8.7, built from
  `deploy/postgres/Dockerfile`; build with `docker build --secret id=cacert,src=/root/.ccr/ca-bundle.crt -t manythreads/postgres:19 deploy/postgres`), driver `pg` (node-postgres). No ORM. No Redis/Valkey (D3).
- Tests: Vitest (unit/integration), Playwright (`e2e/`, projects `desktop` 1440×900, `mobile-web` 390×844).
- Web: React 19 + Vite, plain CSS with tokens in `clients/web/src/styles/tokens.css`.
- **Mobile (owner decision, replaces React Native): the same web app wrapped in Capacitor** (`clients/mobile`,
  phase 11). Desktop: the same web app in Tauri 2 (phase 10). One UI codebase for all clients.
- Lint: ESLint 9 flat config + typescript-eslint; Stylelint for CSS. `pnpm lint` and `pnpm typecheck` must pass.
- Deploy: docker compose (`deploy/compose`) for dev/CI/self-host; Helm chart (`deploy/helm`) on k3s with
  CloudNativePG (D4). Five default workloads: Postgres, LiteLLM, Hindsight, manythreads server(+web), Hermes.

## Repo layout
```
packages/shared        @manythreads/shared  — Zod schemas: ids, common, entities, api, events, bot-md, tokens
packages/kernel        @manythreads/kernel  — db (pool, withActor, migrate, mappers), identity, events, outbox,
                                          jobs, plugins host, capabilities broker, transport, storage
packages/sdk           @manythreads/sdk     — public plugin SDK surface (the ONLY thing plugins import from kernel)
packages/server        @manythreads/server  — Fastify host, loads plugins, HTTP/WS, /healthz /readyz
packages/test-utils    @manythreads/test-utils — persona presets, readAs, captureEvent, test DB helpers
packages/plugins/<n>   one plugin per package (manifest + server code + migrations/ + docs page)
clients/web            React web client (Tauri wraps it in phase 10); clients/mobile in phase 11
tools/plates tools/bench tools/fake-llm    plate comparison, benchmarks, fake OpenAI-compatible LLM
e2e/                   Playwright: api/<area>, <area>, visual/<area>, personas/<p>, __baselines__, fixtures
deploy/compose deploy/helm deploy/postgres  docs/ (plugin docs, retro/phase-N.md, spec/)
```

## Conventions (binding)
- **D1 Shared Zod:** every entity, API request/response, event payload and BOT.md frontmatter is a Zod
  schema in `packages/shared` (PLAN.md Appendix B naming rules). No `*Dto`/`*Model`/`*ViewModel` names
  (lint-banned). No `node:` imports, classes or functions-with-side-effects in `shared`. Client-sent
  schemas `.strict()`. Ids are branded. Dates are ISO strings on the wire.
- **One mapper per table** (`.../db/mappers/<table>.ts`) turns a row into the shared type. Nothing else.
- **One DB entry:** `withActor(actor, fn)` (sets `SET LOCAL app.actor_id/app.workspace_id/app.run_id`).
  No bare `pool.query` outside `packages/kernel/src/db/` (lint-enforced). System work uses `withSystem`, which
  connects as the real `manythreads_system` role (`app.is_system()` = `current_user`); never trust a GUC for privilege.
  Three DB roles: `manythreads_owner` (migrations), `manythreads_app` (requests), `manythreads_system` (system/workers).
  Non-system code that must touch system tables calls a narrow SECURITY DEFINER function (e.g. `app.enqueue_job`).
  Inside such definer functions `app.is_system()`/`is_workspace_admin()` are TRUE — check the caller with
  `app.lookup_workspace_role()` / `app.lookup_team_role()` instead.
- **One event registry:** `emit` validates against `packages/shared/src/events/registry.ts`, writes
  `events` + `outbox` in the same transaction. Event types are `domain.noun.verb`.
- **Schema task = triple:** Zod schema + SQL migration with RLS + mapper, in one diff.
- **SQL (D3):** `uuid` PK `DEFAULT uuidv7()`, `timestamptz`, `text` never varchar, enums as text+CHECK,
  every FK indexed, partial indexes for hot filters, BRIN on append-only time columns, UNLOGGED for
  ephemeral (leases, presence, typing). Every team/person-scoped table: `ENABLE` + `FORCE ROW LEVEL
  SECURITY` + a policy. Global tables must be in `global_tables` allowlist with a migration comment.
  Migrations: plain SQL, numbered, forward-only, never edit an applied file. Get-or-create via
  `INSERT … ON CONFLICT … DO SELECT RETURNING` through the one helper.
- Rate limits in process memory (sliding window), per replica. Never in the DB.
- **Visibility sets (RLS performance):** policies never call per-row functions for reads; hoist a uuid[] once per
  statement: `team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`, channels via
  `app.visible_channel_ids('read'|'post')`. The RLS harness fails on per-row policy calls (`findPerRowPolicyCalls`).
- Plugin SDK services (use them, don't re-implement): `ctx.db.getOneOrCreate`, `ctx.audit.emit`, `ctx.templates`,
  `ctx.readState`, `ctx.links`, `ctx.realtime.pushToPerson`, `ctx.jobs.register/enqueue` (extension `job.register`),
  `ctx.providers.get('storage')`, `ctx.providers.get<RepoProvider>('repo')` (team repo: write/restore/blob/tree/list — the only git writer),
  `ctx.access.readableTeamIds/readableChannelIds`, `ctx.realtime.pushToPeople/pushMany` (one statement per fan-out),
  `ctx.capabilities.authorize`, `ctx.jobs.register({ cron })`. Plugins can't import each other: reuse another plugin's behaviour via its HTTP route
  shape or an SDK service, never by copying.
- Server-side text processing must be linear-time (no nested regex quantifiers); add hostile-input timing tests.
- Plugins import only `@manythreads/sdk` and `@manythreads/shared`, never kernel internals. Plugin HTTP routes mount at
  their declared absolute path (e.g. `/api/channels/:id/messages`); duplicates fail at load.
- Test-only HTTP actor: header-based dev actor only with `NODE_ENV=test`, never `system`. Sessions (cookie + CSRF header) are the real
  auth; local e2e may use `POST /api/test/session` (only with `MANYTHREADS_TEST_AUTH_TOKEN`, refused in production). Live
  screenshots (`screenshots.yml`, runs after each release, commits to branch `screenshots`) set a per-run password via
  the admin CLI `pnpm --filter @manythreads/server admin set-password <email>` (stdin) and sign in through the real form.
- Capability names `namespace.verb` with a destructive tag. The broker denies bot actors writes to
  `bots/`, `TEAM.md`, `skills/`, `routines/` (and `files.*` writes to `memory/`, `inbox/`: bots write memory only via
  `memory.write`); `person:*` only for `conversation`/`mention` triggers.
- Team repo is text only (no attachments in git); guarded paths come from `isGuardedRepoPath` (@manythreads/shared) — never re-list them.
  `channels/` is reserved in the repo for the attachment folders of the Files tree, and so is `inbox/` (each team's memory
  inbox, spec §12.2). `memory/` is an OKF v0.2 bundle (spec §12.1, plan D6): every file has a `type`; the writer refuses the rest. Git runs argv-only with `GIT_LITERAL_PATHSPECS=1`.
- Embedded apps: `sandbox="allow-scripts"` (never `allow-same-origin`), CSP set by the route handler itself; server hooks key on
  `req.routeOptions.url`, never the raw URL (percent-encoding bypass, see MISTAKES).
- CSS: screen stylesheets prefix their classes (e.g. `f*` for Files); never redefine a shared class (`.linkish`, `.btn`) in a screen file.
- Fonts are self-hosted (`clients/web/public/fonts`); never load Google Fonts at runtime (breaks visual baselines).
- Design tokens only from `tokens.css` (raw hex anywhere else fails lint). Fonts: Inter Tight, JetBrains Mono.
- Screens carry `data-testid="app-frame"`; dynamic regions `data-vt-mask`; landmarks `data-landmark`.
- Commit messages start with the task id, e.g. `P1-03: migration runner`.

## Forbidden (spec §20 non-goals)
Pipeline designer; bot "mode" field; a second agent runtime (Hermes only); Kubernetes CRDs of our own;
attachments committed to git; a bot choosing its own memory bank; run-time loading of third-party JS
client plugins; voice/video; E2E encryption; plugin marketplace with payments; browser extension.

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
is deployed first into its own k3s namespace (`manythreads-ci`, `values-ci.yaml`) and the
browser tests run against that release; only a green run promotes the same build to the live
namespace (`manythreads`). Never install or run Playwright on a GitHub runner: its image has
no Chromium build.

## Agent rules (for every subagent)
- Read this file and `MISTAKES.md` first. Read only the spec/plan sections your task cites.
- Do not spawn subagents. Bash, not zsh.
- Code changes must leave `pnpm lint` and `pnpm typecheck` green for touched packages.
- The shared dev Postgres has 100 connections: with other agents running use vitest `--maxWorkers=3` and run only your specs;
  full gates run when no agent is active.
- Return a short summary: what changed, paths, test results, open issues. No file dumps.

## Plain language (every reply, doc, commit and UI string)
- **Never repeat text verbatim.** Do not echo the request, the prompt, a previous message or this file back at the reader.
  Paraphrase it, or leave it out. No filler openers, no restating the plan you were handed, no "as requested above".
- **No undefined jargon.** Define every term of art in plain words the first time it appears in a reply, a doc page or a
  commit message, even when this file already uses it — one clause, at the point of use: "the outbox — the queue of events
  written in the same transaction as the change that caused them". A reader who has not read `PLAN.md` or the spec must
  still follow the sentence.
- **The project's own shorthand counts as jargon** and gets the same treatment: outbox, task substrate, run, provider,
  capability, RLS (row-level security), persona, plate, definition / `BOT.md`, guardrail, memory bank, OKF bundle. If a
  term cannot be defined in one clause, the sentence is doing too much work — split it.
- A plugin doc page opens by saying what the plugin is and what a reader needs in order to use it, not by naming its phase.

## Sidebar contract (every client, every team)
Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) · Direct messages (45) ·
Bots (50). The Bots header opens the team's bot roster at `/t/<team>/bots`; a row opens the bot's page
(`/t/:team/bots/:botSlug`, the fourteen SPEC §7.2 tabs). The roster and page read the bots plugin's
`GET …/bots[/:botSlug]`; the definition is `bots/<slug>/BOT.md` in the team repo (read via `repo/blob`, saved via
`repo/commit` with `baseBlobSha`) — the team's lead and a workspace admin write an existing bot directly (a non-lead member is offered the file instead of Save); only an admin adds or removes a bot. The repo writer refuses the rest with 403.

## Owner decisions (durable)
- Approved: the orchestrator merges its own phase PRs into `main` without asking.
- `bots/` (BOT.md): a team lead edits a bot that already exists; only a workspace admin adds or removes one (SPEC §3
  set by owner request). In the Files screen `bots/` stays admin-only for everyone — a bot is edited on its Bots page.
  `TEAM.md`, `skills/` and `routines/` stay lead-or-admin.
- Mobile = web app inside Capacitor (not React Native). The RN benchmark gate is replaced by a Capacitor
  WebView check in phase 11.
- Owner asked for free-form ops workflows (any command / any SQL); the permission classifier blocks committing
  them, so they stay out of the repo until the owner adds a permission rule.

## Environment notes
- Windows dev loop (local edit + lint + typecheck, rsync to the devbox, build/test/deploy/verify there — no WSL):
  `WINDOWS_DEV.md`; scripts in `tools/devbox/` (`Check.ps1`, `Sync-Up.ps1`, `Remote.ps1`, `Ship.ps1`).
- Local docker daemon: start with `(dockerd >/tmp/dockerd.log 2>&1 &)` if `docker info` fails.
- Deploy target: k3s at manythreads.kahf.to. The GitHub Actions are the trigger, not the builder: the `ci` workflow
  copies the code to the devbox and runs `tools/devbox/ci.sh` there (build, test in the `manythreads-ci` namespace,
  then deploy to `manythreads`); `release` tags the phase; `deploy` re-deploys on demand.
  Phase exit: merge PR to main, with title "Phase N · <name>" — `release.yml` runs on that merge:
  it tags `phase-N` + `v0.N.0` (the sandbox cannot push tags: 403), and the `ci` workflow of the same push builds,
  tests and deploys it. `ops-*` workflows; `docs/deploy.md`.
  Read Actions results with GitHub MCP tools (`mcp__github__actions_list`, `get_job_logs`, tail ≤ 150).
- The devbox has two checkouts: `/root/manythreads` (the Windows dev loop's, `Sync-Up.ps1`) and `/root/ci` (the
  pipeline's scratch copy, rewritten by every CI run). Never rsync over the first while another agent works in it.
