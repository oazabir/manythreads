# Architecture at a glance

What manythreads is built from and where each part lives. The full contract is `docs/spec/SPEC-FINAL.md`; the build plan is `PLAN.md`.

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
packages/plugins/<n>   one plugin per package (manifest + server code + migrations/ + docs page); `audit` projects the event log into the admin Audit console (docs/plugins/audit.md); `onboarding` keeps the first admin's setup decisions behind the sidebar checklist and the Setup wizard (docs/plugins/onboarding.md); `knowledge` keeps a team's knowledge bases (uploaded documents read into passages that bots search and cite; docs/plugins/knowledge.md)
clients/web            React web client (Tauri wraps it in phase 10); clients/mobile in phase 11
tools/plates tools/bench tools/fake-llm tools/evals    plate comparison, benchmarks, fake OpenAI-compatible LLM, bot eval command (`pnpm test:evals`)
e2e/                   Playwright: api/<area>, <area>, visual/<area>, personas/<p>, __baselines__, fixtures
deploy/compose deploy/helm deploy/postgres  docs/ (plugin docs, retro/phase-N.md, spec/)
```
