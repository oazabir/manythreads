# manythreads — CLAUDE.md (AGENTS.md is a symlink to this file)

**Naming (owner rule): the product is `manythreads`. Never write the previous product name anywhere (the 6-letter Arabic word for "council") — code, packages
(`@manythreads/*`), env vars (`MANYTHREADS_*`), DB roles (`manythreads_*`), docs, UI copy, commits.**

manythreads is a self-hosted team collaboration platform (channels, threads, bots, Brain).
Build plan: `PLAN.md` (13 phases, binding decisions D1–D4 in its §3).
Contract: `docs/spec/SPEC-FINAL.md` v1.4.1. Operating model: `docs/spec/IMPLEMENTATION-GUIDE.md`.
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
- Plugins import only `@manythreads/sdk` and `@manythreads/shared`, never kernel internals. Plugin HTTP routes mount at
  their declared absolute path (e.g. `/api/channels/:id/messages`); duplicates fail at load.
- Test-only HTTP actor: header-based dev actor only with `NODE_ENV=test`, never `system`. Sessions (cookie + CSRF header) are the real
  auth; e2e/screenshots use `POST /api/test/session` (only when `MANYTHREADS_TEST_AUTH_TOKEN` is set; see `docs/testing.md`).
- Capability names `namespace.verb` with a destructive tag. The broker denies bot actors writes to
  `bots/`, `TEAM.md`, `skills/`, `routines/`; `person:*` only for `conversation`/`mention` triggers.
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
pnpm test:rls  pnpm test:events  pnpm test:schema-compat  (later: test:memory-cross-team, test:runtime-rules)
pnpm db:up / db:down    # dev Postgres 19 via deploy/compose (port 55432, user manythreads_owner)
pnpm e2e                # playwright (runs from e2e/; never `playwright` from root);  pnpm e2e --project=api
pnpm vt / vt:update     # plate visual comparison (tools/plates)
pnpm --filter @manythreads/tools-bench bench:server   # benchmarks
```
Keep command output small: pipe through `tail -n 40` or grep for failures. Never paste whole logs.

## Agent rules (for every subagent)
- Read this file and `MISTAKES.md` first. Read only the spec/plan sections your task cites.
- Do not spawn subagents. Bash, not zsh.
- Code changes must leave `pnpm lint` and `pnpm typecheck` green for touched packages.
- Return a short summary: what changed, paths, test results, open issues. No file dumps.

## Sidebar contract (every client, every team)
Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) · Direct messages (45) ·
Bots (50). The Bots header opens the team roster; a bot's name opens its conversation view.

## Owner decisions (durable)
- Approved: the orchestrator merges its own phase PRs into `main` without asking.
- Mobile = web app inside Capacitor (not React Native). The RN benchmark gate is replaced by a Capacitor
  WebView check in phase 11.
- Owner asked for free-form ops workflows (any command / any SQL); the permission classifier blocks committing
  them, so they stay out of the repo until the owner adds a permission rule.

## Environment notes
- Local docker daemon: start with `(dockerd >/tmp/dockerd.log 2>&1 &)` if `docker info` fails.
- Deploy target: k3s at manythreads.kahf.to via GitHub Actions only (SSH not reachable from the sandbox).
  Phase exit: merge PR to main, with title "Phase N · <name>" — `release.yml` runs on that merge:
  it tags `phase-N` + `v0.N.0` and deploys latest main (the sandbox cannot push tags: 403). `ops-*` workflows; `docs/deploy.md`.
  Read Actions results with GitHub MCP tools (`mcp__github__actions_list`, `get_job_logs`, tail ≤ 150).
