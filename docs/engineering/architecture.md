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
- Deploy: docker compose (`deploy/compose`) for dev and tests only (a self-host compose file is not built, P10-13); Helm chart (`deploy/helm`) on k3s with
  CloudNativePG (D4). Five default workloads: Postgres, LiteLLM, Hindsight, manythreads server(+web), Hermes.

## Repo layout
```
packages/shared        @manythreads/shared  — Zod schemas: ids, common, entities, api, events, bot-md, tokens
packages/kernel        @manythreads/kernel  — db (pool, withActor, migrate, mappers), identity, events, outbox,
                                          jobs, plugins host, capabilities broker, transport, storage
packages/sdk           @manythreads/sdk     — public plugin SDK surface (the ONLY thing plugins import from kernel)
packages/server        @manythreads/server  — Fastify host, loads plugins, HTTP/WS, /healthz /readyz
packages/test-utils    @manythreads/test-utils — persona presets, readAs, captureEvent, test DB helpers
packages/plugins/<n>   one plugin per package (manifest + server code + migrations/ + docs page); `audit` projects the event log into the admin Audit console (docs/plugins/audit.md); `onboarding` keeps the first admin's setup decisions behind the sidebar checklist and the Setup wizard (docs/plugins/onboarding.md); `knowledge` keeps a team's knowledge bases (uploaded documents read into passages that bots search and cite; docs/plugins/knowledge.md); `workshop` is the "Add a bot" helper (a person's brief becomes graded needs, one list of questions and a bot proposed as a diff that waits for Approve; it runs its own small model loop through the `provider.llm.chat` door and reaches platform tools only through the call-only door `capability.call`, with the capabilities named in its manifest `calls`; it also owns the Workshop tab and, for a workspace admin, a recorded terminal into a throwaway test sandbox; docs/plugins/workshop.md)
clients/web            React web client (Tauri wraps it in phase 10); clients/mobile in phase 11
tools/plates tools/bench tools/fake-llm tools/evals    plate comparison, benchmarks, fake OpenAI-compatible LLM, bot eval command (`pnpm test:evals`)
e2e/                   Playwright: api/<area>, <area>, visual/<area>, personas/<p>, __baselines__, fixtures
deploy/compose deploy/helm deploy/postgres  docs/ (plugin docs, retro/phase-N.md, spec/)
```

## Controllers stay plugins (note, 2026-11-09, P10-08)

The Kubernetes controllers (`hermes-pods`, `claude-pods`) stay plugins that run inside the server process. There is no `packages/controller` and none is planned: a second process would need its own deployment, rights and release, for no gain at this size. What a controller may do in the cluster is limited by the chart's Role in the pods namespace and nothing else. The Helm chart (`deploy/helm/manythreads`) owns every cluster object, including the network policies, the RuntimeClass setting and the backup objects; the controllers only read their configuration from `MANYTHREADS_*` environment variables the chart sets.

## Plugin sockets and the terminal (P7-09)
A plugin may serve a WebSocket on its own route (`ctx.http.route({ ws: true })`); the server mounts it under the same cookie session as every route, behind the web proxy's `/api/` location (which passes the upgrade). Three things hold for every such socket, whatever the plugin: an `Origin` whose host differs from the request's host is refused with `403` before the upgrade; a route may declare a `guard` that runs as the caller, in a transaction, before the upgrade, so a refusal is a real HTTP status; (that guard runs through the plugin-transaction wrapper like a handler), and the socket is registered with the caller's session, so signing out (or the 15 second revalidation finding the session gone) closes it with code 1008, after telling the route (`PluginSocket.on('sessionEnded')`).

The `workshop` plugin uses one for the **terminal into a sandbox**: an admin-only shell that runs on the server host in a per-session jail (a Linux namespace jail built by an embedded Python helper: `pivot_root` into an empty `tmpfs`, an unprivileged user of its own, a system-call filter that refuses new namespaces, no network, no view of the server's processes, killed when the socket closes; it runs as one server process). It is never a bot's real placement; `placementOfRun` in `@manythreads/shared` is the one definition of a sandbox (a rehearsal conversation run), and the credentials of the sandbox run are revoked the moment the terminal opens. Each session is recorded in `app.terminal_sessions` with the shell's output redacted through the data-protection hook. It is off unless `MANYTHREADS_TERMINAL_ENABLED=1`, and where the jail cannot be built it says why. Details, limits and the honest list of what it cannot do: docs/plugins/workshop.md, docs/plugins/security.md.
