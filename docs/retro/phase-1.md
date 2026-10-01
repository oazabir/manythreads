# Phase 1 retro · Foundations (gate verification)

Branch `claude/inspiring-turing-dzp82p`. Verified 2026-10-01 against PLAN.md Phase 1 and section 6.

## 1. Baseline

### Tool versions
| Tool | Version |
|---|---|
| Node / pnpm | v22.22.0 / 10.28.0 |
| TypeScript | 5.9.3 |
| Zod | 4.6.5 |
| Fastify | 5.12.5 |
| Vitest | 3.2.7 |
| Playwright (`@playwright/test`) | 1.56.1 (Chromium 1194) |
| ESLint | 9.39.5 |
| pg (node-postgres) | 8.23.1 |
| PostgreSQL | 19beta4 (Debian 19~beta4-1.pgdg13+1), image `majlis/postgres:19` |
| pgvector / pg_trgm | 0.8.7 / 1.6 |
| k3s | v1.36 single node (STATUS.md) |
| CloudNativePG | operator from the `cnpg/cloudnative-pg` chart, installed by the deploy action, chart version not pinned (latest at deploy time) |

### Times (4 vCPU sandbox, warm pnpm store and docker Postgres already up; `time` wall clock)
| Command | Wall | Result |
|---|---|---|
| `pnpm install --offline` | 1.2 s (lockfile up to date, node_modules kept) | ok |
| `pnpm build` | 2.3 s (incremental: `dist/` existed; web Vite build 1.3 s) | ok |
| `pnpm typecheck` | 16.9 s | ok |
| `pnpm lint` (eslint + stylelint) | 3.1 s | ok |
| `pnpm test` (all vitest projects) | 11.2 s, 23 files, 266 passed + 1 todo (includes the 2 files added by this gate) | ok |
| `pnpm test:rls` | 2.9 s, 3 files, 20 tests | ok |
| `pnpm test:events` | 4.2 s, 2 files, 10 tests | ok |
| `pnpm test:schema-compat` | 1.5 s, 23 tests | ok |
| `pnpm e2e --project=api` | 6.4 s, 10 tests | ok |
| `pnpm vt` | 9.9 s, 3 tests | ok |
| `pnpm e2e --project=desktop` | 9.8 s, 3 tests | ok |

A true cold install and cold build (empty store, no `dist/`) were not measured; the offline install and the build are warm figures.

### Benchmarks
See [bench-phase-1.md](./bench-phase-1.md). Server, 1M messages under FORCE RLS: newest-50 p50 about 2 ms, common-term search about 3-4 ms, rare-term search about 135 ms, outbox about 700 events/s (about 2,800-3,000 deliveries/s). No partitioning indicated. Phone list: Chromium proxy only (60 fps proxy PASS); the on-device React Native benchmark is deferred to the phase 11 gate.

## 2. The three conventions later phases keep
1. **One mapper per table** (`packages/kernel/src/db/mappers/<table>.ts`): a row becomes the shared Zod type, nothing else. A schema task is the triple Zod schema + SQL migration with RLS + mapper.
2. **One DB entry**: `withActor(actor, fn)` sets `app.actor_id/workspace_id/run_id` with `SET LOCAL`. System work uses `withSystem`, which connects through the separate `majlis_system` login role; system privilege comes from `current_user`, never from a settable GUC (`spoof.test.ts`). No bare `pool.query` outside `kernel/src/db/` (lint rule, tested in `lint-rules.test.ts`).
3. **One event registry** (`packages/shared/src/events/registry.ts`): `emit` validates against it and writes `events` + `outbox` in one transaction; types are `domain.noun.verb`; versions upcast through the registry.

## 3. Kernel public SDK surface (`@majlis/sdk`, the only kernel API plugins may use)
Functions: `definePlugin({ manifest, register })` (validates the manifest at import), `assertSafePluginSql`, `guardPluginTx` (stopgap guard, not a sandbox), error class `ForbiddenPluginSqlError`.
Types: `PluginContext` (`events.subscribe/emit`, `hooks.prePersist/preEgress`, `providers.register`, `commands`, `triggers`, `components`, `surfaces.nav/screen/card/panel`, `settings.page`, `composer.action`, `capabilities.register`, `http.route`, `storage`), `PluginDefinition`, `PluginTx`, `PluginEvent`, `EventHandler`, `EmitEvent`, `Hook`, `HookInput`, `ProviderKind` (+ `PROVIDER_KINDS`), `ProviderImpl`, `CommandDefinition`, `TriggerDefinition`, `ComponentDefinition`, `SurfaceDefinition`, `SettingsPageDefinition`, `ComposerActionDefinition`, `HttpRequest`, `HttpResponse`, `HttpRouteDefinition`, `CapabilityHandler`, `ScopeType`, `StorageScope`, `ScopedKv`, `ExtensionPoint`, `PluginManifest`. Plugins also import `@majlis/shared` (schemas).

## 4. Prototype CSS not yet a token (from the `tokens.css` header comment)
Selected sidebar item bg `#E3E7EB`; list-row hairline `#EDEFF2`; table header bg `#FAFBFC`; muted pill/offline dot `#C3C8CE`; file icon bg `#6E7681`; human wash `#EEF3F8`; ok wash/border/ink `#EFF5F1`/`#BBD4C4`/`#2E5F41`; human border `#B9CBDD`; agent border/ink `#DCD2EC`/`#4E3B6E`; warn wash/border/ink `#FBF7EE`/`#E3D3AC`/`#8E5A2E`; frame shadow `rgba(27,36,48,.06)`; radii 5/6/10/12 px; frame grid `248px | 1fr | 380px`. Promote a value to a token when the first screen needs it.

## 5. Criteria to tests

### Acceptance criteria
| # | Proof |
|---|---|
| 1 | `kernel/test/migrate.test.ts` (applies once, second run applies none, edited file throws naming it and applies nothing new, down/misnamed rejected, advisory lock). **Added** `server/test/startup-migrations.test.ts`: at server level, start 1 migrates, start 2 changes nothing in `schema_migrations`, a tampered checksum makes `startServer` reject naming the file. |
| 2 | `kernel/test/rls/harness.test.ts` (RLS-less table named; enabled-not-forced and forced-without-policy named; zero cross-team rows; no actor sees nothing), `server/test/integration.test.ts` (anonymous nil actor reads no RLS table). |
| 3 | `kernel/test/events/emit.test.ts` ("throws naming the field and writes nothing"), `shared/test/events.test.ts`, `e2e/api/kernel/events.spec.ts` (invalid workspace rejected, nothing delivered); `kernel/test/events/outbox.test.ts` (10,000 rows, 4 consumers, crash loses none, dead letter); `kernel/test/jobs.test.ts` (50 jobs, 5 workers, one killed, each done once). |
| 4 | `kernel/test/broker.test.ts` (guarded paths denied and logged, `pages/x.md` allowed, `routine` + `person:*` denied, `conversation`/`mention` allowed, fail closed). |
| 5 | `server/test/server.test.ts` (400 `validation_failed` with path, 429 with retry-after), `e2e/api/kernel/validation.spec.ts`, `rate-limit.spec.ts`. |
| 6 | `kernel/test/pg19-probe.test.ts` (uuidv7, DO SELECT and its fallback, pg_trgm, vector, UNLOGGED); raw hex: **added** `server/test/lint-rules.test.ts` (runs the repo ESLint config on fixtures: hex in a string and in a template fails, allowed in `tokens.ts`; Dto name and bare `pool.query` fail), plus `pnpm lint` itself in CI; benchmarks and 60 fps verdict in `bench-phase-1.md`. |
| 7 | `server/test/server.test.ts` ("two servers each allow the full limit"), `transport/rate-limiter.test.ts` (two limiters share nothing); `jobs.test.ts` ("UNLOGGED crash: truncating job_leases ... every job completes once in effect", `job_leases` is `relpersistence u`). |
| 8 | `kernel/test/rls/append-only.test.ts` (UPDATE/DELETE/TRUNCATE denied for `majlis_app` and `majlis_system`). |

### Section 4 e2e rows
| Spec | Status |
|---|---|
| `e2e/api/kernel/health.spec.ts` | present, green (migration count equals files) |
| `validation.spec.ts` | present, green |
| `rate-limit.spec.ts` | present, green (60 pass, 40 429) |
| `events.spec.ts` | present, green |
| `kernel/test/broker.test.ts`, `jobs.test.ts` | present, green |

### Section 5 visual specs
`e2e/visual/shell/tokens.visual.spec.ts` (computed `:root` tokens equal the prototype), `frame.visual.spec.ts` (landmarks, P-loose), `e2e/visual/_harness/self.visual.spec.ts` (0 differing pixels); also `tools/plates/test/compare.test.ts`. All green (`pnpm vt`, `pnpm e2e --project=desktop`).

### Section 6 exit
| Item | Proof |
|---|---|
| `pnpm test`, `test:rls`, `test:events`, `test:schema-compat` green | run above; CI steps in `.github/workflows/ci.yml` |
| A plugin skeleton loads | `kernel/test/plugins/host.test.ts` ("example-hello against Postgres": applies migration, records plugin, passes the RLS harness, runs the subscriber), `server/test/integration.test.ts` (test-kernel plugin loaded, `/healthz` lists it) |
| Benchmarks recorded | `docs/retro/bench-phase-1.md` |
| A deliberately RLS-less table fails the build | `harness.test.ts` creates `app.rls_less_probe` and expects `findRlsViolations` to name it; `pnpm test:rls` runs in CI |
| `docs/retro/phase-1.md`, reviewer PASS per task, tag `phase-1` | this file; reviewer PASSes and the tag are not verifiable from the repo and are left to the gate owner |

## 6. Deviations from the plan
- **System role design.** Plan said `withSystem` and an actor kind; the review found GUC-based privilege spoofable, so the system actor is a real Postgres login role `majlis_system` (a third pool). `majlis_app` cannot `SET ROLE` to it.
- **Plugin routes mount at absolute paths** declared in the route definition (not under a per-plugin prefix); duplicate method+path across plugins fails at load.
- **CNPG owner is a superuser** (`majlis_owner` SUPERUSER, as in dev compose) because kernel migrations create extensions and alter roles; extensions are created via `postInitApplicationSQL`.
- **Postgres 19 is a beta** (`postgres:19beta4` plus pgvector 0.8.7 built from source; 0.8.1 does not compile on PG19). CNPG accepted it, so `postgres.mode: statefulset` stays unused.
- **RN benchmark deferred** to the phase 11 gate; a Chromium CPU-throttled proxy was recorded instead and is labelled as such.
- A plugin SQL guard (`assertSafePluginSql`) was added to the SDK as an explicit stopgap, not in the plan.

## 7. Known follow-ups
- Trigram search plan under RLS is not index-driven reliably (Seq Scan 300-500 ms at 1M rows for some sorts); scope search to a channel/team or a materialised accessible-channel list and re-check the plan before phase 3 ships search.
- Response schemas are enforced for 200 only (other status codes are not serialised through a schema).
- CNPG owner is a superuser; tighten (pre-created extensions and roles) before phase 10 admin/deploy hardening.
- CNPG operator chart version unpinned; pin it.
- `common.test.ts` has one `it.todo`: every `z.enum` vs its SQL CHECK.
- Cold install/build times were not measured on an empty store.
- CI does not run `pnpm vt` separately (the same specs run inside `pnpm e2e`).

## 8. Seed phase 2
1. **Does any package import another's internals?** No. Grep for `@majlis/<pkg>/src`, deep relative paths crossing packages, and `@majlis/kernel` imports inside `packages/plugins` found nothing; packages export a single entry (`"."`). Plugins import only `@majlis/sdk` and `@majlis/shared`. (Note: the server and test-utils depend on `@majlis/kernel`'s public index, and pnpm reports a cyclic workspace dependency kernel <-> test-utils <-> server for dev dependencies; it is benign now, worth untangling.)
2. **Can a plugin author add a table with RLS using one SQL file and one manifest line?** Yes. `packages/plugins/example-hello` has `migrations/0001_hello_greetings.sql` and `migrations: 'migrations'` in its manifest; `host.test.ts` proves the table is created, namespaced in `schema_migrations`, and passes `findRlsViolations`. A plugin table without RLS fails `pnpm test:rls`. Documented in `docs/plugins/example-hello.md`.
3. **Is any error shape defined twice?** No. HTTP `ErrorEnvelope`/`ErrorCode`/`ErrorIssue` live once in `packages/shared/src/common/error.ts` (server `envelope()` only builds it); the WebSocket `WsErrorEnvelope` is a different shape defined once in `packages/shared/src/transport/envelope.ts` and reuses `ErrorCode`. Both are separate by design (HTTP body vs WS frame).
