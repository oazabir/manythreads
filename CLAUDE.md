# Majlis — CLAUDE.md (AGENTS.md is a symlink to this file)

Majlis is a self-hosted team collaboration platform (channels, threads, bots, Brain).
Build plan: `PLAN.md` (13 phases, binding decisions D1–D4 in its §3).
Contract: `docs/spec/SPEC-FINAL.md` v1.4.1. Operating model: `docs/spec/IMPLEMENTATION-GUIDE.md`.
Look and copy: `docs/spec/mockups-all.html` (huge — never read it whole; grep the section id:
onboarding app teams bots botgeneric setup workshop email surfaces connections cabinet brain).
Progress: `STATUS.md`. Known mistakes to avoid: `MISTAKES.md` — read it before starting work.

## Stack (pinned)
- Node 22, pnpm 10 workspaces, TypeScript strict, ESM only (`"type": "module"`), `moduleResolution: bundler`
  for libs consumed by Vite, `NodeNext` for server packages. Run TS with `tsx` in dev/tests.
- Server: Fastify 5 + `fastify-type-provider-zod` (Zod type provider on every route), `@fastify/websocket`.
- Schemas: **Zod 4** in `packages/shared` (D1). Types via `z.infer`. JSON Schema via `z.toJSONSchema`.
- DB: **Postgres 19** (image `majlis/postgres:19` = `postgres:19beta4` + pgvector, built from
  `deploy/postgres/Dockerfile`), driver `pg` (node-postgres). No ORM. No Redis/Valkey (D3).
- Tests: Vitest (unit/integration), Playwright (`e2e/`, projects `desktop` 1440×900, `mobile-web` 390×844).
- Web: React 19 + Vite, plain CSS with tokens in `clients/web/src/styles/tokens.css`.
- Lint: ESLint 9 flat config + typescript-eslint; Stylelint for CSS. `pnpm lint` and `pnpm typecheck` must pass.
- Deploy: docker compose (`deploy/compose`) for dev/CI/self-host; Helm chart (`deploy/helm`) on k3s with
  CloudNativePG (D4). Five default workloads: Postgres, LiteLLM, Hindsight, Majlis server(+web), Hermes.

## Repo layout
```
packages/shared        @majlis/shared  — Zod schemas: ids, common, entities, api, events, bot-md, tokens
packages/kernel        @majlis/kernel  — db (pool, withActor, migrate, mappers), identity, events, outbox,
                                          jobs, plugins host, capabilities broker, transport, storage
packages/sdk           @majlis/sdk     — public plugin SDK surface (the ONLY thing plugins import from kernel)
packages/server        @majlis/server  — Fastify host, loads plugins, HTTP/WS, /healthz /readyz
packages/test-utils    @majlis/test-utils — persona presets, readAs, captureEvent, test DB helpers
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
  No bare `pool.query` outside `packages/kernel/src/db/` (lint-enforced). Use `withSystem` for system actor.
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
- Plugins import only `@majlis/sdk` and `@majlis/shared`, never kernel internals.
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
pnpm db:up / db:down    # dev Postgres 19 via deploy/compose (port 55432, user majlis_owner)
pnpm e2e                # playwright;  pnpm vt / vt:update  # plate visual comparison
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

## Environment notes
- Local docker daemon: start with `(dockerd >/tmp/dockerd.log 2>&1 &)` if `docker info` fails.
- Deploy target: k3s at manythreads.kahf.to (SSH not reachable from the cloud sandbox; see STATUS.md).
