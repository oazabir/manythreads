# manythreads — implementation plan

Phase-wise build plan for Claude as orchestrating coding agent. Contract: `SPEC-FINAL.md` v1.4.1. Operating model, repo layout, spec-to-code map, referee rules: `IMPLEMENTATION-GUIDE.md`. Look and copy: `mockups-all.html`. Replaces every earlier `PLAN.md`.

## 1. Purpose

Build the spec in thirteen phases. Phases 1–11 build the product, web first. Phase 12 proves it for every persona and writes the user manual from the proof. Phase 13 reviews every screenshot and fixes what looks wrong.

## 2. How to use

1. One phase per block of sessions, in order. Do not start N+1 until the `### 6 · Exit` gate of N is green.
2. Inside a phase, do subsections 0 to 6 in order.
3. The spec wins over this plan, except the four decisions in section 3, which are newer. Say so in the PR when a decision changes a spec detail.
4. Guide delegation rules apply: the orchestrator plans, decides and verifies (no more than 20 lines of code itself); Sonnet writes code; Haiku runs commands, builds, tests, logs, k8s and searches; a fresh Sonnet reviewer, given only the diff and requirements, passes every change; at most 3 subagents in parallel; set the model explicitly; bash, not zsh; subagents return summaries only.
5. Task IDs are `P<phase>-<nn>`; use them in commits. The **Agent** column names who does the task; every row also needs a reviewer pass.
6. Cite `SPEC §n` in PRs and prototype plates as `[proto §NN plate N · title]`.
7. Never build a non-goal (spec §20). Flag it instead.

## 3. Decisions (binding)

**D1 · Shared Zod schemas.** `packages/shared` holds every entity, API request and response, event payload and `BOT.md` frontmatter schema as Zod; types come from `z.infer`. The server validates every request and event with them; web and mobile import the same schemas and types. **No client-side proxy or DTO entities.** One mapper per table in the server turns a row into the shared type; there is no second type layer (Appendix B).

**D2 · Web first.** The React web client (browser; Tauri wraps it) is built and tested through all product phases before React Native starts (phase 11). Until then "mobile" means the web client at 390×844. The week-1 phone benchmark still runs in phase 1; it gates phase 11 only.

**D3 · Postgres 19 only, no Redis or Valkey.**

| Area | Rule |
|---|---|
| Keys, types | `uuid` v7 primary keys (`uuidv7()`); `timestamptz`; `text`, never `varchar`; `jsonb` only for open data, GIN only where queried; enums as lookup tables or `text` + `CHECK` |
| Indexes | Composite ordered by selectivity; partial for hot filters (unread, open tasks); covering with `INCLUDE`; `BRIN` on append-only time columns; every FK indexed |
| RLS | On every team- and person-scoped table, `FORCE`d, proven by the RLS harness |
| Analytics | Time-series table, native monthly range partitions on `occurred_at`, `BRIN`, rollups by a routine; no TimescaleDB |
| Search | `pg_trgm` GIN indexes on message text, thread titles, page text, file names (`search` plugin); `pgvector` for knowledge embeddings only |
| Ephemeral | `UNLOGGED`: presence, typing, job leases and locks, live cursors, session caches |
| Rate limits | In-memory sliding window in the server process; never in the database |
| Get-or-create | One statement: `INSERT … ON CONFLICT (key) DO SELECT … RETURNING` (verified in P1-12, fallback `DO UPDATE … RETURNING`); `DO UPDATE` only for a real update (Appendix A.9) |
| Queue, outbox | Postgres tables, `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY` wake-ups |
| Migrations | Plain SQL, forward-only, run by the server at start |

Spec v1.4.1 §2 already states these; the guide's queue wording is superseded.

**D4 · k3s with CloudNativePG.** Postgres is a CNPG `Cluster`: 1 instance, 3 for HA; `pg_trgm`, `pgvector` (`uuidv7()` is built in); scheduled backups to object storage. One Helm chart, no CRDs of our own (the controller reads the DB). Default install is five workloads: **CNPG Postgres, LiteLLM, Hindsight, manythreads server (+ web static), Hermes runtime pods.** Docker compose is a supported self-host option (five containers, phase 10) as well as the dev and CI harness.

**D5 · Rate limits on sensitive endpoints.** Every endpoint that grants, recovers or changes a credential or a session — sign-in, password reset, email verification, first-admin bootstrap, invitation accept, OIDC start/callback, change-password, session revoke — carries an **explicit low per-client-address limit** on top of the default route limit, and the credential routes add the in-memory lockout on repeated failures. Over the limit is `429 rate_limited` with `retry-after`; counters are in process memory per replica, like every rate limit (D3), never in the database. A new phase that adds a sensitive route must give it a limit **in the same task that adds the route**; phase 10 audits the whole set, documents the numbers in the Helm notes beside the per-replica caveat, and bursts them in `e2e/api/security/abuse.spec.ts`.

Everything else follows the spec: Hermes only, no bot modes, `BOT.md`, one LLM gateway, one MCP gateway, Hindsight bank per team chosen by the gateway with the git mirror, two-stage gate, one `needsApproval`, first-party person connections.

## 4. Personas

Bots are not personas, but **each persona's journeys include at least one interaction with Brain and one with an acting bot**. Personas drive e2e tests from phase 2, the full suite in 12 and the review in 13. Negative ("must never") statements become tests.

| Persona | Role, memberships | Goals | Must never be able to |
|---|---|---|---|
| **Omar** | Workspace `owner` and `admin`; Engineering `lead` | Sign-in, LLM aliases and budgets, teams, review bot proposals, audit | Read others' private conversations or DMs; read back a stored secret; write `bots/` through a bot |
| **Nadia** | Engineer, release owner; Engineering member | Work the board with Coder, ask Brain, edit runbooks, request a release | Approve her own request; open the terminal; see Support or Marketing private channels |
| **Rafi** | On-call approver; Engineering member, tag `role:on-call` | Clear Approvals, follow incidents, ask Brain for the runbook | Approve his own request; approve outside his scope (Support `email.send`); change a bot's guard or approvers |
| **Sameera** | Support agent; Customer support member, tag `role:support-agent` | Work `#support` with Support responder, approve replies, ask Brain | See Engineering channels or knowledge; run Coder; read others' conversations |
| **Tariq** | Marketing content lead; Marketing lead | Content pages with Content drafter, pin reports, ask Brain | Read Support email; approve production deploys; make Brain read anyone's Drive but his own |
| **Priya** | New joiner, read-mostly; `member` of Engineering and Marketing | Read, follow threads, ask Brain how things work | Approve anything; change `bots/`, `TEAM.md`, `skills/`, `routines/` through the UI (not a lead or admin); open a terminal; see private channels she was not added to |
| **Lena** | External viewer; workspace `guest` added to `#releases` only | Read release announcements | See other channels, members, Files, Boards, Approvals, DMs; talk to or mention any bot, Brain included; post; search outside `#releases` |

Roles (spec §5): workspace `owner`, `admin`, `member`, `guest`; team `lead`, `member`; role tags in `TEAM.md` such as `role:on-call`. Guests cannot talk to or mention bots.

Persona sign-in states live in `e2e/.auth/<persona>.json`, created through real password sign-in. Lena's contact with bots is read-only: a Coder release post and a Brain answer Nadia shared into `#releases` with person-scoped citations masked (SPEC §6.3).

## 5. Conventions for all phases

**Seed.** `e2e/fixtures/seed.ts` builds workspace **Kahf Software** (seven people; teams Engineering, Customer support, Marketing) and grows each phase: 3 channels and messages; 4 repo content; 5 bots (Brain per team, Coder, Support responder, Content drafter) and bank facts; 6 board, rhythms, `production` environment; 8 mock connections, `product-manuals`. Fixed uuids so screenshots are stable.

**Determinism.** A fake OpenAI-compatible LLM (`tools/fake-llm`) behind LiteLLM answers from `e2e/fixtures/llm-script.json`, keyed by hash of the last user message plus bot slug; real Hermes runs against it; nightly runs use real models. Playwright `page.clock` and `MANYTHREADS_CLOCK=fixed` fix time. A mock OIDC provider plays Google and Microsoft.

**Layout.** `e2e/api/<area>/*.spec.ts` (API), `e2e/<area>/*.spec.ts` (browser), `e2e/visual/<area>/*.visual.spec.ts`, `e2e/personas/<persona>/*.spec.ts` (phase 12), `e2e/__baselines__/`. Projects: `desktop` 1440×900, `mobile-web` 390×844, Chromium, headless in CI.

**Plate comparison (built in P1-10).** `tools/plates/render.ts` opens `docs/spec/mockups-all.html`, goes to the section id (`onboarding`01 `app`02 `teams`03 `bots`04 `botgeneric`05 `setup`06 `workshop`07 `email`08 `surfaces`09 `connections`10 `cabinet`11 `brain`12), takes the Nth `.plate` and screenshots its `.frame`. The live screen is cropped to `[data-testid="app-frame"]`. Dynamic regions carry `data-vt-mask`. Compare with `pixelmatch` plus `data-landmark` boxes. In onboarding, plates are numbered by order (1 sign-in … 6 launch, 7 Workspace → LLM).

| Class | When | Tolerance |
|---|---|---|
| **P** | Plate exists | Landmarks ±6 px; ≤ 6% differing pixels outside masks; `data-copy` strings exact; tokens exact |
| **P-loose** | Plate shows a richer state than the seed | Landmark order and presence; ≤ 12% differing |
| **W** | Wireframe only | Landmarks in order; own committed baseline ≤ 0.2% differing |

Baselines change only with `pnpm vt:update` in a PR that states why.

**Tokens (P1-13).** From the prototype `:root`: `--paper #EDEEF0 --surface #FFFFFF --shell #F3F4F6 --ink #1B2430 --mute #5A6472 --faint #8A929C --rule #D4D8DE --human #2E5C8A --agent #7B5EA7 --agent-wash #FBF9FE --ok #3F7D58 --warn #B08A3E --alert #B4472E --alert-wash #FDF6F3`; fonts Inter Tight, JetBrains Mono. Lint fails on a raw hex outside `tokens.css`.

**Schema task = triple:** Zod in `packages/shared` + SQL migration with RLS + server mapper, in one diff.

## 6. Definition of a phase

Done when: `docs/retro/phase-N.md` exists; every task merged with a reviewer PASS; every acceptance criterion passes; e2e (`### 4`) green headless in CI; visual (`### 5`) green in tolerance; `pnpm test`, `test:rls`, `test:events` (and `test:memory-cross-team` from 5, `test:runtime-rules` from 6) green; each new plugin has its docs page; the gate is checked and the commit tagged `phase-N`.

## 7. Phase map

| # | Phase | Size | Needs |
|---|---|---|---|
| 1 | Foundations | L | — |
| 2 | Identity, workspace and teams | M | 1 |
| 3 | Channels, threads and direct messages | XL | 2 |
| 4 | Files and the team repo | L | 3 |
| 5 | Bots, gateways, conversations and Brain | XXL | 4 |
| 6 | Tasks, boards, orchestration, rhythms and pages | XL | 5 |
| 7 | Self-setup and the Workshop | L | 6 |
| 8 | Connections, knowledge and email bots | XL | 7 |
| 9 | Surfaces | M | 8 |
| 10 | Onboarding, admin and deployment | L | 9 |
| 11 | Mobile client | L | 10 |
| 12 | Full persona end-to-end automation and user manual | L | 10, 11 |
| 13 | Screenshot UI review | M | 12 |

**Ordering notes (a dependency forced the choice).** Basic guardrails (`pre_egress`, gateway pre-call, `standard` preset) land in phase 5 because bots first act there and principle 3 says every byte passes guardrails; phase 10 completes them. `Answer` is a fixed component in phase 5 (Brain is M1) and moves onto the OpenUI renderer in 9. Runners and worktrees close phase 6 (Tester's placement needs them). The week-3 `slack-compat` spike opens phase 5. Subscription runtimes and the Tauri build sit in phase 10. **Milestones are time-based, phases dependency-based:** M1 = phases 1–5 plus a minimal onboarding slice in phase 5 (steps 0, 1, 2, 5, 6: sign-in, one provider, first team from a template, default bots) so the guide's M1 demo works; full onboarding stays in phase 10. The append-only audit log is the phase 1 event log; the console and export are phase 10. The eval harness is built in 7 and wired to GitHub pull requests in 8.

---

# Phase 1 · Foundations

Goal: a monorepo where a plugin is written against a public SDK, every table is born with RLS, events and jobs run on Postgres, and CI proves it. Size L. Spec §2, §3, §19 weeks 1–2; guide §2, §3.1, §6–§8.

### 0 · Reflect and refactor

Nothing to reflect on yet. Record the baseline in `docs/retro/phase-1.md`: tool versions, install, build and test times, benchmark numbers, and the three conventions later phases keep (one mapper per table, one `withActor` DB entry, one event registry). Baseline prompts: record the cold build time and the full test time; list the kernel APIs plugins may use (the public SDK surface, nothing else); note anything copied from the prototype CSS that is not yet a token. At the end, ask to seed phase 2: does any package import another's internals? Can a plugin author add a table with RLS using one SQL file and one manifest line? Is any error shape defined twice?

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P1-01 | Monorepo scaffold (pnpm, tsconfig, ESLint with raw-hex rule, `*Dto` ban and no bare pool query outside `db/`, Vitest); root `CLAUDE.md` from guide §2.1 updated for D1–D4 | root | guide §2 | Sonnet |
| P1-02 | `packages/shared` skeleton (ids, error envelope, event registry, tokens, example `Message`) and the strict `BOT.md` frontmatter schema (every §7.1 key, §7.2 section) with JSON Schema export; `pnpm test:schema-compat` (JSON Schema snapshots) and the event upcast mechanism of Appendix B.4 | `packages/shared/src/entities`, `events`, `bot-md` | §3, §7.1 | Sonnet |
| P1-03 | Migration runner (numbered files, advisory lock, checksums, rejects edited or down files, runs at server start) and `0001_kernel.sql` with Zod and mappers: extensions, roles `manythreads_owner`/`manythreads_app`, schema `app`, Appendix A.1 tables | `server/src/db` | §2, §3 | Sonnet |
| P1-04 | `withActor(actor, fn)` (`SET LOCAL app.actor_id/workspace_id/run_id`; the only DB entry); RLS harness `pnpm test:rls` (every table off `global_tables` has RLS enabled and forced, a policy, zero cross-team rows) | `kernel/db`, `test-utils` | §15 | Sonnet |
| P1-05 | Kernel identity (`Actor`: person, bot, system); event log (`emit` validates against the registry, writes `events` and `outbox` in one transaction) | `kernel/identity`, `events` | §2, §3 | Sonnet |
| P1-06 | Outbox publisher (SKIP LOCKED, `LISTEN/NOTIFY`, at-least-once, idempotency key, dead letter) and job queue (claim, UNLOGGED lease, backoff, dedupe, cron, reaper) | `kernel/outbox`, `jobs` | §2 | Sonnet |
| P1-07 | Plugin host (`PluginManifest`, loader, ordering, all §3 extension points, per-plugin migrations) | `kernel/plugins`, `sdk` | §3 | Sonnet |
| P1-08 | Capability broker: names, destructive tag, allowlists, **path guard** (`bots/`, `TEAM.md`, `skills/`, `routines/` denied to bot actors), `person:*` only for `conversation` and `mention` | `kernel/capabilities` | §3, §7.2 | Sonnet |
| P1-09 | Transport (HTTP, WebSocket, schema-checked envelopes, in-memory sliding-window rate limiter), scoped storage interfaces, Fastify host (Zod type provider on every route, error envelope, OpenAPI from Zod, health) | `kernel`, `server/src` | §2, D3 | Sonnet |
| P1-10 | Plate comparison harness (section 5) with `pnpm vt` and `vt:update` | `tools/plates` | guide §8 | Sonnet; Haiku |
| P1-11 | Week-1 benchmarks: RN 5,000-message list on a mid-range Android (guide §5.1); server with 1M messages under RLS (newest-50, trigram search, outbox throughput) | `tools/bench` | §19 | Sonnet; Haiku |
| P1-12 | Postgres 19 probe test: `uuidv7()`, `DO SELECT`, `pg_trgm`, `vector`, UNLOGGED after crash; if `DO SELECT` fails, the fallback is `DO UPDATE SET key = EXCLUDED.key RETURNING *` behind one helper | `server/test` | D3 | Sonnet; Haiku |
| P1-13 | `@manythreads/test-utils` (persona presets, `readAs`, `captureEvent`); web skeleton (Vite, `tokens.css`, `/dev/tokens`, `app-frame`); CI, dev compose (Postgres 19, mock OIDC, mailpit), plugin author docs | `test-utils`, `clients/web`, `.github`, `deploy/compose` | guide §6, §8 | Sonnet; Haiku |

### 2 · UI references

No product screen. Frame proportions from `[proto §02 plate 1 · Channel, with a thread open in the right panel]`. Developer pages (class W): `/dev/tokens` shows a swatch per token, the two fonts and button and chip states; `/healthz` returns `{ "status": "ok", "migrations": n, "plugins": [] }`.

```
Empty app frame
+--------+----------------------+--------+
| team   | header               | right  |
| switch |----------------------| panel  |
| search |                      | hidden |
| sidebar|    content area      |        |
| (empty)|                      |        |
+--------+----------------------+--------+
```

### 3 · Acceptance criteria

1. Empty DB: migrations apply once and a second start applies none; an edited applied file stops the start and names the file.
2. A table without RLS fails `pnpm test:rls` and is named; `withActor` for team A returns zero rows of team B.
3. An invalid event payload throws, writes nothing, names the field. 10,000 outbox rows and 4 consumers: all delivered at least once, a crash loses none; two workers never claim one job.
4. A bot's write to `bots/x/BOT.md`, `TEAM.md`, `skills/x`, `routines/x.yaml` is denied and logged; `pages/x.md` is allowed; a `routine` run asking `person:*` is denied.
5. A bad body gives 400 with the error envelope and field path; over the limit gives 429, counted in memory.
6. The probe finds `uuidv7`, `DO SELECT`, `pg_trgm`, `vector`; a raw hex colour fails lint; benchmarks are recorded with a 60 fps verdict.
7. Documented limits, tested: rate-limit counters are per replica (two replicas each allow the full limit); after an UNLOGGED crash restart `job_leases` is empty, leases are re-acquired by the reaper and every job runs to completion exactly once in effect (idempotent).
8. Every event written is append-only in `events` (`REVOKE UPDATE, DELETE ON events FROM manythreads_app`; an `UPDATE` or `DELETE` as `manythreads_app` fails); this is the audit log until the console in phase 10.

### 4 · Automated end-to-end tests

API-level (Playwright `request`) and Vitest integration; no UI yet.

| Spec | Steps → assertions |
|---|---|
| `e2e/api/kernel/health.spec.ts` | GET `/healthz`, `/readyz` → 200; migration count equals files |
| `e2e/api/kernel/validation.spec.ts` | bad then good body → 400 `validation_failed` with `path`; 200 |
| `e2e/api/kernel/rate-limit.spec.ts` | 100 calls on a 60/min route → 60 pass, rest 429 |
| `e2e/api/kernel/events.spec.ts` | emit via test plugin → one delivery, valid schema |
| `packages/kernel/test/broker.test.ts`, `jobs.test.ts` | guarded paths; 50 jobs, 5 workers, kill one → all denied; each job done once |

### 5 · Visual browser tests

- `e2e/visual/shell/tokens.visual.spec.ts`, 1440×900: computed styles against the prototype `:root` tokens, not pixels; exact.
- `e2e/visual/shell/frame.visual.spec.ts`, 1440×900: `[proto §02 plate 1 · Channel, with a thread open in the right panel]`, frame landmarks only; P-loose.
- `e2e/visual/_harness/self.visual.spec.ts`, 1440×900: a plate against itself; 0 differing pixels.

### 6 · Exit

`pnpm test`, `test:rls`, `test:events` and `test:schema-compat` green in CI; a plugin skeleton loads; benchmarks recorded; a deliberately RLS-less table fails the build.

---

# Phase 2 · Identity, workspace and teams

Goal: bootstrap a workspace, sign in four ways, create teams from templates, and have the ACL allow or deny. Size M. Spec §4, §5, §5.3, §16 steps 0–1, §15; proto §01, §03.

### 0 · Reflect and refactor

Re-read phase 1; list what was awkward, duplicated or slow. Prompts: does `withActor` need a system form (no person, workspace-scoped)? Can the RLS harness read a table comment (`-- rls: team`) so phase 3's tables need no hand edits? Can `createTestPerson` make all seven personas in one call? Refactor with tests green; write `docs/retro/phase-2.md`.

### 1 · Implementation tasks

Schema tasks are triples (Zod, migration with RLS, mapper).

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P2-01 | Schema: `workspaces`, `people`, `person_emails`, `workspace_members` (`owner`/`admin`/`member`/`guest`) | `0002_identity.sql` | §5 | Sonnet |
| P2-02 | Schema: `auth_providers`, `identities`, `secrets` (envelope-encrypted, never returned); `kms` interface with Postgres-key implementation | `0002`, `kernel/kms` | §4, §15 | Sonnet |
| P2-03 | Schema: `password_credentials` (argon2id), `sessions`, UNLOGGED `session_cache`, `invitations`, `email_verifications`; SMTP mailer (mailpit in dev) | `0003_sessions.sql`, `kernel/mail` | §4 | Sonnet |
| P2-04 | `identity-password`: sign-in, minimum 12, verification, self-signup off by default, in-memory lockout, reset; first-admin bootstrap by one-time URL; password break-glass for admins | `plugins/identity-password` | §4, §16 | Sonnet |
| P2-05 | `identity-oidc`: discovery, code + PKCE, state, nonce, token checks; presets Google (domains, `hd`), Microsoft (tenant, domains), any-OIDC | `plugins/identity-oidc` | §4 | Sonnet |
| P2-06 | Session service: HttpOnly cookie, rotation, idle and absolute expiry, sign out everywhere, CSRF token | `server/src/session` | §4 | Sonnet |
| P2-07 | Schema: `teams`, `team_members` (`lead`/`member`), role tags mirrored from `TEAM.md` (`role:on-call`) into `roles` and `role_members`, `acl_entries` and `app.can()`; a guest is never a team member; seed a team-scoped stub resource (`stub_resources`, test migration) to prove team-level denial | `0004_teams.sql` | §5, §15 | Sonnet |
| P2-08 | Team templates as data (`templates/<team>/TEAM.md` + `template.yaml`; `TeamTemplate` schema; five templates, each with Brain); phase 2 only stores and shows the template definition (channel names and bot names as text); channels are created when phase 3 applies it and bots when phase 5 does. Apply = create team, creator `lead`, hold `TEAM.md` in `team_pending_files`, emit `team.template.applied`, idempotent via `DO SELECT` | `templates/`, `plugins/teams` | §5.3, §13 | Sonnet |
| P2-09 | Teams API (create, rename, archive, roster, roles, tags, invitations; a guest invitation is created here, its channel grant is applied in phase 3); RLS and audit events for every table above | `plugins/teams` | §5, §15 | Sonnet |
| P2-10 | Web: router, session bootstrap, typed API client from shared schemas, error boundary; screens sign-in, bootstrap, accept invite, workspace and sign-in settings, teams, roster, roles, account | `clients/web` | D1, §4 | Sonnet |
| P2-11 | Seed v2, persona auth fixtures, mock OIDC container | `e2e/fixtures`, `tools/mock-oidc` | — | Sonnet; Haiku |

### 2 · UI references

Workspace → Sign-in methods: `[proto §01 plate 1 · Step 1 · Sign-in methods]`. Team create and template picker: `[proto §01 plate 4 · Step 5 · Teams]`. Roster (people rows): `[proto §03 plate 1 · Team roster]`. Wireframes (class W):

```
Sign-in                                     Bootstrap (step 0)
+--------------------------------+          +--------------------------------+
|        [M] manythreads              |          | Set up your workspace          |
| [ G  Continue with Google ]    |          | Workspace [ Kahf Software ]    |
| [ MS Continue with Microsoft ] |          | Name      [ Omar Al Zabir ]    |
| ---------- or ----------       |          | Email     [ omar@kahf.co ]     |
| Email    [ nadia@kahf.co ]     |          | Password  [ 12+ chars     ok ] |
| Password [ ************ ]      |          | [ Create workspace ]           |
| [ Sign in]  Forgot password?   |          | This link works once.          |
| ! That domain is not allowed.  |          +--------------------------------+
+--------------------------------+
```

Account screen (class W):

```
+-------------------------------------------------+
| Account · Nadia                                 |
| Name   [ Nadia          ]  Email  nadia@kahf.co |
| Password  [ Change password ]                   |
| Sessions  This browser (now)   [ Sign out ]    |
|           Chrome · London      [ Sign out ]     |
|           [ Sign out everywhere ]               |
| Sign-in methods linked: Google ok               |
+-------------------------------------------------+
```

Settings frame: left nav (Workspace: General, Sign-in, Members, Roles; Team: Roster, Template, Channels) and a members table (name, email, role, tags). Empty: "Create your first team." Errors: expired invite; provider misconfigured (shows the test result, never the secret); 403 page with a way back. Mobile: the settings nav becomes a top select.

### 3 · Acceptance criteria

1. Empty DB: a bootstrap URL prints once, creates the first admin, and returns 410 on reuse.
2. An under-length password (below the SPEC §4 minimum) is refused with the rule shown; an unknown email with self-signup off creates nothing and does not reveal whether it exists.
3. Google with domain `kahf.co` refuses `other.com`; Microsoft refuses another tenant; failed any-OIDC discovery leaves the provider disabled with the reason shown. With OIDC the only method for members, admins keep the password form.
4. An idle session returns 401 and the client returns to sign-in keeping the return path.
5. Applying Engineering makes the team with Omar `lead`; the team record stores the template id and the stored definition lists #general #dev #releases #incidents #alerts #standup, a board and bots including Brain (applied in phases 3 and 5); applying twice duplicates nothing.
6. Lena (workspace `guest`, no team) gets 403 on an Engineering stub resource; Nadia gets 403 on a Marketing stub resource and 200 on Engineering's; no API returns a provider secret.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/identity/bootstrap.spec.ts` | open URL, create workspace as Omar → name in header; reuse shows expired page |
| `e2e/identity/password-signin.spec.ts` | Nadia signs in, wrong password, lockout → HttpOnly cookie; `role=alert`; lock after 5 |
| `e2e/identity/oidc-google.spec.ts`, `oidc-microsoft.spec.ts`, `oidc-any.spec.ts` | Tariq signs in; other domain; other tenant; issuer URL → person created once; refusals; discovery passed |
| `e2e/identity/break-glass.spec.ts`, `session.spec.ts` | password off for members; fake-clock expiry, sign out everywhere → Omar in, Nadia not; both contexts return to sign-in |
| `e2e/teams/create-from-template.spec.ts` | Omar creates Engineering, invites Nadia and Rafi, tags Rafi → roster, tag, event |
| `e2e/teams/acl-team-denial.spec.ts`, `roles.spec.ts` | Lena (guest) and Priya (`member` of two teams) read the seeded stub resources → Lena's team list empty, `/teams/engineering` and its stub resource 403; Priya sees both teams; non-admins get 404 on workspace settings |
| `e2e/api/identity/rls.spec.ts`, `secret-readback.spec.ts` | Sameera cross-team; read provider config → 403 or empty; no secret field |

### 5 · Visual browser tests

- `identity/signin` (1440×900 and 390×844) and `identity/bootstrap`: own baselines; W.
- `identity/signin-methods`: `[proto §01 plate 1 · Step 1 · Sign-in methods]`; P-loose. `teams/teams-create`: `[proto §01 plate 4 · Step 5 · Teams]`; P. `teams/roster`: `[proto §03 plate 1 · Team roster]`, template definition panel in place of the bots section; P-loose.
- `settings/members` (1440, 390) and `identity/empty-error` (empty teams, expired invite, 403): own baselines; W.

(All `e2e/visual/<area>/<name>.visual.spec.ts`; 1440×900 unless stated.)

### 6 · Exit

All four sign-in routes pass against the mock provider, the ACL denies Lena, Priya and Sameera what they must never reach, and no API returns a secret.

---

# Phase 3 · Channels, threads and direct messages

Goal: the app shell and the core conversation loop: read and post in channels, threads in the right panel, follow, unread, notifications, search, attachments. Size XL. Spec §3 (sidebar contract, cohesion services), §5.2, §6.1, §12 (search); proto §02.

### 0 · Reflect and refactor

Re-read phase 2; list what was awkward, duplicated or slow. Prompts:
- Is `app.can()` fast inside a policy on a million-row table? Check `EXPLAIN` on a membership join; add a covering index or cache view before messages exist.
- Does every screen call the typed API client, or do some build URLs by hand? Is the settings frame reusable for channel settings?
- Did template apply leave anything half-done (`TEAM.md` pending commit)? Note it for phase 4.

Refactor with tests green; write `docs/retro/phase-3.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P3-01 | Schema: `channel_groups`, `channels` (`channel`/`dm`/`bot_conversation`, `private`), `channel_members` | `0010_channels.sql`, `shared` | §6.1 | Sonnet |
| P3-02 | Schema: `messages` (markdown `body`, `body_plain`, `thread_root_id`), reactions, mentions; `threads`, `thread_follows` | `0011_messages.sql` | §6.1 | Sonnet |
| P3-03 | Read-state service (kernel): per person per thread and channel, partial unread index, mark-read, `read_state.changed` | `kernel/read-state` | §3 | Sonnet |
| P3-04 | Entity-link service: create, resolve, list links among messages, threads, tasks, pages, bots, files | `kernel/entity-links` | §3 | Sonnet |
| P3-05 | `channels` plugin: CRUD, post, edit, delete, react, cursor pagination by uuid v7; consumes `team.template.applied` and creates groups and channels with `DO SELECT` | `plugins/channels` | §5.3, §6.1 | Sonnet |
| P3-06 | `threads` plugin (open, reply, follow, Threads inbox query Followed · Unread · Mine) and `direct-messages` (get-or-create DM in one statement) | `plugins/threads`, `direct-messages` | §6.1, §3 | Sonnet |
| P3-07 | Mentions and entity links in a shared composer parser (`@person`, `@bot`, `#channel`, `[[entity]]`); presence and typing in UNLOGGED tables | `shared/src/markup`, `channels` | §3, D3 | Sonnet |
| P3-08 | `storage-local` blob plugin and `files` table for attachments (`channels/<name>/`, channel ACL, ACL checked on every read); upload and download routes | `plugins/storage-local`, `files`; `0014_files.sql` | §5.2, principle 8 | Sonnet |
| P3-09 | `notifications` plugin (mention, reply on followed thread, DM; WS push; browser permission flow) | `plugins/notifications` | §3 | Sonnet |
| P3-10 | `search` plugin: `pg_trgm` GIN on `messages.body_plain`, `threads.title`, `files.name`; `messages.search`, `files.search`; RLS-filtered; similarity then recency; `EXPLAIN` on 1M rows as Nadia and Lena | `plugins/search` | §12, D3 | Sonnet; Haiku runs |
| P3-11 | Right panel with back stack (`panel.push/back/close`, URL `?panel=thread:<id>`) | `clients/web/kernel/panel` | §3 | Sonnet |
| P3-12 | App shell and sidebar contract **Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) · Direct messages (45) · Bots (50)**, contributed through `surface.nav`; not-yet entries show an empty state | `clients/web/shell` | §3 | Sonnet |
| P3-13 | Channel view (virtualised list, row, reactions, replies), thread panel, composer (markdown, pickers, attachments with progress, paste, drag, size errors, per-channel draft), Threads inbox with `j` `k` `e` | `clients/web/screens` | §6.1, §5.2 | Sonnet |
| P3-14 | Welcome card for members (first-day checklist: join channels, follow a thread, ask Brain; the Brain step stays inert until phase 5) and 390 px layout: sidebar drawer, thread as full sheet; guest shell for Lena (granted channels only, no members, Files, search outside grant) | `clients/web` | D2, §5 | Sonnet |
| P3-15 | Seed v3 (40 messages per channel, 12-reply thread, private channel, DM pair, 5,000-message channel); event contracts for the five events | `e2e/fixtures`, `shared/src/events` | guide §6 | Sonnet |
| P3-16 | Screens built with no prototype plate: search results panel, notifications bell and popover, DM screen (wireframes in section 2); apply a guest invitation's channel grant | `clients/web/screens`, `plugins/teams` | §6.1, §5 | Sonnet |

### 2 · UI references

- Channel and thread panel: `[proto §02 plate 1 · Channel, with a thread open in the right panel]`. Threads inbox: `[proto §02 plate 2 · Threads]`. Phone: `[proto §02 plate 6 · Phone]`. The attachment card is part of the channel view above; the Files plate is phase 4.

Wireframes (class W):

```
Direct message                         Composer with attachments
+----------+-------------------------+ +-----------------------------------+
| Direct   | Nadia, Rafi    [ search ]| | [ B I </> list @ # ]               |
| messages | Rafi 10:02 Check rota?   | | [ Notes from the incident review ] |
|  * Rafi  | You  10:04 After standup | | [ report.pdf 2.1 MB ####--- 80% x ]|
|  Priya   |--------------------------| | [ big.zip  Too large (50 MB)    x ]|
|  + New   | [ Message… ] [clip][Send]| |                      [clip] [Send] |
+----------+-------------------------+ +-----------------------------------+
Sidebar placeholders                   Mobile 390x844
| Files     Opens in a later phase |   +-----------------------+
| Threads 3                        |   | =  # dev       find bell |
| Approvals Nothing waiting        |   | Nadia 10:02 Merged.   |
| v Engineering # general # dev    |   |   3 replies           |
| Bots      No bots yet            |   | [ Message #dev ] [>]  |
```

```
Notifications popover        Search results             Welcome card
+------------------------+  +----------------------+  +--------------------------+
| Notifications  Mark all|  | rollback             |  | Welcome, Priya           |
| @ Rafi mentioned you   |  | Messages (3)  #dev…  |  | [x] Join #general        |
| > Reply in Deploy plan |  | Threads (1)          |  | [ ] Follow a thread      |
| Allow browser alerts?  |  | Files (0)            |  | [ ] Ask Brain            |
+------------------------+  +----------------------+  +--------------------------+
```

Search results grouped Messages, Threads, Files; empty: "No results in what you can see." Empty channel: "This is the start of #dev." No access: "You cannot see this channel." Failed send: "Not sent · Retry".

### 3 · Acceptance criteria

1. Nadia posts in #dev; Rafi, with it open, sees it within 1 s; his unread dot clears when he scrolls to it.
2. A thread opens in the right panel with the channel visible; three pushes then Back twice shows the first entry, URL updated.
3. Priya (`member` of two teams) can reply in a thread and switch teams. A guest invitation's channel grant is applied when accepted: Lena sees exactly that channel.
4. Threads: Followed lists followed; Unread lists unread replies; Mine lists threads I started or hold a task in (task part tested in phase 6).
5. Opening the same DM twice, even concurrently, makes one row.
6. A private channel's text is not found by a non-member's search; trigram search finds "rolback" for "rollback"; 1M messages search under 300 ms p95.
7. An 80 MB attachment is refused in the composer; an attachment fetched by Lena (no grant) gets 403.
8. Lena's sidebar shows only `#releases`; her API calls to other channels give 403.
9. The 5,000-message channel scrolls at p95 frame time under 20 ms.
10. Customer support applies once: #support #escalations #enquiries #kb-updates exist exactly once. The sidebar order is exactly the contract.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/channels/post-and-read.spec.ts` | Nadia posts, Rafi (second context) reads → both see it in order; reaction syncs |
| `e2e/channels/thread-panel.spec.ts` | open, reply, push two panels, Back, reload deep link → stack and URL match |
| `e2e/channels/read-state.spec.ts` | 3 posts, Rafi opens → badge 3 then 0; one unread divider |
| `e2e/threads/inbox.spec.ts` | follow, reply by another, three tabs → membership per criterion 4 |
| `e2e/dm/get-or-create.spec.ts` | open DM twice concurrently → one row |
| `e2e/channels/mentions-notifications.spec.ts` | Nadia mentions Rafi → popover item; click lands on message |
| `e2e/search/basic.spec.ts`, `trigram.spec.ts` | search as Nadia, Sameera, Lena; typo → only Nadia finds; typo matches |
| `e2e/files/attach.spec.ts` | PDF, PNG, oversize → two upload, one error, download works |
| `e2e/channels/acl-private.spec.ts`, `guest-lena.spec.ts`, `guest-invite.spec.ts` | private channel; Lena signs in; invite then accept → hidden from Priya and Lena; one channel, no composer, `/dev` shows no-access; grant applied on accept |
| `e2e/channels/mobile-web.spec.ts` (`mobile-web`) | drawer, thread sheet, send → no horizontal scroll |
| `e2e/api/messages/rls.spec.ts`, `pagination.spec.ts`, `e2e/channels/perf-5000.spec.ts` | Sameera cross-team; 5,000 by cursor; scroll 10 s → 403; no gaps; p95 under 20 ms |

### 5 · Visual browser tests

- `channels/channel-thread.visual.spec.ts` 1440×900: `[proto §02 plate 1 · Channel, with a thread open in the right panel]`. P, times and avatars masked.
- `threads/inbox.visual.spec.ts` 1440×900: `[proto §02 plate 2 · Threads]`. P.
- `channels/phone.visual.spec.ts` 390×844: `[proto §02 plate 6 · Phone]`. P-loose.
- `channels/attachment-card.visual.spec.ts` 1440×900: the message attachment card in the channel view, within `[proto §02 plate 1 · Channel, with a thread open in the right panel]`. P-loose.
- Own baselines, W: `channels/dm`, `channels/composer` (1440, 390), `search/results`, `shell/sidebar-states` (Nadia, Priya, Lena), `channels/empty-error` (1440, 390).

(All under `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

Two browsers chat live with correct unread state, the sidebar matches the contract for every persona including Lena, typo search over 1M messages is under 300 ms, and nothing leaks another team's rows.

---

# Phase 4 · Files and the team repo

Goal: every team has a git repo behind one writer service; Files shows one tree over repo and attachments, with viewers, history, diff, restore. Size L. Spec §5.1, §5.2, §6.4 (plain `pages.write`), principle 8; proto §02, §11.

### 0 · Reflect and refactor

Re-read phase 3; list what was awkward, duplicated or slow. Prompts:
- Channels and files both check channel ACL on blob reads. Is the check one kernel capability or two copies? Extract it into the SDK before adding the repo store.
- Does the right panel take a new kind (`file:<path>`) without a kernel edit? If not, make the panel registry an extension point.
- Does the composer assume the blob is on `storage-local`? Put it behind the blob interface so `storage-s3` fits.

Refactor with tests green; write `docs/retro/phase-4.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P4-01 | `repo-git`: bare repo per team (`repos/<team>.git`); first commit writes the pending `TEAM.md` and the §5.1 layout including `memory/journal/` and `memory/facts/` | `plugins/repo-git` | §5.1 | Sonnet |
| P4-02 | **One writer per team**: per-team queue plus `pg_advisory_xact_lock(team)`; all writes via `repo.write(team, actor, changes, message, coAuthors)`; actor is commit author | `repo-git/writer` | §5.1 | Sonnet |
| P4-03 | Git layer on the `git` CLI in a worker: tree, blob, log, diff, show, commit, restore; timeouts, output caps | `repo-git/git` | §5.1 | Sonnet |
| P4-04 | Schema: `repos`, `repo_entries` (path, blob sha, size, `text_plain`), `repo_commits` (BRIN); trigram GIN on path and page text; updated from `repo.committed` | `0020_repo.sql` | §5.1, D3 | Sonnet |
| P4-05 | Writer rules: binary (NUL or over 1 MB) rejected `attachment_not_in_repo`; bot actors denied `bots/`, `TEAM.md`, `skills/`, `routines/`; team leads and workspace admins commit them directly through the UI until proposals replace that in P7-01; everyone else by pull request | `repo-git/writer`, broker | §5.1, §7.2 | Sonnet |
| P4-06 | `files` tree API merging repo entries and attachment rows; same list shape; ACL per folder (team for repo, channel ACL for `channels/<name>/`) | `plugins/files` | §5.2, principle 8 | Sonnet |
| P4-07 | `pages.write` (`create`/`replace`/`append`, broker-guarded, emits `page.written`) | `plugins/pages` | §6.4 | Sonnet |
| P4-08 | History: commits per path, diff (text and rendered Markdown), restore as a new commit | `files`, `repo-git` | §5.1 | Sonnet |
| P4-09 | `provider.viewer` registry; viewers: Markdown (Tiptap, slash commands, raw toggle), CSV (editable), PDF, images, video, audio, code, Mermaid (sandboxed worker), Office read-only (PDF from the optional worker; download card if it is absent), `google:` link card | `sdk`, `clients/web/viewers` | §3, §5.2 | Sonnet |
| P4-10 | Embedded apps: `index.html` without `index.md` renders in `sandbox="allow-scripts"`, no same-origin, strict CSP, manythreads bridge only | `viewers/app`, server CSP | §5.2 | Sonnet |
| P4-11 | Files screen: tree, breadcrumb, list, preview panel, upload, new, rename, move, delete-confirm, History panel, restore confirm; `memory/` shown with a "managed by team memory" note | `clients/web/screens/files` | §5.2 | Sonnet |
| P4-12 | **Optional:** LibreOffice worker converting Office files to PDF server-side for preview (separate container, off by default) | `plugins/files/office-worker` | §5.2 | Sonnet; Haiku |
| P4-13 | `storage-s3` behind the blob interface (MinIO in tests); writer concurrency suite; seed v4 (PDF, CSV, image, Mermaid, app); event contracts | `plugins/storage-s3`, `e2e/fixtures` | §2, §5.2 | Sonnet; Haiku runs |

### 2 · UI references

- Files: `[proto §02 plate 3 · Files]`. History, diff, restore: `[proto §11 plate 1 · Team repo and history]`. Page read view: `[proto §11 plate 2 · Durable pages]`.

Wireframes (class W):

```
CSV viewer                                      Embedded app
+---------------------------------------------+ +-------------------------------+
| pages/reports/signups.csv  [Save][Raw]      | | apps/release-checklist/       |
|    A         B        C                     | | Sandboxed app (i)             |
| 1  week      signups  churn                 | |  (iframe)                     |
| 3  2026-W37  [ 455 ]  1.1%   <- editing     | | This app cannot read your     |
| + Add row                                   | | session or other files.       |
| Saving creates a commit by Tariq            | +-------------------------------+
+---------------------------------------------+
```

PDF: toolbar `[< 3/12 >] [- 100% +] [download]`. Mermaid: diagram, `[Source]` toggle, parser error with source. Git folder with a binary: "This folder is stored in git, which holds text only. Upload attachments to a channel folder." Empty folder: "Nothing here yet." Restore confirm: "Restore `runbook.md` to Tue 14:02? A new commit will be made." Mobile: tree becomes a breadcrumb sheet; viewer fills the screen.

### 3 · Acceptance criteria

1. A new team's repo has the §5.1 layout.
2. 20 concurrent writes to different files give a linear history with all 20 changes; two concurrent writes to one file give the second a conflict carrying current content, nothing overwritten.
3. A saved page is one commit with the person as author.
4. A binary upload to a repo path is rejected and nothing is committed.
5. A bot's write to the four guarded paths is denied; `pages/x.md` succeeds.
6. Repo paths and `channels/<name>/` attachments show in one tree with identical rows; Lena gets 403 on `#dev` attachments; Nadia gets 403 on Marketing's tree.
7. Restore adds a commit and keeps old ones; a CSV cell edit changes that cell only.
8. An embedded app script cannot read the session cookie; a Mermaid syntax error shows the message and source without throwing.
9. Priya (`member`, not a lead) sees `bots/` and `TEAM.md` read-only with "change by pull request"; a direct write API call to them returns 403; Omar's UI change commits as Omar.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/files/tree.spec.ts` | Nadia expands `pages/`, `memory/`, `channels/dev/` → one tree; two memory subfolders; uniform row test ids |
| `e2e/files/markdown-edit.spec.ts` | WYSIWYG edit, `/` table, Raw toggle, save → commit by Nadia; raw round-trips |
| `e2e/files/csv.spec.ts`, `viewers.spec.ts` | edit cell; open PDF, PNG, MP4, `.ts`, Mermaid, Office → persisted, one commit; each viewer mounts, no console errors |
| `e2e/files/history-restore.spec.ts` | edit twice, diff, restore first → diff lines; restore adds a commit |
| `e2e/files/embedded-app.spec.ts` | open app → sandboxed; cookie read fails; bridge works |
| `e2e/files/binary-rejected.spec.ts`, `member-readonly-bots.spec.ts`, `acl-lena-sameera.spec.ts` | PNG to `pages/`; Priya edits `bots/`; Lena and Sameera → error copy; edit offered only as pull request; 403 |
| `e2e/api/repo/concurrency.spec.ts`, `bot-path-guard.spec.ts`, `pages-write.spec.ts` | 20 parallel writes; four guarded paths; create/replace/append → linear; four 403 with audit; events valid |
| `e2e/files/mobile-web.spec.ts` (`mobile-web`) | page and PDF → no horizontal scroll |

### 5 · Visual browser tests

- `files/files.visual.spec.ts` 1440×900: `[proto §02 plate 3 · Files]`. P.
- `files/history.visual.spec.ts` 1440×900: `[proto §11 plate 1 · Team repo and history]`. P.
- `files/page.visual.spec.ts` 1440×900: `[proto §11 plate 2 · Durable pages]`. P-loose.
- Own baselines, W: `files/csv`, `files/viewers` (PDF, image, code, Mermaid, app), `files/empty-error`, `files/mobile` (390×844).

### 6 · Exit

A team repo takes 20 concurrent edits with a linear history, no binary reaches git, bots cannot write the four guarded paths, and Files shows both stores as one tree.

---

# Phase 5 · Bots, gateways, conversations and Brain

Goal: a person clicks Brain, asks a question, and gets a cited answer from the team's repo, messages and memory. Includes `BOT.md` and its editor, LLM gateway, MCP gateway, Hermes runtime, Hindsight banks, Answer surface, Approvals inbox, two-stage gate. Size XXL. Spec §6.2, §6.3, §7, §7.3, §10.1–§10.2, §11, §12, §15 (basic), §19 weeks 3–6; proto §01–§03, §05, §11, §12. Blocks: A spike and bots, B LLM gateway, C MCP gateway, D runtimes, E memory, F conversations, Brain, approvals. The spike gates the rest ("stop and evaluate").

### 0 · Reflect and refactor

Re-read phase 4; list what was awkward, duplicated or slow. Prompts:
- Channels, files and now Brain's citations all resolve entity links. Extract one `links.resolve` capability into the SDK.
- Does `repo.committed` carry changed paths, so bot reload is cheap? Can `withActor` carry a **run** (trigger, asker, run id)? Add both before any bot code.
- Which schemas will web, server and Hermes tools share (`Citation`)? Place them in `shared` first. Did any viewer assume "a person is looking"?

Refactor with tests green; write `docs/retro/phase-5.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P5-01 | **Spike:** `slack-compat` endpoint plus one Hermes profile replying in a channel thread; report in `docs/spikes/slack-compat.md` | `plugins/slack-compat` | §19 | Sonnet; Haiku |
| P5-02 | **Spike:** per-run tool scoping with two concurrent conversation runs for two people; if the run id cannot be carried, adopt the per-run MCP URL fallback; orchestrator decides | `docs/spikes/per-run-scoping.md` | §6.2 | Sonnet; Haiku |
| P5-03 | Schema: `bots`, `bot_pairing_tokens` (hashed), `bot_runs`, `run_source_log` | `0030_bots.sql`, `shared/entities/bot.ts` | §7 | Sonnet |
| P5-04 | `bots` plugin: load `bots/<slug>/BOT.md` on `repo.committed`, validate strictly; invalid keeps the old definition and alerts; compile `mayTag` into allowlists; pairing token resolves to a bot actor | `plugins/bots` | §7.1, §7.6 | Sonnet |
| P5-05 | Web: **BOT.md editor** with tabs Identity · Behaviour · Triggers · Capabilities · Knowledge · Memory · Model · Guard · Approvals · Handover · Placement & limits · Evals · Audit (a lead or admin saves as a direct UI commit; replaced by proposals in P7-01); team roster from the Bots header; Bots in sidebar | `clients/web/screens/bot`, `roster` | §7.2, §7.5 | Sonnet |
| P5-06 | LiteLLM in compose env (Helm in P6-00/P10-07); config from the DB (providers, aliases `smart fast code local embed vision image transcribe`, fallbacks); virtual key per bot, minted and deleted with it | `packages/gateway-llm` | §10.1, §10.2 | Sonnet; Haiku |
| P5-07 | Budgets workspace → team → bot → session and rate limits enforced before the call; `llm_spend`; presets `standard`, `strict-egress`, `air-gapped`, `customer-facing`; pre-call DLP hook with `standard` | `gateway-llm`; `0031_llm.sql` | §10.1, §15 | Sonnet |
| P5-08 | Web: Workspace → LLM page; fake LLM for tests | `screens/admin/llm`, `tools/fake-llm` | §10.1 | Sonnet |
| P5-09 | `mcp-server` plugin (package `gateway-mcp`): one endpoint per bot, token auth, per-run scoping per the spike; native tools registered with the broker (`messages.*`, `memory.*`, `files.search`, `pages.write`, `knowledge.search` returning empty with reason "no bases configured", `tasks.*` stubs); every call is bot capabilities ∩ asker visibility; run source log written on every read | `packages/gateway-mcp` | §11, §6.2, §12 | Sonnet |
| P5-10 | `runtime-hermes`: render profile from `BOT.md` (body is SOUL.md), start and stop in the Hermes container, route `conversation`, `mention`, `channel_message` triggers, stream replies; `runtime-rules` no-model runtime | `plugins/runtime-hermes`, `runtime-rules` | §7.1 | Sonnet |
| P5-11 | **Gate, two stages** before any model call: exact or regex on the gate list, then a classifier on the `local` alias that sees only the message; a hit creates a pending approval and stops the run | `runtime-hermes/gate` | §7.3 | Sonnet |
| P5-12 | Hindsight in compose (Helm in P6-00/P10-07) (its own database, a second database in the same CNPG cluster; in this phase "reachable only from the gateway" is enforced by compose networks, pod and NetworkPolicy checks are phase 10); `memory-hindsight`: bank `team:<slug>` per team, bank derived from the pairing token, never a parameter | `plugins/memory-hindsight` | §12 | Sonnet; Haiku |
| P5-13 | `memory` plugin feeds the bank from team-visible messages, threads, runs, approvals, pages, handovers (source, actor, time, link); never private channels, DMs or `person:*` runs; narrowest-source retain rule from the run source log | `plugins/memory`, `gateway-mcp` | §12, §15 | Sonnet |
| P5-14 | `memory-git-mirror`: daily consolidation routine writes `memory/journal/`; a commit to `memory/facts/` re-retains, a delete forgets; `retention` plugin (run logs 90 days, never audit) | `plugins/memory-git-mirror`, `retention` | §12, §15 | Sonnet |
| P5-15 | `pnpm test:memory-cross-team` per PR: team A bot gets nothing from team B, including a forged `bank` | `memory-hindsight/test` | §12 | Sonnet; Haiku |
| P5-16 | `conversations`: per-bot channel unlisted in the sidebar; send starts a thread; Mine · Shared · Channel mentions; private by default; `conversation` trigger; web view with empty state and prompt chips | `plugins/conversations`, `screens/conversation` | §6.2 | Sonnet |
| P5-17 | Share to #channel with masking (team citations kept; person-scoped, tested here with a fake person-scoped source from seed v5, shown as "from <person>'s <source> · not shared" with snippet removed; the Drive-specific case is phase 8; preview; remove claim; access event); Save as page; Hand to a bot chips | `conversations`, `answer`, `pages` | §6.3, §6.4 | Sonnet |
| P5-18 | `answer` plugin: native `answer` tool, `AnswerPayload` schema, `Answer` component (numbered citations, Lineage, Sources reached, Outside scope, "Answered for … · scoped · alias", chips) | `plugins/answer`, `shared/entities/answer.ts` | §12, §14 | Sonnet |
| P5-19 | Brain `BOT.md` in every template (capabilities exactly §12; mail opt-in per person; 10-question eval set); minimal Coder, Support responder, Content drafter | `templates/*/bots` | §12, §13 | Sonnet |
| P5-20 | `approvals`: schema, **one handler** for `needsApproval`, whose four sources are Environment `protected`, `dispatch: strict`, DLP `require_approval` and the per-grant flag (the grant is the base mechanism); this phase wires DLP and grant, phase 6 wires environment and dispatch; requester cannot approve own; approvers by tag; inbox, in-thread card, sidebar count | `plugins/approvals`; `0032_approvals.sql` | §7.3 | Sonnet |
| P5-21 | Basic `guardrails-dlp` and `guardrails-egress` at `pre_egress` (allow, redact, require_approval, block); seed v5; event contracts | `plugins/guardrails-*` | §15 | Sonnet |
| P5-22 | **Minimal onboarding slice for M1** (steps 0, 1, 2, 5, 6 only: bootstrap, one sign-in provider, one model provider, first team from a template, default bots with Brain); plates `[proto §01 plate 1 · Step 1 · Sign-in methods]`, `[proto §01 plate 2 · Step 2 · Models]`, `[proto §01 plate 4 · Step 5 · Teams]`, `[proto §01 plate 5 · Step 6 · Bots]`, `[proto §01 plate 7 · After onboarding · Workspace → LLM]`; full wizard in phase 10 | `clients/web/screens/onboarding` | §16 | Sonnet |
| P5-23 | Platform writes: `memory.retain`, `lessons.md` and `people/<id>.md` are written by the platform (system actor) through the `memory` plugin, not through the bot's file capability; the path guard still denies a bot's own `files.*` write to them | `plugins/memory`, broker | §7.2, §12 | Sonnet |

### 2 · UI references

- Roster: `[proto §02 plate 5 · Bots — the roster (from the Bots header)]`, `[proto §03 plate 1 · Team roster]`.
- Bot page tabs: `[proto §05 plate 1 · Coder — Capabilities tab]`, `[proto §05 plate 2 · Support responder — Approvals tab]`, `[proto §05 plate 3 · Content drafter — Triggers tab]`, `[proto §05 plate 4 · Enquiry bot — Guard tab]`, `[proto §05 plate 5 · Behaviour and Evals are the same for everyone too]`.
- Conversations: `[proto §12 plate 1 · Click a bot — the conversation view, empty]`, `[proto §12 plate 2 · A conversation — Brain answers with citations]`, `[proto §12 plate 3 · Same view for every bot — Coder]`, `[proto §12 plate 4 · Brain's BOT.md]`.
- `[proto §11 plate 5 · Approvals inbox]`, `[proto §03 plate 2 · Team memory — one Hindsight bank per team, mirrored to git]`, `[proto §01 plate 7 · After onboarding · Workspace → LLM]`, `[proto §01 plate 2 · Step 2 · Models]`.

Wireframes (class W):

```
Share preview with masking                      Gate stop / invalid BOT.md
+--------------------------------------------+  +----------------------------------------+
| Share this answer to #releases             |  | ! BOT.md invalid: capabilities.native[3]|
| [1] #dev message Tue            kept       |  |   unknown `files.deletee`. Previous     |
| [2] memory/facts/release.md     kept       |  |   version still running.   [ Open line ]|
| [3] from Omar's Drive · not shared         |  +----------------------------------------+
|     snippet removed [ Remove claim on 3 ]  |  | This topic needs a person: credential   |
|              [ Cancel ] [ Share ]         |  | rotation. Rafi has been asked.          |
+--------------------------------------------+  +----------------------------------------+
```

Minimal wizard (class W; step 0 is the phase 2 bootstrap page):

```
+---------------+----------------------------------+
| 0 Sign in  ok | Step 6 · Bots                    |
| 1 Methods  ok | [x] Brain (always)  [x] Coder    |
| 2 Models   ok | [ ] Reviewer        [ ] Tester   |
| 5 Teams    ok | In the cluster (default)         |
| 6 Bots  <     | [ Back ]            [ Finish ]   |
| Full wizard:  | Finish setting up later: steps   |
 | phase 10     | 3, 4, 7, 8 stay on the checklist |
+---------------+----------------------------------+
```

Empty roster: "No bots yet. Add Brain from a team template." Approval card: requester, tool, arguments, environment, `[Approve][Decline]`, note; decided shows who and when.

### 3 · Acceptance criteria

1. Both spike answers are recorded with a decision.
2. A valid `BOT.md` appears in the roster in 5 s; one that fails to load shows a red banner on the bot page and the previous version stays live; unknown or missing keys fail with the field path.
3. The Hermes container holds no provider key, Hindsight address or repo credential; it calls the gateways with the pairing token only; a direct Hindsight call from it is refused by the compose network (pod-level NetworkPolicy checks are phase 10).
4. An exceeded budget at any level blocks the next call before the model runs; a hard-coded model name is rejected.
5. A forged `bank` argument is ignored (only `team:<own>`); a run that read `person:*` cannot retain to the team bank but can to `people/<asker>.md`; private channels and DMs are never retained.
6. A commit to `memory/facts/` becomes recallable; a delete is forgotten.
7. Nadia clicks Brain and sends: a new thread, her message as root, an Answer card with numbered citations, Lineage, Sources reached, Outside scope and the asked-for line; at least one citation is team memory.
8. Brain's only writes are `messages.post` and `pages.write`; "Hand to a bot" opens a thread and tags the bot; `routine`, `heartbeat`, `task_assigned`, `inbox` runs asking `person:*` are denied.
9. Sameera's Brain answer lists Engineering content under Outside scope.
10. Sharing masks the seeded person-scoped citation and writes an access event.
11. A stage-1 gate hit logs no LLM call; a stage-2 hit uses `local` only. DLP and grant `needsApproval` give identical rows through one handler and the requester cannot approve (environment and dispatch sources: phase 6).
12. A destructive-tagged tool in any grant fails CI lint.
13. A bot's own `files.write` to `bots/x/lessons.md` and `people/x.md` is denied, while the platform's `memory.retain` and lesson writes through the `memory` plugin succeed.
14. After the minimal onboarding (steps 0, 1, 2, 5, 6) a new admin has a team from a template with default bots and can ask Brain.

### 4 · Automated end-to-end tests

Fake LLM, real Hermes unless marked rules.

| Spec | Steps → assertions |
|---|---|
| `e2e/bots/botmd-editor.spec.ts` | Omar edits Coder Capabilities, saves; bad key → commit by Omar; bad key keeps old bot |
| `e2e/bots/roster.spec.ts`, `member-readonly.spec.ts` | open roster, click name; Priya opens a bot page → opens conversation; no Save (not a lead) |
| `e2e/conversations/brain-answer.spec.ts` | Nadia asks "What did we decide about the cache TTL?" → new thread; all Answer sections; memory citation |
| `e2e/conversations/empty-state.spec.ts`, `private-by-default.spec.ts` | Priya opens Brain; Nadia and Rafi each talk → no "new conversation"; Rafi cannot see Nadia's |
| `e2e/conversations/hand-to-bot.spec.ts` | click "Hand to Coder" → thread with question and answer; Coder tagged |
| `e2e/conversations/share-masking.spec.ts` | Nadia shares an answer citing the seeded fake person-scoped source to `#releases` → preview lists masked source; Lena sees "not shared"; access event |
| `e2e/conversations/scope.spec.ts`, `tagged-mention.spec.ts` | Sameera asks for Engineering runbook; Tariq mentions Coder → Outside scope; thread under Channel mentions for Tariq only |
| `e2e/approvals/inbox.spec.ts`, `two-sources.spec.ts` | Rafi approves, Nadia tries; DLP and grant sources → only Rafi can; one handler, identical rows |
| `e2e/api/gate/two-stage.spec.ts` | regex and classifier hits → no LLM call for stage 1; stage 2 alias `local` |
| `e2e/api/memory/platform-writes.spec.ts` | bot `files.write` to `lessons.md` and `people/x.md`; platform write via `memory` → denied; allowed |
| `e2e/onboarding/onboarding-minimal.spec.ts` | fresh stack, steps 0, 1, 2, 5, 6, ask Brain → team, default bots, answer |
| `e2e/api/memory/cross-team.spec.ts`, `retain-rule.spec.ts`, `git-mirror.spec.ts` | forged bank; person-source run; facts commit and delete → zero cross-team; team retain 403; recall then forget |
| `e2e/api/gateway/budgets.spec.ts`, `no-credentials.spec.ts` | session budget of one call; inspect container env → second call blocked; no keys |
| `e2e/rules/pairing-token.spec.ts` (rules) | real and forged token → forged denied |
| `e2e/channels/guest-lena.spec.ts` (bots case) | Lena opens Bots, mentions a bot, opens Brain → no Bots section; mention picker omits bots; API 403 |

### 5 · Visual browser tests

- `bots/roster` 1440×900: `[proto §02 plate 5 · Bots — the roster (from the Bots header)]`. P. `bots/team-roster`: `[proto §03 plate 1 · Team roster]`. P.
- `bots/capabilities`: `[proto §05 plate 1 · Coder — Capabilities tab]`. P. `bots/approvals-tab`: `[proto §05 plate 2 · Support responder — Approvals tab]`. P. `bots/triggers-guard`: plates 3 and 4. P-loose.
- `conversations/empty` (1440, 390): `[proto §12 plate 1 · Click a bot — the conversation view, empty]`. P. `conversations/brain-answer`: plate 2. P-loose. `conversations/coder`: plate 3. P-loose.
- `approvals/inbox` (1440, 390): `[proto §11 plate 5 · Approvals inbox]`. P. `memory/team-memory`: `[proto §03 plate 2 · Team memory — one Hindsight bank per team, mirrored to git]`. P-loose. `admin/llm`: `[proto §01 plate 7 · After onboarding · Workspace → LLM]`. P.
- `onboarding/minimal` 1440×900: plates `[proto §01 plate 1 · Step 1 · Sign-in methods]`, `[proto §01 plate 2 · Step 2 · Models]`, `[proto §01 plate 4 · Step 5 · Teams]`, `[proto §01 plate 5 · Step 6 · Bots]`. P-loose.
- Own baselines, W: `conversations/share-preview`, `bots/error-empty` (invalid BOT.md, empty roster, gate stop).

(All `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

Nadia clicks Brain and gets a cited answer with a team-memory citation; a team A bot cannot read team B's bank in CI; no Hermes container holds a credential; Approvals decides the DLP and grant `needsApproval` sources through one handler (environment and dispatch join in phase 6).

---

# Phase 6 · Tasks, boards, orchestration, rhythms and pages

Goal: bots and people work one board under the task substrate's rules; rhythms run on a schedule; pages are edited live by people and bots without clobbering. Size XL. Spec §5.2, §6.4, §6.5, §7.4–§7.6, §8; proto §02, §04, §11.

### 0 · Reflect and refactor

Re-read phase 5; list what was awkward, duplicated or slow. Prompts:
- `tasks.*` were stubs. Do stubs match the real tool shape, so replacing them touches only the plugin? Remove any gateway special case.
- Did the approval handler and the gate each invent a "waiting for a person" state? Keep one.
- Is "what is this bot doing now" indexed (partial index on running runs)? Did board, handover and approval cards each build their own card? Extract one.

Refactor with tests green; write `docs/retro/phase-6.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P6-00 | Helm and controller skeleton: the chart renders, the controller reads the DB and creates Deployments (no NetworkPolicy yet); needed by P6-06's `nodeSelector` test and P8-03's Activepieces start | `deploy/helm`, `packages/controller` | D4, §2 | Sonnet; Haiku |
| P6-01 | Schema: `goals`, `tasks` (`open`/`in_progress`/`verify`/`waiting_on_person`/`done`, `base_sha`, `tested_sha`), `task_events` (BRIN), `task_claims` with partial unique index (one active claim per branch), `handoffs` | `0040_tasks.sql`, `shared/entities/task.ts` | §8, §7.6 | Sonnet |
| P6-02 | `tasks` plugin: create, assign, claim, complete, handoff; claim timeouts by job; wake on `task.updated`; real `tasks.*` tools replace the stubs | `plugins/tasks`, `gateway-mcp` | §8 | Sonnet |
| P6-03 | Handover: `handoff_task` moves ownership in one transaction, posts the `@mention` card, delivers `task.assigned` with a fresh worktree, ends the caller's turn; `mayTag` rejects before attempting; `dispatch: strict` sets `needsApproval` on handoff; the approvals handler now has all four sources (environment, dispatch, dlp, grant), grant being the base mechanism | `tasks`, `runtime-hermes`, `approvals` | §7.3, §7.6 | Sonnet |
| P6-04 | Freshness (stale `base_sha` or `tested_sha` blocks publish and merge with a reason); rework, handoff and spend bounds | `tasks` | §8 | Sonnet |
| P6-05 | Environments: schema, `protected` sets `needsApproval` on tagged tools; shared repos: team bare mirror, per-bot worktrees, branch-scoped push tokens, git smart-HTTP, merge behind approval | `plugins/tasks`, `repo-git/shared` | §8, §7.3 | Sonnet |
| P6-06 | Runner: one binary, one outbound connection, advertises capabilities (`chrome cdp playwright docker gpu ffmpeg windows ios-simulator claude-code codex`); one runner, one team; `nodeSelector` placement in cluster | `packages/runner`, `bots` | §7.4 | Sonnet; Haiku |
| P6-07 | `boards` plugin and screen: five columns over tasks, card thread, follow card = follow thread; drag calls the task API (rules apply); org chart view (leads above specialists, `mayTag` edges) | `plugins/boards`, `clients/web` | §6.5, §7.5 | Sonnet |
| P6-08 | `rhythms`: schema, heartbeat, routine (`routines/<slug>.yaml` with contract and `output: { page, mode }`), task; `model` and `effort` override; scheduler on the job queue; Rhythms tab and forms (non-leads propose) | `plugins/rhythms`; `0042_rhythms.sql` | §6.5, §6.4 | Sonnet |
| P6-09 | Yjs pages: server-held doc on the Fastify WS; `page_docs`, `page_updates` (BRIN), UNLOGGED awareness; Tiptap bindings with live cursors; one commit per editing session (idle 60 s or close) with every contributor as co-author; bots write through the same doc; `pages.write` now uses it | `plugins/pages`, `viewers/md` | §5.2, §6.4 | Sonnet |
| P6-10 | Counting benchmark: spec §8 workload: twenty bots, one counter task; each claims, adds one, releases; the log reads 1 to 20 exactly, no duplicate or gap, within 60 s. Rules variant per PR (`pnpm test:runtime-rules`, no model); Hermes variant nightly and on release | `runtime-rules/bench` | §8 | Sonnet; Haiku |
| P6-11 | Seed v6 (board, rhythms, page, `production`); event contracts | `e2e/fixtures`, `shared/src/events` | guide §6 | Sonnet |
| P6-12 | Engineering template bots: Orchestrator, Reviewer, Tester, Deploy, Alert triage, Standup relay (automation), each with `BOT.md`, eval set and setup prompt | `templates/engineering/bots` | §13 | Sonnet |

### 2 · UI references

- Boards `[proto §02 plate 4 · Boards]`; Rhythms `[proto §11 plate 3 · Rhythms]`; Org chart `[proto §11 plate 4 · Org chart]`; page `[proto §11 plate 2 · Durable pages]`.
- `[proto §04 plate 1 · Servers and runners]`, `[proto §04 plate 2 · Orchestrator]`, `[proto §04 plate 3 · Coder]`, `[proto §04 plate 4 · Tester]`, `[proto §04 plate 5 · The run]`, `[proto §11 plate 5 · Approvals inbox]`.

Wireframes (class W):

```
Environments                                       Live page header
+---------------------------------------------+   +--------------------------------------+
| Engineering · Environments        [ + Add ] |   | week-37.md  (N)(T)(Brain · writing)   |
| production  protected [x]  Mon-Thu 09-16    |   | Saved to history when everyone leaves |
|   cap 2/day  rollback on  cred k8s-prod-eu  |   | or after 1 min idle.                  |
|   Every tool tagged production waits.       |   +--------------------------------------+
| staging     protected [ ]  any   cap -      |   Stale publish card
+---------------------------------------------+   | Blocked: base_sha is 3 commits behind |
Mobile board: columns as a snap strip with a      | main. Rebase, then retest.            |
column switcher; card opens as a full sheet.      +--------------------------------------+
```

Empty board: "No cards. Create one or ask Orchestrator." Empty Rhythms: "A heartbeat is a prompt on a timer; a routine has a contract and writes a page." Claim conflict toast: "Already owned by Reviewer."

### 3 · Acceptance criteria

1. Two simultaneous claims: one wins, one gets `already_owned`.
2. `handoff_task` moves ownership atomically; the old owner cannot act; the card and a fresh worktree are delivered; a target outside `mayTag` is rejected before any effect.
3. `dispatch: strict` puts handoff in Approvals; a stale `base_sha` blocks publish with the reason on the card.
4. A deploy tool tagged `production` waits for approval; Nadia cannot approve her own request. All four sources (environment, dispatch, DLP, grant) produce identical Approvals rows through the one handler.
5. Dragging a code task to Done without `tested_sha` is blocked; Priya can follow a card but cannot approve its deploy.
6. A heartbeat fires on the fake clock; a routine writes its page and the thread shows "wrote … · diff"; a contract violation fails the run.
7. Nadia and Brain edit one page together: all text present, cursors visible, one commit within 5 s of the last close with both as co-authors.
8. Counting benchmark (rules variant): twenty bots, one counter task, claim, add one, release; the log reads 1 to 20 exactly with no duplicate or gap, never two owners (from `task_events`), within 60 s, no model call.
9. A runner with `chrome` appears with capabilities and a bot needing `chrome` is placed on it; the Helm template test shows `nodeSelector` for `placement.node`; the org chart edges equal `mayTag`.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/boards/board-flow.spec.ts` | Nadia creates a card; Orchestrator assigns; Coder, Reviewer, Tester → columns advance; one owner each step |
| `e2e/boards/claim-race.spec.ts`, `drag-rules.spec.ts` | simultaneous claims; drag without tested sha → one 200; blocked with reason |
| `e2e/boards/follow.spec.ts`, `member-board.spec.ts`, `mobile-web.spec.ts` | Priya follows a card; strip at 390 px → thread in her inbox; no Approve on a deploy card; no horizontal scroll |
| `e2e/approvals/deploy-protected.spec.ts`, `four-sources.spec.ts` | Coder requests deploy; Rafi approves; Nadia cannot; trigger all four sources → result in thread; one handler, identical rows |
| `e2e/rhythms/heartbeat.spec.ts`, `routine-page.spec.ts`, `contract-violation.spec.ts` | fake clock; weekly report; bad type → fires N times; page, diff line, history actor; failed run with reason |
| `e2e/pages/yjs-concurrent.spec.ts`, `session-commit.spec.ts` | Nadia, Tariq and a routine edit one page; leave → all text; one commit with three co-authors within 5 s |
| `e2e/orgchart/orgchart.spec.ts`, `e2e/runners/runner-connect.spec.ts` | open chart; start runner with `chrome` → edges match; capabilities shown, offline on disconnect |
| `e2e/api/substrate/counting-rules.spec.ts`, `freshness.spec.ts`, `mayTag.spec.ts` | benchmark; stale shas; outside `mayTag` → criteria 8, 3, 2 |

### 5 · Visual browser tests

- `boards/board` 1440×900: `[proto §02 plate 4 · Boards]`. P. `rhythms/rhythms`: `[proto §11 plate 3 · Rhythms]`. P. `orgchart/orgchart`: `[proto §11 plate 4 · Org chart]`. P.
- `pages/page`: `[proto §11 plate 2 · Durable pages]`. P-loose. `runners/servers`: `[proto §04 plate 1 · Servers and runners]`. P-loose.
- `bots/orchestrator-coder-tester`: plates `[proto §04 plate 2 · Orchestrator]`, `[proto §04 plate 3 · Coder]`, `[proto §04 plate 4 · Tester]`. P-loose. `bots/run`: `[proto §04 plate 5 · The run]`. P-loose. `approvals/deploy`: `[proto §11 plate 5 · Approvals inbox]`. P.
- Own baselines, W: `boards/mobile` (390×844), `boards/states` (environments, empty board, empty rhythms, stale card, claim toast).

(All `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

The rules counting benchmark passes per PR with one owner per task at every moment, a person and a bot edit one page live with one co-authored commit, and a protected environment makes a deploy wait for someone other than the requester.

---

# Phase 7 · Self-setup and the Workshop

Goal: "Add a bot" is a brief; the bot inventories the team, grades each requirement, asks what is missing and proposes its own `BOT.md` as a diff. After approval the Workshop is its persistent conversation: build, rehearse, learn. Size L. Spec §9, §7.3, §8 (evals), §6.2; proto §06, §07, §11.

### 0 · Reflect and refactor

Re-read phase 6; list what was awkward, duplicated or slow. Prompts:
- Self-setup and the Workshop both produce a **proposal** (a diff to `bots/`, `skills/`, `routines/`, `TEAM.md`). Make one shared `Proposal` schema and one apply path now.
- Does the conversation view have a slot for the extra Workshop tab (`surface.panel`) without a special case? Is write interception for Rehearse in the broker (one place), not per tool?
- Evals run in three places (on demand, on commit, nightly). Extract a single run-a-scenario function into the SDK.

Refactor with tests green; write `docs/retro/phase-7.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P7-01 | Schema: `Proposal` (target path, diff, base sha, author, status, checks), `proposals`; one apply path that commits as the approver; the only way a bot changes `bots/`, `TEAM.md`, `skills/`, `routines/`; replaces the direct UI commit by a lead or admin from P4-05 and P5-05 (UI changes by leads and admins become proposal then commit) | `0050_proposals.sql`, `shared/entities/proposal.ts` | §7.2, principle 5 | Sonnet |
| P7-02 | Setup profile with a tiny toolset only: `describe_self`, read-only `knowledge.search`, `ask_clarification`, `propose_config`; `describe_self` returns the team inventory scoped to the asker | `templates/_setup`, `plugins/workshop` | §9, principle 7 | Sonnet |
| P7-03 | Requirement grading `Grade` enum (covered · grantable · missing · blocked · unclear), one batched question per gap; `propose_config` builds the diff and rejects anything looser than team defaults | `workshop` | §9 | Sonnet |
| P7-04 | Web: Add a bot flow (brief, discovery with grades, proposal with diff, Approve creates the bot and applies grants) | `clients/web/screens/setup` | §9 | Sonnet |
| P7-05 | Workshop tab (Build · Rehearse · Live) in the conversation view; Build turns requests into proposals; Rehearse runs real prompt, knowledge and read tools, plus a stub write tool (`test.write`) for this phase, with **every write intercepted by the broker and badged**; Live asks about real runs from audit data | `plugins/workshop` | §9 | Sonnet |
| P7-06 | Learning loop: correction files a lesson to `lessons.md` (proposal), adds an eval case, proposes a rule when a lesson repeats or on "make that a rule"; lessons contradicting a gate or guard refused; compaction proposal past `maxLines` | `workshop/learning` | §9 | Sonnet |
| P7-07 | Record and replay of guard and gate decisions only (free); full model replay on request with cost shown first; re-assessment when a connection, base or runner is added or revoked, or an eval score drops | `workshop/replay` | §9 | Sonnet |
| P7-08 | Eval harness: `EvalCase` and `EvalResult` schemas, scenarios in `bots/<slug>/evals/`, `pnpm test:evals -- --bot=<slug>`, `minScore` gate; runs on demand, on any commit touching a `BOT.md`, nightly | `bots/evals`, `shared/entities/eval.ts` | §8 | Sonnet; Haiku |
| P7-09 | Terminal into a sandbox: admin-only, never on production placements, recorded, **credentials minted for the run revoked the moment it opens**; PTY over WS | `workshop/terminal` | §9 | Sonnet |
| P7-10 | Seed v7 (brief for Content drafter, failing eval, repeated lesson); event contracts | `e2e/fixtures` | guide §6 | Sonnet |

### 2 · UI references

- `[proto §06 plate 1 · The brief]`, `[proto §06 plate 2 · Discovery, feasibility, questions]`, `[proto §06 plate 3 · The proposal]`.
- `[proto §07 plate 1 · Build mode — shaping it by talking]`, `[proto §07 plate 2 · Rehearse mode — testing by talking, and learning from it]`, `[proto §07 plate 3 · Live mode — the same loop on real work]`.
- `[proto §11 plate 7 · Terminal into a bot's sandbox (Workshop · Live)]`, `[proto §05 plate 5 · Behaviour and Evals are the same for everyone too]`.

Wireframes (class W):

```
Looser proposal refused                       Terminal not available
+--------------------------------------+      +--------------------------------------+
| Proposal refused                     |      | Terminal is admin-only and not        |
| The Guard removes "credential        |      | available on production placements.   |
| rotation" from the gate list.        |      | (placement: prod-eu)                  |
| Proposals can add stricter rules,    |      | Admin on a sandbox: "Opening a        |
| not looser.   Changed: guard.gate -1 |      | terminal revokes this run's           |
| [ Ask the bot to retry ] [ Discard ] |      | credentials. You will use your own."  |
+--------------------------------------+      +--------------------------------------+
```

Eval failure banner: "Eval 17 of 20 passed · minimum 0.90 · view failures". Empty Workshop: "Tell this bot what to change." Lesson refused: "That lesson contradicts the gate list. It was not saved." Mobile: tabs as a segmented control; diffs scroll inside their card.

### 3 · Acceptance criteria

1. A brief gives a graded list, one of five grades per requirement, a reason for each non-covered one; two gaps give one batched question.
2. A proposal looser than defaults is refused with the changed field named.
3. Approve creates the bot, commits `BOT.md` with the approver as author, applies grants, and the setup thread becomes the Workshop; the setup profile has no file, shell or connection tool.
4. A bot's direct write to `bots/` is denied; the same change as a proposal applies after approval.
5. In Rehearse, the stub `test.write` tool sends nothing and shows a "would have sent" badge with arguments (the `email.send` case is tested in phase 8).
6. A correction makes a lesson (via proposal) and an eval case; a lesson repeated three times proposes a rule; a lesson contradicting the gate list is refused.
7. Replay of gate decisions makes no model call and matches the record.
8. A commit changing `bots/coder/BOT.md` runs Coder's evals and flags a score below `minScore`.
9. Omar's terminal on a sandbox revokes credentials before the first keystroke, is recorded and audited; Nadia, and any placement that is production, cannot open one. Priya (not a lead or admin) cannot approve a bot proposal; she sees it read-only.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/setup/brief-to-bot.spec.ts` | Omar adds Content drafter, answers the batched question, approves → grades; bot in roster; commit by Omar; Workshop tab |
| `e2e/setup/stricter-only.spec.ts`, `permissions.spec.ts` | looser proposal forced; Priya and Lena open Bots → refusal card, no commit; Priya has no Approve on proposals; Lena has no Bots section |
| `e2e/workshop/build.spec.ts` | "Always cite the manual section", approve diff → body changed in a commit |
| `e2e/workshop/rehearse.spec.ts` | Content drafter, a request that calls `test.write` → reply drafted; write badged and not performed |
| `e2e/workshop/learning.spec.ts`, `lesson-refused.spec.ts` | same correction x3; "stop asking before rotating credentials" → lesson, 3 cases, rule proposal; refused with reason |
| `e2e/workshop/live.spec.ts`, `replay.spec.ts` | "what did you do yesterday?"; replay gates → cites existing run ids; zero LLM calls |
| `e2e/workshop/terminal.spec.ts` | Omar on sandbox; Nadia; production → revoked event before first input; others denied; recording downloadable |
| `e2e/evals/on-commit.spec.ts`, `e2e/api/proposals/bots-path.spec.ts` | worse Coder body; bot writes `bots/x/BOT.md` → score flagged; direct denied, proposal works |
| `e2e/workshop/mobile-web.spec.ts` (`mobile-web`) | Workshop → segmented tabs; no horizontal scroll |

### 5 · Visual browser tests

- `setup/brief` 1440×900: `[proto §06 plate 1 · The brief]`. P. `setup/discovery`: plate 2. P-loose. `setup/proposal`: `[proto §06 plate 3 · The proposal]`. P.
- `workshop/build`, `workshop/rehearse`, `workshop/live`: `[proto §07 plate 1 · Build mode — shaping it by talking]`, `[proto §07 plate 2 · Rehearse mode — testing by talking, and learning from it]`, `[proto §07 plate 3 · Live mode — the same loop on real work]`. P-loose. `workshop/terminal`: `[proto §11 plate 7 · Terminal into a bot's sandbox (Workshop · Live)]`. P-loose.
- Own baselines, W: `workshop/states` (1440 and 390: refused proposal, terminal unavailable, eval failure, empty Workshop).

(All `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

Omar adds a bot from a one-line brief and approves it, a rehearsal sends nothing, a looser proposal is refused, and the terminal opens only for an admin on a sandbox with credentials revoked first.

---

# Phase 8 · Connections, knowledge and email bots

Goal: bots reach the outside world through one MCP gateway without holding a credential; Brain searches a person's own Drive with that person's grant; knowledge bases sync and cite chunk versions; two email bots work end to end; usage is recorded in a partitioned time-series table. Size XL. Spec §11, §12 (knowledge), §13, §7.2 (triggers), §15; proto §10, §08, §01.

### 0 · Reflect and refactor

Re-read phase 7; list what was awkward, duplicated or slow. Prompts:
- The MCP gateway gains three tool sources. Extract a `ToolSource` interface before the second one; reuse the phase 2 `kms` for connection secrets, not a copy.
- Write one test helper asserting "bot capabilities ∩ asker visibility" for any source and run it on every source added here.
- Is the job queue's cron helper indexed for hundreds of sync rhythms? Do two schemas spell `source` or `scope` differently? Unify in `shared`.

Refactor with tests green; write `docs/retro/phase-8.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P8-01 | Schema: `connections` (scope team/person/workspace, owner, expiry, environment tag), `connection_grants` (tool allowlist, `needsApproval`), `connection_secrets` (envelope-encrypted, no read-back); `ToolSource` interface; CI lint failing any destructive tool in a grant | `0060_connections.sql`, `gateway-mcp`, `plugins/connections` | §11 | Sonnet |
| P8-02 | **Person connections** held by manythreads: Google (Drive, Gmail, Calendar as incremental scope on the sign-in app), Microsoft Graph, Notion; `person:*` resolves only here, only for `conversation` and `mention` runs, recorded as person-scoped; mail grant opt-in per person | `connections/person`, `identity-oidc` | §11, §12, §20 | Sonnet |
| P8-03 | Team connections: Activepieces started by the controller skeleton from P6-00 on first non-first-party use (per-team project, limited-scope OAuth, pieces as MCP); GitHub App (hourly tokens) and GitHub MCP; GitLab service user and MCP; team repo push to GitHub or GitLab | `connections/*`, controller | §11, §5.1 | Sonnet; Haiku |
| P8-04 | SSH broker (step-ca or Teleport, cert per task ≤ 1 h) and Kubernetes broker (`TokenRequest` per task ≤ 1 h) | `gateway-mcp/brokers` | §11 | Sonnet; Haiku (kind) |
| P8-05 | Eval harness on pull request: GitHub check for any PR touching a `BOT.md`; merge reloads the bot | `bots/evals`, `connections/github` | §5.1, §8 | Sonnet |
| P8-06 | Web: Team connections, Add connection (incl. Kubernetes), bot Access tab, account Connections page with mail opt-in | `clients/web/screens` | §11 | Sonnet |
| P8-07 | Schema: `knowledge_bases`, `knowledge_sources`, `knowledge_documents` (content hash), `knowledge_chunks` (`vector`, `version`; HNSW; trigram on text); `knowledge` plugin loads `sources.yaml` (PDF, manuals, Drive/SharePoint, docs sites, repo `docs/`, Notion), chunks and embeds via `embed` | `0061_knowledge.sql`, `plugins/knowledge` | §12, D3 | Sonnet |
| P8-08 | Sync rhythm per source, hash change detection, bump chunk `version`; real `knowledge.search`; `answer_only_from` blocks unsupported answers and routes to `#kb-updates`; citations carry version and the Answer shows "source changed since"; Knowledge bases screen | `knowledge`, `answer`, `clients/web` | §12 | Sonnet |
| P8-09 | Email connections (IMAP, Gmail, Outlook) as tool sources (`email.read/label/move/draft/send`, send `needsApproval`); `inbox-watch` (`inbox` trigger: folder, filter, dedupe by thread, one run thread per email thread); `webhooks` (`webhook` trigger, signed) | `connections/email`, `inbox-watch`, `webhooks` | §11, §13, §7.2 | Sonnet |
| P8-10 | Templates: Support responder (manuals base, `customer-facing`, gate list, send approval) and Enquiry bot (classify, typed lead, draft, board card), each with evals and setup prompt; finish Coder and Content drafter grants | `templates/*` | §13 | Sonnet |
| P8-11 | `analytics` plugin: `analytics_events` monthly partitions + BRIN (Appendix A.7), partition and rollup jobs, emitters (spend, runs, tool calls, approvals, answers scoped or full, knowledge hits, sign-ins); usage pages (workspace, team, bot, Brain quality) | `plugins/analytics`; `0062_analytics.sql` | D3, §10.1 | Sonnet |
| P8-12 | Seed v8 (mock Google and GitHub, `product-manuals`, mailbox of 5 threads); event contracts | `e2e/fixtures` | guide §6 | Sonnet |
| P8-13 | Remaining template bots: Marketing (Content drafter, Social scheduler, Analytics digest, Brand reviewer), Research (Literature scout, Summariser, Experiment tracker, Citation checker), Product design (Spec writer, Feedback synthesiser, Design critique, Figma watcher), Customer support (Escalation router, KB gardener), each with `BOT.md`, eval set and setup prompt; Rehearse test of `email.send` for Support responder | `templates/*/bots` | §13, §9 | Sonnet |

### 2 · UI references

- `[proto §10 plate 1 · Team connections]`, `[proto §10 plate 2 · Add a connection — Kubernetes]`, `[proto §10 plate 3 · A bot's Access tab]`, `[proto §01 plate 3 · Steps 3 and 4 · Code and infrastructure]`.
- `[proto §08 plate 1 · Support responder — Triggers, knowledge, mode]`, `[proto §08 plate 2 · Knowledge base — product manuals]`, `[proto §08 plate 3 · #support — the responder at work, with send needing approval]`, `[proto §08 plate 4 · #enquiries — the enquiry bot on the sales inbox]`, `[proto §11 plate 5 · Approvals inbox]`.

Wireframes (class W):

```
Account → Connections                            Usage
+------------------------------------------+     +-----------------------------------------+
| Google  omar@kahf.co  Drive [x] Gmail [ ] |     | Usage · 30 days            [Team v][Bot v]|
|   Used only when you ask. Never by        |     | Spend £412 of £1,000  ########-------     |
|   routines.  [Change access][Disconnect]  |     | smart £260  fast £90  code £52  embed £10 |
| Microsoft  Not connected   [ Connect ]    |     | Bot     Runs  Tool calls  Spend   Errors  |
| Notion     Not connected   [ Connect ]    |     | Brain   812   2,904       £130    0.4%    |
| Let Brain search my mail   [ off ]        |     | Coder   96    3,310       £210    2.1%    |
+------------------------------------------+     +-----------------------------------------+
```

Errors: token expired ("Reconnect Google. Brain cannot search your Drive until you do."), sync failed ("Last sync failed: 403 from the Drive folder. Previous version still serves answers."), no connections, usage empty. Mobile: rows stack; bars become a list.

### 3 · Acceptance criteria

1. A bot with a GitHub grant never receives a token; the gateway mints a branch-scoped push token per task that expires with it. A destructive tool in a grant fails CI.
2. Nadia connects her Drive and asks Brain: the answer searches her Drive ("Drive · scoped"); Rafi's same question does not search it and lists it under Outside scope. A routine using `person:*` is denied; with mail opt-in off Brain never calls `gmail.search`.
3. First non-first-party app starts Activepieces and the team project; credentials cannot be read back through any API. SSH certs and k8s tokens live 1 h or less and are per task.
4. A PR touching `bots/coder/BOT.md` runs the eval check; merge reloads the bot.
5. A changed source is detected by hash, re-indexed, version bumped; unchanged documents are not re-embedded; an answer citing version 3 shows "source changed since" when it is 4.
6. With `answer_only_from` and no supporting passage the bot declines and `#kb-updates` gets the question.
7. One email thread gives exactly one run thread; a second email joins it. Support responder's reply waits for a `role:support-agent` approver and nothing reaches the customer before approval; Enquiry bot extracts a typed lead, opens a card, saves a draft.
8. `analytics_events` has partitions for this and the next two months and a one-day query scans one partition. Sameera cannot see Engineering connections; Tariq cannot see Support's mailbox.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/connections/team-connections.spec.ts`, `access-tab.spec.ts` | Omar adds mock GitHub, grants Coder three tools; toggles `needsApproval` on `email.send` → destructive tool absent from picker; commit, badge |
| `e2e/connections/person-drive.spec.ts`, `mail-optin.spec.ts` | Nadia connects mock Google, asks Brain; Rafi asks; toggle mail → scoped citation for Nadia only; mail reached only when on |
| `e2e/connections/routine-person-denied.spec.ts`, `k8s-ssh.spec.ts` (nightly, kind) | routine asks `person:*`; Coder task → denied with audit; lifetimes ≤ 1 h, revoked |
| `e2e/knowledge/sync-version.spec.ts`, `answer-only-from.spec.ts` | change a source, sync, ask; ask outside manuals → version bump and "source changed since"; decline and `#kb-updates` message |
| `e2e/email/support-responder.spec.ts`, `thread-dedupe.spec.ts` | customer email; Sameera approves; second email → draft, send waits, one message sent; same run thread |
| `e2e/workshop/rehearse-email.spec.ts` | Rehearse the Support responder with a customer message → reply drafted; `email.send` badged; mock mail empty |
| `e2e/email/enquiry-bot.spec.ts`, `permissions.spec.ts` | sales enquiry; Tariq and Nadia open `#support` → lead card, draft only; not visible |
| `e2e/usage/usage-pages.spec.ts`, `e2e/api/analytics/partitions.spec.ts` | run bots, open Usage; insert across 3 months → seed numbers, budget bar; right partitions, one scanned |
| `e2e/api/github/pr-eval.spec.ts` | mock PR on a `BOT.md` → check posted; merge reloads |

### 5 · Visual browser tests

- `connections/team`: `[proto §10 plate 1 · Team connections]`. P. `connections/add-k8s`: `[proto §10 plate 2 · Add a connection — Kubernetes]`. P. `connections/access-tab`: `[proto §10 plate 3 · A bot's Access tab]`. P. `connections/code-infra`: `[proto §01 plate 3 · Steps 3 and 4 · Code and infrastructure]`. P-loose.
- `email/responder`: `[proto §08 plate 1 · Support responder — Triggers, knowledge, mode]`. P. `email/knowledge`: `[proto §08 plate 2 · Knowledge base — product manuals]`. P. `email/support-channel`: `[proto §08 plate 3 · #support — the responder at work, with send needing approval]`. P-loose. `email/enquiries`: `[proto §08 plate 4 · #enquiries — the enquiry bot on the sales inbox]`. P-loose.
- Own baselines, W: `connections/person`, `usage/usage` (1440, 390), `connections/empty-error`.

(All 1440×900, `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

Brain searches Nadia's own Drive with her grant and never anyone else's, no bot holds a credential, a changed knowledge source bumps the chunk version and the old citation says so, and a support email reaches a customer only after a person approves it.

---

# Phase 9 · Surfaces

Goal: a bot hands a person a screen instead of a paragraph. Only registered components with schema-checked props render; a bot composes an interface and never writes code. Size M. Spec §14, §6.4, §12, §3 (`component.register`); proto §09, §12.

### 0 · Reflect and refactor

Re-read phase 8; list what was awkward, duplicated or slow. Prompts:
- `Answer` is a fixed component fed by `AnswerPayload`. Is the split clean between props schema (shared) and implementation (web)? Does it import server code?
- Does the right panel take `surface:<id>` with no kernel change? Extract shared `Card` and `Stat` primitives now; screens built their own.
- Is data binding scoped to the **viewer** or to the bot? It must be the viewer.

Refactor with tests green; write `docs/retro/phase-9.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P9-01 | Schema: `surfaces` (bot, run, thread, OpenUI source, version, pinned channel), `surface_events` | `0070_surfaces.sql`, `shared/entities/surface.ts` | §14 | Sonnet |
| P9-02 | Component registry in `shared`: name plus Zod props schema, read by client and server; unregistered names and invalid props rejected, never rendered | `shared/src/surfaces/registry.ts` | §14, §3 | Sonnet |
| P9-03 | OpenUI renderer (MIT): streams OpenUI Lang, validates each node, renders progressively, shows a rejection card and keeps the rest | `clients/web/surfaces/renderer` | §14 | Sonnet |
| P9-04 | `surface.render/update/event` at the MCP gateway; update patches by node id; events return as validated payloads; a surface cannot call a tool its bot lacks | `plugins/surfaces`, `gateway-mcp` | §14 | Sonnet |
| P9-05 | Primitives (Stack, Row, Grid, Heading, Text, Stat, Table, Chart, List, Badge, Button, Callout, Code, Divider) and manythreads components (EntityCard, PersonChip, ChannelLink, ApprovalCard, DiffView) | `surfaces/primitives`, `manythreads` | §14 | Sonnet |
| P9-06 | Data binding: a node declares a registered read tool; the call runs **as the viewer** through the gateway; refresh by interval or event | `surfaces`, `gateway-mcp` | §14, principle 7 | Sonnet |
| P9-07 | `Answer` re-implemented as a registered component on the same `AnswerPayload`; renders identically in a channel thread and a conversation | `answer`, `surfaces` | §12, §14 | Sonnet |
| P9-08 | App components: `FormFlow` (schema-validated, one payload to the bot), `ReportBuilder` (sections, tables, charts bound to data, live), `ImageGenerator` (`image` alias, variants, save to Files storage as an attachment) | `surfaces/apps` | §14, §10.1 | Sonnet |
| P9-09 | Export to pages by default (images stay in Files storage), pin to channel bar; safety: no script, proxied images, prop size limits; seed v9; event contracts | `surfaces`, `pages` | §6.4, §14 | Sonnet |

### 2 · UI references

- `[proto §09 plate 1 · A report in the panel, pinned to the channel]`, `[proto §09 plate 2 · A form instead of a paragraph]`, `[proto §09 plate 3 · Image generator]`, `[proto §12 plate 2 · A conversation — Brain answers with citations]` (Answer).

Wireframes (class W):

```
Rejected node                                   Form errors
+---------------------------------------+     +---------------------------------------+
| Weekly report            Content drafter |   | 2 fields need attention               |
| [Stat Posts 12]   [Stat Reach 41k]     |     | Company  [            ] Required      |
| +-----------------------------------+  |     | Email    [ not-an-email ] Invalid     |
| | This part could not be shown      |  |     | [ Submit ] (disabled while invalid)   |
| | Unknown component "Marquee".      |  |     +---------------------------------------+
| +-----------------------------------+  |     Image error: "The image alias is not
| [ Table … ]                            |     configured. Ask an admin (Workspace → LLM)."
+---------------------------------------+
```

Loading: skeleton of the first node. Mobile: panels become full sheets, grids one column, tables scroll inside their card.

### 3 · Acceptance criteria

1. An unregistered component shows the rejection card and every other node renders; invalid props (type or size) are rejected with the field path in the audit event; script tags and `javascript:` URLs never execute.
2. The first node renders before the stream ends.
3. A bound table viewed by Sameera shows only rows she can see, fetched as Sameera; a tool the bot lacks is denied.
4. A form submission reaches the bot as one payload that validates; invalid payloads never reach it.
5. Export writes a Markdown page under `pages/` and the thread shows "wrote pages/…"; pinning shows the bar to channel members only; images are Files-storage attachments, not git.
6. ImageGenerator works through the `image` alias. `Answer` from the renderer matches phase 5's output within class P. Lena sees a pinned surface read-only with no active inputs.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/surfaces/report-pin.spec.ts`, `report-export.spec.ts` | Tariq asks ReportBuilder; pin to `#analytics`; export → bar for members only; page, history, diff line |
| `e2e/surfaces/form.spec.ts` | Sameera fills the lead form, invalid then valid → inline errors; one validated submission |
| `e2e/surfaces/image.spec.ts` | Tariq generates, picks, saves → attachment row, not in git |
| `e2e/surfaces/rejected-node.spec.ts`, `xss.spec.ts` | bad node; script props → rejection card, rest renders; nothing executes |
| `e2e/surfaces/data-binding-scope.spec.ts`, `answer-renderer.spec.ts` | Sameera and Tariq view one table; Nadia asks Brain → rows differ; Answer has all sections |
| `e2e/surfaces/guest-readonly.spec.ts`, `mobile-web.spec.ts` | Lena views pinned surface; report and form at 390 px → inputs disabled; one column, no horizontal scroll |

### 5 · Visual browser tests

- `surfaces/report`: `[proto §09 plate 1 · A report in the panel, pinned to the channel]`. P. `surfaces/form`: `[proto §09 plate 2 · A form instead of a paragraph]`. P. `surfaces/image`: `[proto §09 plate 3 · Image generator]`, generated images masked. P-loose. `surfaces/answer`: `[proto §12 plate 2 · A conversation — Brain answers with citations]`. P-loose.
- Own baselines, W: `surfaces/states` (1440 and 390: rejected node, form errors, image error, loading).

(All 1440×900 unless stated, `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

A bot hands over a live report, a validated form and a generated image; every node is registry-checked; data binding runs as the viewer; `Answer` now renders from the same renderer.

---

# Phase 10 · Onboarding, admin and deployment

Goal: a stranger installs manythreads on k3s, signs in, and within thirty minutes sees a cited answer from their own team's material; admins govern models, guardrails and audit. Size L. Spec §16, §10, §10.3, §15, §2, §18 (admin, audit rows); proto §01, §11; `DEPLOY-k3s.md`.

### 0 · Reflect and refactor

Re-read phase 9; list what was awkward, duplicated or slow. Prompts:
- Onboarding reuses sign-in methods, LLM, connections, template and bot pickers. Does each exist as a component that works in a wizard and as a settings page? Split any that is page-only.
- List every setting and where it lives (DB, repo, env). Anything an admin changes at run time belongs in the DB.
- Is there one `seed --phase N` command or ten scripts? Which logs would an operator need at 3 a.m. and lack?

Refactor with tests green; write `docs/retro/phase-10.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P10-01 | Onboarding state (`onboarding_state`), sidebar checklist until done; web wizard for the nine steps 0 sign in, 1 sign-in methods, 2 models, 3 code, 4 infrastructure, 5 teams, 6 bots (Brain always ticked), 7 servers, 8 launch; step 2 test call per alias; step 4 generated k8s manifest and `sshd_config` line with check buttons; step 8 first goal = a question to Brain | `0080_onboarding.sql`, `clients/web/screens/onboarding` | §16 | Sonnet |
| P10-02 | Workspace → LLM complete: providers, aliases and fallbacks, budgets at four levels, rate limits, presets, caching, observability, Subscriptions | `screens/admin/llm` | §10.1 | Sonnet |
| P10-03 | Subscription runtimes behind a workspace flag, off by default; owner accepts terms; label "subscription · bypasses gateway guard"; one person; never routines, heartbeats, inbox or `task_assigned`; spend shown separately | `runtime-hermes`, `gateway-llm` | §10.3 | Sonnet |
| P10-04 | `guardrails-dlp` complete (secrets, keys, personal data, custom regex; allow, redact, require_approval, block; at `pre_egress`, LLM pre-call, MCP gateway) and `guardrails-egress` (per-team allowlist; provider domains on no team list; per-team proxy config) | `plugins/guardrails-*` | §15 | Sonnet |
| P10-05 | `audit`: console and export over the append-only phase 1 event log plus `audit_events`, monthly partitions, who asked, what was reached, **what was withheld**, when; console with filters (content-blind); signed content-blind auditor export; admin console overview | `plugins/audit`; `0081_audit.sql` | §15, §18 | Sonnet |
| P10-06 | `provider.kms` with OpenBao and cloud KMS beside the Postgres default; pen-test checklist `pnpm test:pen -- --release` (auth, sessions, CSRF, cross-team IDOR, path traversal, SSRF, prompt injection at a gate, XSS in surfaces, secret read-back) | `kernel/kms`, `tools/pen` | §15, §18 | Sonnet; Haiku |
| P10-07 | Complete the Helm chart (skeleton from P6-00): five workloads, Ingress, Secrets, PVCs, values; **no CRDs of our own**; CNPG `Cluster` (1 or 3 instances, `pg_trgm`, `vector`, databases `manythreads` and `hindsight`, scheduled backups and WAL archive to object storage, restore recipe); Helm notes document the limits: rate limits are per replica, and UNLOGGED lease tables are empty after failover so leases are re-acquired and jobs must be idempotent | `deploy/helm` | D4 | Sonnet; Haiku |
| P10-08 | Complete the controller (skeleton from P6-00; NetworkPolicy checks start here): per-team Hermes pods, runner placement labels, network policies (Hindsight only from the gateway; Hermes only to gateways and its team proxy), egress proxies, Activepieces on first use; one namespace by default, per-team namespace optional, gVisor where present | `packages/controller` | §2, §7.4 | Sonnet; Haiku |
| P10-09 | Docs and drills: `docs/deploy/k3s.md` (every command tested on fresh k3s in CI), `backup.md` with a restore drill and RPO/RTO, `air-gapped.md` (image mirror, local `embed` and `local` aliases, deny-all egress run) | `docs/deploy`, `tools/` | D4, §2 | Sonnet; Haiku |
| P10-10 | Observability: metrics, structured logs, OpenTelemetry across server, gateways, Hermes; dashboards; alerts (outbox lag, job age, approval age, budget burn, replica lag) | `server`, `deploy/helm/monitoring` | §10.1 | Sonnet |
| P10-11 | Tauri 2 shell for macOS, Windows, Linux (deep links, native notifications, unsigned CI builds); HA chaos check (kill the CNPG primary mid-suite; no write lost; UNLOGGED data may reset) | `clients/desktop`, `tools/chaos` | §2, D4 | Sonnet; Haiku |
| P10-12 | `seed --phase N`, event contracts, plugin author docs, SDK publication prep | `e2e/fixtures`, `docs` | §18 | Sonnet |
| P10-13 | **Compose self-host**: five containers (Postgres, LiteLLM, Hindsight, manythreads, Hermes) as a supported install (spec §2), documented in `docs/deploy/compose.md` and tested in CI from a clean checkout | `deploy/compose`, `docs/deploy` | §2, D4 | Sonnet; Haiku |
| P10-14 | **Abuse review of sensitive endpoints (D5)**: audit every route that grants, recovers or changes a credential or session (sign-in, reset, email verification, bootstrap, invitation accept, OIDC start/callback, change-password, session revoke) for an explicit low per-client-address limit plus the credential lockout; add the limit to any that lack one; publish each limit and window in the Helm notes beside the per-replica caveat; burst each route to prove 429 + `retry-after` | `plugins/identity-*`, `plugins/teams`, `server`, `deploy/helm` | D5, §15 | Sonnet |

### 2 · UI references

- `[proto §01 plate 1 · Step 1 · Sign-in methods]`, `[proto §01 plate 2 · Step 2 · Models]`, `[proto §01 plate 3 · Steps 3 and 4 · Code and infrastructure]`, `[proto §01 plate 4 · Step 5 · Teams]`, `[proto §01 plate 5 · Step 6 · Bots]`, `[proto §01 plate 6 · Step 8 · Launch]`, `[proto §01 plate 7 · After onboarding · Workspace → LLM]`.

The prototype has no plate for step 0 (phase 2 bootstrap) or step 7. Wireframes (class W):

```
Step 7 · Servers                                   Audit console
+----------------+---------------------------+    +---------------------------------------------+
| 0 Sign in   ok | Servers          optional |    | Audit  [Actor v][Bot v][Type v][7 days v]   |
| 1 Methods   ok | Run bots in your cluster, |    | Time  Who      Reached         Withheld   Type|
| 2 Models    ok | or on your machines.      |    | 10:02 Nadia    memory, repo(3) Drive: no  answer|
| 3 Code      -  | curl -fsSL https://…/inst |    | 10:03 Sameera  knowledge(2)    Eng repo   answer|
| 4 Infra     -  |  | sh -s -- --token mj_…  |    | Content is not shown.  [Export for auditor] |
| 5 Teams     ok | [Copy]  Waiting… (o)      |    +---------------------------------------------+
| 6 Bots      ok | [ Skip ]     [ Continue ] |    Guardrails: presets, detector toggles, outcome
| 7 Servers  <   |                           |    per detector, "Paste text to test" box.
| 8 Launch       |                           |    Checklist: "Finish setting up · 3 of 6".
+----------------+---------------------------+
```

Errors: no alias test passed (Continue disabled with reason); k8s check failed with the failing line. Mobile: steps become a top progress bar.

### 3 · Acceptance criteria

1. On fresh k3s with the CNPG operator, default `helm install` starts exactly five workloads and installs no manythreads CRD.
2. A new admin completes steps 0–2 and a team in under 30 minutes (timed run); each team's first goal is a question to Brain whose answer cites the team's own material; with no passing alias test, Continue is disabled with the reason.
3. With the subscription flag off no CLI option works; on, the label shows, the bot is bound to one person and a routine bound to it is refused.
4. DLP `redact` replaces a key pattern, `block` stops it, `require_approval` creates an approval; each is audited.
5. A Hermes pod cannot reach a model provider directly nor Hindsight; the gateway can (k3s test).
6. Nadia's answer withholding Drive shows Drive as withheld in the audit row with no message text; the auditor export verifies, a tampered file fails.
7. Killing the primary of 3 CNPG instances recovers within 60 s with earlier writes present; a restored backup passes the RLS harness with equal counts.
8. `docker compose up` from a clean checkout brings five healthy containers and Brain answers a seeded question (compose self-host, CI). With the air-gapped preset and deny-all egress Brain still answers. The Tauri build opens sign-in and fires a mention notification. Every pen-test item passes or has an accepted exception.
9. Every sensitive endpoint (D5) refuses a burst inside its window with `429 rate_limited` and `retry-after` — sign-in, reset, email verification, bootstrap, invitation accept, OIDC start/callback, change-password — five wrong passwords lock that address for 15 minutes, and each limit and window is documented in the Helm notes as per replica.

### 4 · Automated end-to-end tests

| Spec | Steps → assertions |
|---|---|
| `e2e/onboarding/full-journey.spec.ts` | fresh stack, Omar steps 0–8 with mock OIDC, fake LLM, mock GitHub; first goal to Brain → every step done; cited answer; wall time under 30 min |
| `e2e/onboarding/skip-optional.spec.ts`, `blocked-models.spec.ts` | skip 3, 4, 7; bad key at step 2 → checklist keeps them; Continue disabled, then passes |
| `e2e/admin/llm.spec.ts`, `subscriptions.spec.ts` | alias, fallback, budget; flag off then on → spend, budget block; label, routine refused |
| `e2e/admin/guardrails.spec.ts`, `audit.spec.ts` | fake key through each outcome; Nadia asks, Omar exports → decisions audited; withheld listed; no content |
| `e2e/admin/non-admin.spec.ts`, `e2e/api/security/pen.spec.ts` | Nadia, Priya, Lena try `/admin/*`; pen checklist → 404; all pass |
| `e2e/api/security/abuse.spec.ts` | burst each sensitive route (sign-in, reset, email verification, bootstrap, invitation accept, OIDC start) → 429 `rate_limited` with `retry-after` before the window ends; 5 bad passwords → the address locked for 15 minutes |
| `e2e/deploy/k3s-install.spec.ts`, `netpol.spec.ts`, `backup-restore.spec.ts` (CI, k3d) | install; curl Hindsight from pod and server; backup, destroy, restore → five workloads, no CRDs; pod refused; counts equal |
| `e2e/deploy/compose-install.spec.ts` (CI) | clean checkout, `docker compose up`, ask Brain → five healthy containers; answer |
| `e2e/deploy/ha-failover.spec.ts`, `air-gapped.spec.ts` (nightly), `e2e/desktop/tauri-smoke.spec.ts` | kill primary; deny-all egress; launch shell → under 60 s; answer returned; sign-in and notification |

### 5 · Visual browser tests

- `onboarding/step1`: `[proto §01 plate 1 · Step 1 · Sign-in methods]`; `step2`: plate 2; `step3-4`: plate 3 (P-loose); `step5`: plate 4; `step6`: plate 5; `step8`: plate 6; `admin/llm`: `[proto §01 plate 7 · After onboarding · Workspace → LLM]`. P unless stated.
- Own baselines, W: `onboarding/step7`, `admin/audit`, `admin/guardrails-subscriptions`, `onboarding/mobile` (390×844: steps 1, 2, 5, 8), `onboarding/errors`.

(All 1440×900, `e2e/visual/<area>/<name>.visual.spec.ts`.)

### 6 · Exit

A fresh k3s install brings up exactly five workloads, a new admin finishes onboarding in under 30 minutes and sees a cited Brain answer, the audit console shows what was withheld, and a backup restores into a passing database.

---

# Phase 11 · Mobile client

Goal: iOS and Android apps with the reduced surface (channels, threads, conversations, approvals, notifications) and a WebView for the rest, sharing `packages/shared` with web. Size L. Spec §2, §3, §19 week 1, §18; proto §02 plate 6; D1, D2.

### 0 · Reflect and refactor

Re-read phases 1–10 with a mobile eye; list what was awkward, duplicated or slow. Prompts:
- Which web modules mix browser code (DOM, `window`, CSS) with logic (state, sync, optimistic updates, read-state)? Extract the logic into `packages/client-core`, which imports `shared` and nothing browser-specific. Types stay the shared ones; no second type layer.
- Does the API client assume `fetch` streams or cookies? Put transport behind an interface. Which web screens must work embedded (`?embed=1`, no sidebar)?
- Re-run the phase 1 benchmark with the real message row before building the list.

Refactor with tests green; write `docs/retro/phase-11.md`.

### 1 · Implementation tasks

| ID | Task | Where | Spec | Agent |
|---|---|---|---|---|
| P11-01 | Extract `packages/client-core` (API and WS clients, stores for channels, messages, threads, read-state, notifications, approvals, conversations) from the web client | `packages/client-core` | D1, §2 | Sonnet |
| P11-02 | Server: device-token sessions (rotate, revoke), `push_tokens` table | `server/session`; `0090_mobile.sql` | §4 | Sonnet |
| P11-03 | React Native app (Expo dev client): navigation, shared tokens, secure token storage; sign-in by password and by OIDC in the system browser (PKCE, deep link) | `clients/mobile` | §2, §4 | Sonnet |
| P11-04 | Channels list and channel (virtualised list tuned by the benchmark; composer with camera, library, files); threads inbox and thread screen | `clients/mobile/screens` | §6.1 | Sonnet |
| P11-05 | Conversations with native `Answer` from `AnswerPayload`; approvals inbox and card; native surface components for Answer, ApprovalCard, Stat, Text, List, Button (others open in the WebView) | `clients/mobile/screens`, `surfaces` | §6.2, §7.3, §14 | Sonnet |
| P11-06 | Push (APNs, FCM), in-app list, deep links; WebView host with signed single-use hand-off and `embed=1`; offline cache (last 200 messages per channel), send queue with retry | `clients/mobile`, `plugins/notifications` | §3 | Sonnet |
| P11-07 | Re-run the 5,000-message benchmark on the target mid-range Android (`docs/perf/mobile.md`); Maestro flows and Playwright embed tests; EAS profiles and CI builds (unsigned on PR, signed on release); accessibility (dynamic type, labels, 44 pt targets) | `tools/bench`, `e2e/mobile`, CI | §19, §18 | Sonnet; Haiku |

### 2 · UI references

- `[proto §02 plate 6 · Phone]` for channel list, channel, thread. Brain and approvals on a phone take content from `[proto §12 plate 2 · A conversation — Brain answers with citations]` and `[proto §11 plate 5 · Approvals inbox]`; the layout is the phone's.

Wireframes (390×844, class W):

```
Sign-in               Channels                Thread
+----------------+    +------------------+    +------------------+
|   [M] manythreads   |    | Kahf v    bell  |    | <  Thread     …  |
| [Continue with |    | v Engineering    |    | Nadia 10:02      |
|   Google     ] |    |  # general    2  |    | Merged the fix.  |
| [Continue with |    |  # dev        *  |    | Rafi  10:05      |
|   Microsoft  ] |    | v Bots  Brain    |    | Thanks.          |
| Email    [   ] |    | v Direct messages|    | [ Reply…     ] > |
| Password [   ] |    +------------------+    +------------------+
| [ Sign in ]    |    Tab bar: Channels · Threads · Bots · Approvals · More
+----------------+
```

Approvals: cards, detail with tool, arguments, environment, `[Approve][Decline]`, note. More: Files, Boards, Workshop, Admin open the WebView with a "Back to the app" bar. Offline banner: "You are offline. Messages will send when you are back." Empty approvals: "Nothing is waiting for you." Expired hand-off: "Sign in again to open this."

### 3 · Acceptance criteria

1. The 5,000-message channel scrolls at a sustained 60 fps on the target device (p95 under 17 ms excluding single drops); memory does not grow in a 10-second scroll.
2. `tsc` passes with every API type from `packages/shared`; a lint rule fails any `*Dto` type in `clients/mobile`.
3. OIDC sign-in stores the token in secure storage; revoking the session on the web account page signs the phone out.
4. A mention while closed pushes and a tap opens the message. Rafi approves on the phone; Nadia sees no Approve control.
5. Brain's answer shows numbered citations, Lineage, Sources reached and Outside scope.
6. Files from More opens in the WebView with the right session and no sidebar; the hand-off link fails on a second use.
7. Airplane mode queues a message and sends it once. Lena sees only `#releases`, no More, Bots, Approvals or DMs. Both platform builds are produced on every PR.

### 4 · Automated end-to-end tests

Native flows use Maestro; embedded screens use Playwright `mobile-web`.

| Spec | Steps → assertions |
|---|---|
| `e2e/mobile/signin.yaml`, `oidc.yaml` | Nadia password; OIDC via system browser → lands on Channels; token gone after sign-out; deep link back |
| `e2e/mobile/channel-thread.yaml`, `threads-inbox.yaml` | post, reply on phone; follow, reply from web → appears on web; unread dot, tabs |
| `e2e/mobile/brain.yaml`, `approvals.yaml` | ask Brain; Rafi approves, Nadia has no control → Answer sections; decision on web |
| `e2e/mobile/push.yaml`, `offline.yaml` | mention backgrounded; airplane mode send → push opens message; one message, no duplicate |
| `e2e/mobile/guest-lena.yaml`, `webview-files.yaml` | Lena signs in; More → Files → only `#releases`, no More; loads, Back works, second hand-off fails |
| `e2e/api/mobile/device-session.spec.ts`, `e2e/mobile/embedded-web.spec.ts` (`mobile-web`) | create, rotate, revoke; `?embed=1` Files, Boards, Workshop → revoked token rejected; no sidebar, no horizontal scroll |

### 5 · Visual browser tests

Screenshots from Maestro on a fixed 390×844 emulator profile, and Playwright for embedded pages.

- `mobile/channels` and `mobile/thread`: `[proto §02 plate 6 · Phone]`. P-loose.
- Own baselines, W: `mobile/brain` (content from `[proto §12 plate 2 · A conversation — Brain answers with citations]`), `mobile/approvals`, `mobile/signin-more-offline`, `mobile/embedded` (Files, Boards in embed mode).

### 6 · Exit

The phone app does sign-in, channels, threads, Brain, approvals and push on both platforms in CI, the 5,000-message list holds 60 fps on the target device, and no type in `clients/mobile` is declared outside `packages/shared`.

---

# Phase 12 · Full persona end-to-end automation and user manual

Goal: one Playwright suite, `e2e/personas/`, runs the whole app in a browser against a seeded workspace for **every** persona, walks each journey end to end, and screenshots every meaningful step into `docs/journeys/<persona>/NN-<step>.png`. From that proof, generate `USER_JOURNEYS.md`. Then a fresh Sonnet subagent plays each persona from the screenshots alone; every hesitation is a UX finding fixed before the manual is final. Size L. Needs all product phases; the phone chapter needs phase 11.

### 0 · Reflect and refactor

Re-read the e2e specs of phases 2–10 as one body of work; list the flaky, slow, duplicated specs and the text-based selectors. Prompts:
- Which steps do five specs repeat (sign in, open channel, ask Brain)? Extract page objects into `e2e/pages/` and delete the copies; journeys are built from them.
- Which elements lack a stable `data-testid`? Add it in the product, not the test; a journey that finds a button by its label is a UX finding in waiting.
- Does any spec depend on state left by another? Start every journey from a named seed snapshot (`day-1`, `week-2`) restored in under 10 s. Replace real waits with the fake clock; add a `data-ready` attribute that `shot()` waits for.

Refactor with tests green; write `docs/retro/phase-12.md`.

### 1 · Implementation tasks

| ID | Task | Where | Agent |
|---|---|---|---|
| P12-01 | Harness: `loginAs(persona)`; journey declaration `{ id, persona, goal, steps: [{ id, expect: landmark, next: { testid, label }, plate?, expectDenied?: <status> }] }`; `shot(page, step)` checks the landmark, no error boundary, no console error, no failed request (a step with `expectDenied: 403` relaxes the console and request checks for that step only and asserts that status), waits for `data-ready`, writes `docs/journeys/<persona>/NN-<journeyId>-<slug>.png` (NN = persona-wide running number in declaration order) and appends a manifest entry (persona, journey, step, kind `desktop`, `mobile` or `native`, viewport, url, sha256, bytes, time) | `e2e/personas/harness` | Sonnet |
| P12-02 | Page objects from phases 2–10; seed snapshots `day-1` and `week-2`; Playwright projects `personas-desktop` (1440×900) and `personas-mobile-web` (390×844), one shard per persona, headless, 25-minute budget | `e2e/pages`, `tools/seed`, CI | Sonnet; Haiku |
| P12-03 | The journeys of block B, each with at least 5 screenshots and a final assertion on the **outcome**; negative steps try each "must never" and screenshot the denial | `e2e/personas/<persona>/` | Sonnet (3 in parallel) |
| P12-04 | Proof the suite works (block C below) | `e2e/personas`, CI | Sonnet; Haiku |
| P12-05 | Captions: one sentence per step in `docs/journeys/captions.yaml` (at most 25 words, present tense, plain words), written by Sonnet from step data and screenshot, then checked by a **fresh** Sonnet given only screenshot and caption | `docs/journeys` | Sonnet |
| P12-06 | Generator `scripts/gen-user-journeys.ts` builds `USER_JOURNEYS.md`: a chapter per persona (card, "what you cannot do", journeys as numbered steps, embedded screenshot, caption), contents, commit sha and run date; fails on a missing caption or image | `scripts` | Sonnet |
| P12-07 | **Simulate the persona** loop and `docs/journeys/ux-findings.md` (below) | orchestrated | Sonnet |
| P12-08 | Phone chapter: Maestro screenshots into `docs/journeys/<persona>/native/` for Nadia, Rafi, Priya, Lena (`mobile/` is the 390 px web client; both are declared in the manifest) | `e2e/mobile`, `scripts` | Sonnet; Haiku |

**Block B · Journeys** (B marks a Brain interaction, A an acting-bot interaction; every persona has both)

| Persona | Journeys |
|---|---|
| **Omar** | O1 (B) bootstrap, onboarding steps 0–8, first goal to Brain · O2 create Customer support from the template, invite Sameera, tag `role:support-agent` · O3 add an alias and budget, read Usage · O4 (A) add Content drafter by a brief, rehearse, approve · O5 read the audit row for Nadia's answer, export; opening Nadia's private conversation is denied; reading a stored provider secret shows it masked (`expectDenied`) · O6 (A) review a Coder proposal, open a sandbox terminal, see credentials revoked; a bot writing `bots/` directly is denied · O7 direct messages: Omar reads his own DM and cannot open Nadia and Rafi's DM (admin does not bypass RLS) |
| **Nadia** | N1 morning: Threads inbox, channel, thread panel · N2 (B, A) ask Brain about the cache TTL decision, hand to Coder · N3 (A) work a card through Coder, Reviewer, Tester · N4 (B) co-edit the runbook while Brain writes a section, history, restore · N5 (A) request a production release, watch it wait for Rafi · N6 (B) connect Drive, ask Brain, share to `#releases` masked. Negatives: own request, terminal, Support channels |
| **Rafi** | R1 approve the release, decline another with a note · R2 (A, B) incident in `#incidents`: Alert triage posts, Rafi asks Brain for the runbook · R3 approve from the 390 px client · R4 negatives: own request, Support `email.send`, Coder's guard |
| **Sameera** | S1 (A) customer email, Support responder drafts, Sameera approves the send · S2 (B) ask Brain, open the manual citation · S3 (B) source changes, old answer shows "source changed since", gap goes to `#kb-updates` · S4 (A) Enquiry bot's lead card · S5 negatives: Engineering invisible, Coder, others' conversations |
| **Tariq** | T1 (A) Content drafter writes a post, Tariq co-edits live · T2 (A) ReportBuilder weekly report, pin to `#analytics`, export · T3 (B) ask Brain for brand guidance, Save as page · T4 weekly social routine and its page · T5 ImageGenerator. Negatives: Support mail, production deploy; Brain asked to read another person's Drive refuses and lists it under Outside scope |
| **Priya** | P1 first day: welcome card (P3-14) and checklist, two teams, team switcher · P2 (B, A) ask Brain how to ship a release, read Coder's release post, follow the thread · P3 edit controls absent, reply works, repeat at 390 px · P4 Threads inbox and notifications. Negatives: approve, change `bots/` through the UI, open a terminal, see a private channel |
| **Lena** | L1 accept the guest invite, see only `#releases` · L2 (A, B) read Coder's release post and Nadia's shared Brain answer with the masked citation; search finds only `#releases` · L3 negatives: `#dev` URL no access, Members, `/files`, Boards, Approvals, DMs, `/bots` and `/admin` absent or 404, no Brain and no bot mention, posting impossible (no composer), repeat at 390 px |

**Block C · How the suite is proven to work**

1. **Completeness spec** (`completeness.spec.ts`, runs last): it compares the declared step list and every journey's status with the manifest and files: every declared step has a PNG, no extra PNG, each non-empty and not blank (over 200 distinct colours), every journey passed. Hashes are informational only and never fail the run. **Any missing screenshot fails the run**, naming the step.
2. **Canary:** a dev-only flag `MANYTHREADS_CANARY=hide-composer` hides the composer; the canary CI job runs the suite and **must fail** on exactly the composer steps. A second canary deletes one PNG and expects the completeness spec to fail. If either passes, CI fails.
3. **Determinism job:** run twice; manifests list the same steps; each screenshot pair differs by at most 0.5% of pixels.
4. **Run log:** `docs/journeys/run-log.json`, **committed** by the release workflow only (git sha, date, Node, Playwright and browser versions, per-journey status and duration, per-step sha256 for information, totals). PRs regenerate the screenshots in CI and do not commit them.
5. **CI:** headless on every PR touching `clients/` or `e2e/`; full suite nightly and on release; traces uploaded on failure.

**Simulate the persona (P12-07).** One fresh Sonnet subagent per persona, at most 3 at once. Input: the persona description (name, role, goals) and the journey's goal sentence. Nothing else: no spec, no code, no captions.
1. Show screenshot 1 only. Ask: "In two sentences, what would you do next? Name the exact thing you click or type. Say what, if anything, is unclear."
2. Reveal the next screenshot; repeat to the end. Later screens are never shown early.
3. A step is a **finding** when the subagent names a different control than the declared `next`, says it is unsure or hesitates between options, misreads the screen (states something false), or cannot find the control the next step uses.
4. Log each finding (id, persona, journey, step, what was said, what was expected, category: label, layout, state, missing affordance, copy). Fix the product, regenerate the affected journeys, simulate those again. At most three rounds per finding, then Omar decides.
5. The manual is final only when a full run has **zero findings** (or only ones Omar accepted in writing). The orchestrator reads summaries, not transcripts.

### 2 · UI references

No product screen is built. Artefacts (class W; checked by generator tests):

```
# Nadia — engineer and release owner            Declaration example
Goals: …    You cannot: approve your own …      { id: "N2", persona: "nadia",
## N2 · Ask Brain about a past decision,           goal: "Find what we decided about
##      then hand it to Coder                       the cache TTL and give it to Coder",
1. You open Brain from the sidebar.                steps: [
   ![](docs/journeys/nadia/09-N2-open-brain.png)     { id: "open-brain", expect:
2. You type your question and press Enter.            "conversation-empty",
   ![](docs/journeys/nadia/10-N2-ask.png)             next: { testid: "msg-input" } },
3. Brain answers with numbered sources.              { id: "answer", plate: "§12/2",
   ![](docs/journeys/nadia/11-N2-answer.png)          next: { testid: "chip-hand-to-coder" } } ] }
```

390 px web shots go to `docs/journeys/<persona>/mobile/NN-<journeyId>-<slug>.png`; Maestro shots to `docs/journeys/<persona>/native/NN-<journeyId>-<slug>.png`.

### 3 · Acceptance criteria

1. Every journey above passes for all seven personas headless in CI; total CI time with 7 shards is at most 25 minutes.
2. A missing declared PNG fails the run and names the step; the canary job fails the suite as expected and passes only for that reason.
3. Two runs list the same steps and differ by at most 0.5% per screenshot; `run-log.json` is committed with the git sha and step hashes.
4. Every "must never" in section 4 has a negative step showing the denial; every persona has at least one B and one A journey (a script checks the markers).
5. `USER_JOURNEYS.md` has a chapter per persona, numbered steps, an existing screenshot and a caption of at most 25 words for each step.
6. The final persona simulation records zero findings (or only ones Omar accepted); the log shows each closed with its fix.

### 4 · Automated end-to-end tests

| Spec | Covers → key assertions |
|---|---|
| `e2e/personas/omar/O1-onboarding.spec.ts` … `O7-direct-messages.spec.ts` | O1–O7 → first Brain answer cited; team exists; budget blocks; bot in roster; audit row has "withheld"; credentials revoked before first keystroke; secret masked; Nadia and Rafi's DM unreadable |
| `e2e/personas/nadia/N1-morning.spec.ts` … `N6-drive-share.spec.ts` | N1–N6 and negatives → handover cards; page with three co-authors; approval decided by Rafi; masked citation |
| `e2e/personas/rafi/R1-approvals.spec.ts` … `R4-negatives.spec.ts` | R1–R4 → decisions recorded; own request not approvable; Support approvals not offered |
| `e2e/personas/sameera/S1-support-send.spec.ts` … `S5-negatives.spec.ts` | S1–S5 → mail sent only after approval; "source changed since"; `#kb-updates` message |
| `e2e/personas/tariq/T1-post-coedit.spec.ts` … `T5-image.spec.ts` | T1–T5 → page and history; pinned report; saved answer; routine page; image is an attachment |
| `e2e/personas/priya/P1-first-day.spec.ts` … `P4-inbox.spec.ts` | P1–P4 → all write controls absent; reply works; no horizontal scroll at 390 px |
| `e2e/personas/lena/L1-guest.spec.ts` … `L3-negatives.spec.ts` | L1–L3 → one channel; masked citation visible; 404 and no-access |
| `e2e/personas/completeness.spec.ts`, `journeys.meta.spec.ts`, `scripts/gen-user-journeys.test.ts` | all → completeness per block C; each persona has B and A, ids unique; generator fails on missing caption or image |

### 5 · Visual browser tests

Every journey screenshot is also a visual test.

- `visual/personas/steps.visual.spec.ts` (generated from the declarations), 1440×900: a step with `plate` is compared with that prototype plate (N2 "answer" with `[proto §12 plate 2 · A conversation — Brain answers with citations]`), class P-loose; every other step with its committed baseline, at most 0.5% differing.
- `visual/personas/mobile-steps.visual.spec.ts`, 390×844: baselines, at most 0.5%; the channel step also against `[proto §02 plate 6 · Phone]`, P-loose.
- `visual/personas/negatives.visual.spec.ts`, 1440×900 and 390×844: denial states (404, no access, absent controls), at most 0.5%.

### 6 · Exit

Every persona's journeys pass headless in CI twice with matching manifests, the canary fails as it must, the run log is committed, `USER_JOURNEYS.md` is generated from the screenshots, and the persona simulation finds nothing left to fix.

---

# Phase 13 · Screenshot UI review

Goal: a systematic review of every phase 12 screenshot, desktop and mobile web, for defects functional tests cannot see; fix in severity order; repeat until no issue of severity medium or above remains. Size M. Needs phase 12 green. Inputs: `docs/journeys/**/*.png`, the manifest, the tokens (section 5), the prototype.

### 0 · Reflect and refactor

Re-read phase 12's harness, journeys and findings log; list what made screenshots hard to review. Prompts:
- Any skeleton or half-rendered shots? Fix the `data-ready` wait, not the review.
- Which screens does no journey reach (error, empty, settings, denied)? Add a **states sweep** per persona. List components built twice (button, chip, card header): the review's prime suspects.
- Run the raw-hex lint and a new spacing lint (off the 4 px scale); list the hits. Add Tab-walk steps for focus rings.

Refactor with tests green; write `docs/retro/phase-13.md`.

### 1 · Implementation tasks

| ID | Task | Where | Agent |
|---|---|---|---|
| P13-01 | States sweep journeys (empty, error, loading, denied) and Tab-walk steps (first 15 stops of each main screen) per persona | `e2e/personas/*/states` | Sonnet |
| P13-02 | Pre-checks on every screenshot run: image valid and not blank; axe-core on the live page at the same step (contrast, labels); computed-style probe against the tokens | `tools/review/precheck.ts` | Sonnet; Haiku |
| P13-03 | **Haiku subagent** generates contact sheets (ImageMagick montage, 12 thumbnails with file names) per persona per viewport, and per-batch folders of at most 12 full-size images | `tools/review/contact-sheet.sh` | Haiku |
| P13-04 | Fixed checklist `tools/review/CHECKLIST.md` (below), versioned; reviewers get it verbatim | `tools/review` | Orch |
| P13-05 | **Sonnet reviewers, at most 12 screenshots each, at most 3 in parallel**; each gets the checklist, token list, contact sheet and its batch, and "report only what you can point to in the image"; returns rows in the `ISSUES.md` format and one count line | orchestrated | Sonnet |
| P13-06 | Merge and de-duplicate by a Sonnet subagent: one component seen on many screens is one issue listing every screenshot; severity by the rubric | `ISSUES.md` | Sonnet |
| P13-07 | Review-quality proof: **canary pass** with 12 injected defects (flag `MANYTHREADS_REVIEW_CANARY`, one per category below); reviewers must find at least 10 of 12 before any review is trusted | `tools/review/canary` | Sonnet; Haiku |
| P13-08 | Fix loop in severity order (Sonnet writes, fresh Sonnet reviews the diff); a shared component is fixed once; regenerate affected journeys, visual specs and pre-checks; re-review changed shots plus a 10% random sample of unchanged ones | product code, CI | Sonnet; Haiku |
| P13-09 | Repeat P13-05 to P13-08 with fresh reviewers until a full pass yields **no issue of medium or above**; low issues are listed, not blocking | `ISSUES.md` | orchestrated |
| P13-10 | Keep the pre-checks, spacing lint, contrast check and Tab-walk in CI; update baselines in one reviewed PR; refresh `USER_JOURNEYS.md` and re-simulate journeys whose screens changed | CI, `docs/journeys` | Haiku; Sonnet |
| P13-11 | Build the `/dev/components` gallery (Button, Chip, Card, Table row, Empty state, Approval card, Answer card in every state) and the spacing lint (values off the 4 px scale fail the build) before the first review round | `clients/web/dev`, `eslint` | Sonnet |

**The fixed checklist.**

| Id | Category | Look for |
|---|---|---|
| C01 | Broken images | Missing image, broken glyph, empty avatar frame, wrong aspect ratio |
| C02 | Spacing | Uneven padding or margin between like elements; gaps off the 4 px scale |
| C03 | Consistency | The same component styled differently on different screens |
| C04 | Tokens and branding | Colours, fonts or radii outside the tokens; agent colour used for a human or the reverse |
| C05 | Overflow | Content spilling out of its container; horizontal page scroll |
| C06 | Alignment | Text, icons, controls off baseline or edge; mixed left and centre in one block |
| C07 | Mobile | At 390×844: cut off, overlapping, tap target under 44 px |
| C08 | Clipping | A `box-shadow` or focus ring clipped by `overflow: hidden`; a dropdown cut by its parent |
| C09 | Truncation | A label cut so meaning is lost, with no tooltip or full-text path |
| C10 | Contrast | Below WCAG AA (4.5:1 text, 3:1 large text and UI) |
| C11 | Focus | No visible focus state, or a ring hidden by another element |
| C12 | Empty states | Layout, tone or action differs from the pattern used elsewhere |

**Severity.** **High:** blocks or misleads use (unreadable text, hidden or overlapped control, unusable mobile, contrast far below AA). **Medium:** visibly wrong or inconsistent in a main flow, contrast just below AA, missing focus state. **Low:** cosmetic, rare screens, a few pixels off scale.

**`ISSUES.md` row format.** One table row per issue; the file starts with `Open: H n · M n · L n`.

| id | screenshot path | persona / journey / step | category | severity | description | suggested fix | status |
|---|---|---|---|---|---|---|---|
| `UI-0007` | `docs/journeys/nadia/11-N2-answer.png`, `…/mobile/11-N2-answer.png` | nadia / N2 / answer | C03 | medium | "Hand to a bot" chips use a 6 px radius; the same chips on the Approvals card use 12 px | Use the shared `Chip` with the `chip` radius token | open · fixed in `a1b2c3d` · verified |

Rules: `id` is `UI-NNNN`, never reused; `category` is a checklist id; an issue may list several screenshots; `status` moves open → fixed (with commit) → verified (after regeneration and re-review); closed rows move to a "Closed" section.

**Canary set.** C01 broken avatar · C02 doubled card padding · C03 button with another radius · C04 off-token hex · C05 long word overflowing a card · C06 label shifted 6 px · C07 28 px tap target · C08 clipped box-shadow · C09 truncated approval title · C10 grey `#9AA0A6` on white · C11 focus ring removed on one input · C12 an empty state with another layout.

### 2 · UI references

No product screen. Review artefacts (class W; checked by generator tests):

```
Contact sheet (12 cells)                      Batch folder
+----------+----------+----------+----------+   review/round-N/<persona>/<viewport>/batch-NN/
| 01-O1-…  | 02-O1-…  | 03-O1-…  | 04-O1-…  |     contact-sheet.png
| (thumb)  | (thumb)  | (thumb)  | (thumb)  |     12 full-size images at most
+----------+----------+----------+----------+     CHECKLIST.md   tokens.txt
| 05 … 08                                    |   Reviewer returns only table rows, then
| 09 … 12                                    |   "Reviewed N screenshots; M rows".
+----------+----------+----------+----------+
persona: omar · 1440×900 · sheet 1 of 5
```

When judging layout, use the prototype plate named by the step's `plate` field, if any.

### 3 · Acceptance criteria

1. Every PNG is in exactly one review batch of at most 12, both viewports (a script checks the batch map against the manifest).
2. The canary pass finds at least 10 of 12 injected defects with the right category.
3. Every `ISSUES.md` row has all eight fields, a valid category, a rubric severity and an existing screenshot path.
4. A shared-component fix is one commit and every listed screenshot is regenerated.
5. The final round shows `Open: H 0 · M 0`; fresh reviewers find none of medium or above.
6. axe-core shows zero AA contrast violations; the Tab-walk shows an unclipped focus ring on the first 15 stops of every main screen; mobile shots have no horizontal scroll and no tap target under 44 px; both lints pass.

### 4 · Automated end-to-end tests

| Spec | Covers → assertions |
|---|---|
| `e2e/review/precheck.spec.ts` | every step → valid image; axe contrast zero; computed styles use tokens |
| `e2e/review/focus-walk.spec.ts` | Tab-walk, all personas → ring contrast at least 3:1, bounding box not clipped |
| `e2e/review/mobile-overflow.spec.ts` (`mobile-web`) | every mobile step → `scrollWidth <= innerWidth`; interactive elements at least 44×44 |
| `e2e/review/truncation.spec.ts`, `empty-state-pattern.spec.ts` | truncated labels; all empty states → tooltip or accessible text; one structure: icon or none, one sentence, one action |
| `tools/review/batch-map.test.ts`, `issues-format.test.ts`, `canary.test.ts` | batches; `ISSUES.md`; flag → one batch per screenshot; row schema, unique ids, paths exist; 12 defects only with the flag |

### 5 · Visual browser tests

- `visual/review/fixed-screens.visual.spec.ts`, 1440×900 and 390×844: baselines refreshed after the fixes in one reviewed PR, at most 0.2% differing.
- `visual/review/components.visual.spec.ts`, 1440×900: component gallery `/dev/components` (Button, Chip, Card, Table row, Empty state, Approval card, Answer card in every state) against its baseline; shared parts also against `[proto §05 plate 1 · Coder — Capabilities tab]` (chips, rows) and `[proto §12 plate 2 · A conversation — Brain answers with citations]` (Answer card), P-loose.
- `visual/review/regression.visual.spec.ts`, both viewports: the whole journey set against the final baselines, at most 0.5%.

### 6 · Exit

A full review of every desktop and mobile-web screenshot by fresh reviewers who pass the canary test leaves no issue of medium severity or above in `ISSUES.md`, and the pre-checks that found them run on every PR.

---

# Appendix A · Database starting schema

Starting point for phases 1–6 plus outbox, jobs and analytics. Phases refine it by forward-only migrations. Postgres 19, decision D3.

## A.0 · Conventions

- Every table: `id uuid PRIMARY KEY DEFAULT uuidv7()`, `created_at timestamptz DEFAULT now()`, unless a composite key is shown. Text is `text`. Enums are `text` + `CHECK`. In the tables `u` = uuid, `t` = text, `tz` = timestamptz, `i` = int, `b` = bool; **J** marks `jsonb`, used only for open data.
- Every foreign key has an index. Composite indexes: equality column first, range or sort last. Hot filters are partial indexes. List queries use `INCLUDE`.
- Team- and person-scoped tables carry `workspace_id` and `team_id`, `person_id` or `channel_id`, so a policy needs no join where possible.
- Roles: `manythreads_owner` owns tables and runs migrations; `manythreads_app` runs the server, `NOBYPASSRLS`. Every table has `ENABLE` and `FORCE ROW LEVEL SECURITY`. `withActor` sets `app.actor_id`, `app.workspace_id`, `app.run_id` with `SET LOCAL`. Helpers in schema `app` (`STABLE`, `SECURITY DEFINER`, pinned `search_path`): `app.actor()`, `app.is_workspace_admin()`, `app.is_team_member(team_id)`, `app.team_role(team_id)`, `app.can(resource_type, resource_id, permission)`.
- RLS codes: **T** visible if `app.is_team_member(team_id)`, writes by team role · **C** visible if `app.can('channel', channel_id, 'read')` (member, team member of a public channel, or ACL grant such as a guest's), writes need `post` · **P** own rows only · **W** workspace admin only · **WR** members read, admin writes · **S** system actor only · **G** global, on the harness allowlist `global_tables`, with a migration comment.
- Persistence: **L** logged; **U** UNLOGGED (empty after a crash or failover, rebuilt); **Part** partitioned.

## A.1 · Phase 1 — kernel

| Table | Purpose | Key columns | Indexes | RLS | Persist |
|---|---|---|---|---|---|
| `schema_migrations` | applied files | `id t PK`, `checksum t`, `applied_at tz` | PK | G | L |
| `actors` | person, bot or system identity | `kind t` (`person`,`bot`,`system`), `workspace_id u`, `ref_id u` | UNIQUE `(workspace_id, kind, ref_id)` | S; `app.actor()` | L |
| `events` | append-only event log (and the audit log until phase 10; `REVOKE UPDATE, DELETE ON events FROM manythreads_app`) | `occurred_at tz`, `workspace_id u`, `team_id u?`, `actor_id u`, `type t`, `schema_version i`, `payload` **J** | BRIN `(occurred_at)`; `(workspace_id, type, id DESC)`; partial `(team_id, id DESC)` | T (team rows); workspace rows by membership | L |
| `outbox` | deliveries per subscriber | `event_id u`, `subscriber t`, `available_at tz`, `attempts i`, `done_at tz?` | partial `(subscriber, available_at) WHERE done_at IS NULL`; `(event_id)` | S | L |
| `jobs` | durable queue | `queue t`, `payload` **J**, `run_at tz`, `state t` (`ready`,`running`,`done`,`failed`,`dead`), `attempts i`, `dedupe_key t?` | partial `(queue, run_at) WHERE state='ready'`; partial UNIQUE `(queue, dedupe_key) WHERE state IN ('ready','running')` | S | L |
| `job_leases` | who holds a job | `job_id u PK`, `worker_id t`, `expires_at tz` | PK; `(expires_at)` | S | **U** |
| `scoped_kv` | plugin scoped storage | `plugin t`, `scope_type t`, `scope_id u`, `key t`, `value` **J** | PK `(plugin, scope_type, scope_id, key)` | by scope: T, P or WR | L |
| `entity_links` | links between entities | `team_id u`, `src_type t`, `src_id u`, `dst_type t`, `dst_id u`, `kind t` | UNIQUE on all five; `(dst_type, dst_id)` | T | L |
| `plugins` | loaded versions | `name t PK`, `version t`, `enabled b`, `manifest` **J** | PK | G | L |
| `capability_grants` | broker allowlists from `BOT.md` | `team_id u`, `actor_id u`, `capability t`, `needs_approval b`, `constraints` **J** | UNIQUE `(actor_id, capability)`; `(team_id)` | T read; S write | L |

## A.2 · Phase 2 — identity, workspace, teams

| Table | Purpose | Key columns | Indexes | RLS | Persist |
|---|---|---|---|---|---|
| `workspaces` | tenant | `slug t`, `name t`, `self_signup b`, `settings` **J** | UNIQUE `(slug)` | WR | L |
| `people` | a person | `workspace_id u`, `display_name t`, `primary_email t`, `status t` (`active`,`suspended`) | UNIQUE `(workspace_id, lower(primary_email))` | WR; P own details | L |
| `person_emails` | extra emails | `person_id u`, `email t`, `verified_at tz?` | UNIQUE `(lower(email))` | P; W | L |
| `workspace_members` | workspace role | `person_id u`, `role t` (`owner`,`admin`,`member`,`guest`) | PK `(workspace_id, person_id)` | WR | L |
| `auth_providers` | sign-in methods | `kind t`, `config` **J** (no secrets), `secret_id u?`, `enabled b`, `allowed_domains t[]` | `(workspace_id, kind)` | W | L |
| `secrets` | envelope-encrypted blobs | `ciphertext bytea`, `wrapped_key bytea`, `key_id t` | PK | S | L |
| `identities` | provider subject to person | `person_id u`, `provider_id u`, `subject t` | UNIQUE `(provider_id, subject)`; `(person_id)` | P; W | L |
| `password_credentials` | argon2id hash | `person_id u PK`, `hash t`, `must_change b` | PK | S | L |
| `sessions` | durable sessions | `person_id u`, `last_seen_at tz`, `expires_at tz`, `device t`, `revoked_at tz?` | partial `(person_id) WHERE revoked_at IS NULL`; BRIN `(created_at)` | P; W | L |
| `session_cache` | hot lookups | `token_hash bytea PK`, `session_id u`, `expires_at tz` | PK | S | **U** |
| `invitations` | invites | `team_id u?`, `email t`, `role t`, `grant` **J**, `token_hash bytea`, `accepted_at tz?` | partial `(token_hash) WHERE accepted_at IS NULL` | W; team leads | L |
| `email_verifications` | verify and reset links | `person_id u`, `token_hash bytea`, `expires_at tz` | `(token_hash)` | S | L |
| `teams` | a team | `workspace_id u`, `slug t`, `name t`, `template t?`, `archived_at tz?` | UNIQUE `(workspace_id, slug)` | T; admin all | L |
| `team_members` | roster (people and bots) | `team_id u`, `actor_id u`, `role t` (`lead`,`member`) | PK `(team_id, actor_id)`; `(actor_id)` | T | L |
| `roles`, `role_members` | role tags mirrored from `TEAM.md` (`on-call`) | `name t`; `(role_id u, person_id u)` | UNIQUE `(workspace_id, name)`; PK; `(person_id)` | WR | L |
| `acl_entries` | grants outside teams | `resource_type t`, `resource_id u`, `subject_type t` (`person`,`team`,`role`), `subject_id u`, `permission t` (`read`,`post`,`manage`) | UNIQUE on all five; `(subject_type, subject_id)` | W; subject reads own | L |
| `team_pending_files` | `TEAM.md` awaiting the repo | `team_id u PK`, `files` **J**, `applied_at tz?` | PK | S | L |

## A.3 · Phase 3 — channels, messages, threads

| Table | Purpose | Key columns | Indexes | RLS | Persist |
|---|---|---|---|---|---|
| `channel_groups` | sidebar groups | `team_id u`, `name t`, `position i` | `(team_id, position)` | T | L |
| `channels` | channels, DMs, bot conversation channels | `team_id u?`, `group_id u?`, `name t`, `kind t` (`channel`,`dm`,`bot_conversation`), `private b`, `dm_key t?`, `bot_id u?` | UNIQUE `(team_id, name) WHERE kind='channel'`; UNIQUE `(workspace_id, dm_key) WHERE kind='dm'`; `(group_id)` | C | L |
| `channel_members` | membership | `channel_id u`, `person_id u`, `muted b` | PK `(channel_id, person_id)`; `(person_id)` | C; P | L |
| `messages` | messages | `channel_id u`, `author_id u`, `body t` (markdown), `body_plain t`, `thread_root_id u?`, `edited_at tz?`, `deleted_at tz?`, `meta` **J** | `(channel_id, id DESC) INCLUDE (author_id, thread_root_id)`; partial `(thread_root_id, id)`; GIN trigram `(body_plain)`; `(author_id)` | C | L (partition by month if the phase 1 benchmark says so) |
| `message_reactions`, `message_mentions` | emoji; parsed mentions | `(message_id u, actor_id u, emoji t)`; `(message_id u, mentioned_id u, kind t)` | PKs; `(mentioned_id, message_id DESC)` | C | L |
| `threads` | one per root message | `root_message_id u PK`, `channel_id u`, `title t`, `reply_count i`, `last_reply_at tz` | `(channel_id, last_reply_at DESC)`; GIN trigram `(title)` | C | L |
| `thread_follows` | followed threads | `person_id u`, `thread_root_id u` | PK both | P | L |
| `read_state` | unread per person | `person_id u`, `target_type t`, `target_id u`, `last_read_id u`, `unread_count i`, `followed b` | PK `(person_id, target_type, target_id)`; partial `(person_id, target_id) WHERE unread_count > 0` | P | L |
| `notifications`, `notification_prefs` | inbox; settings | `person_id u`, `kind t`, `ref_type t`, `ref_id u`, `read_at tz?`; `prefs` **J** | partial `(person_id, id DESC) WHERE read_at IS NULL`; BRIN `(created_at)` | P | L |
| `files` | attachments in Files storage | `team_id u?`, `channel_id u?`, `folder_path t`, `name t`, `blob_key t`, `size bigint`, `mime t`, `uploader_id u` | `(channel_id, folder_path, name)`; GIN trigram `(name)` | C (channel files); T | L |
| `presence`, `typing` | online; typing | `(person_id u PK, status t, seen_at tz)`; `(channel_id u, person_id u, expires_at tz)` | PKs | WR; C | **U** |

## A.4 · Phase 4 — repo

| Table | Purpose | Key columns | Indexes | RLS | Persist |
|---|---|---|---|---|---|
| `repos` | one per team | `team_id u PK`, `path t`, `head_sha t`, `remote` **J**? | PK | T | L |
| `repo_entries` | index of the current tree | `team_id u`, `path t`, `kind t`, `blob_sha t`, `size i`, `last_commit_sha t`, `text_plain t?` | PK `(team_id, path)`; GIN trigram `(path)`, `(text_plain)` | T | L |
| `repo_commits` | History index | `team_id u`, `sha t`, `author_id u`, `co_authors u[]`, `message t`, `committed_at tz`, `paths t[]` | PK `(team_id, sha)`; `(team_id, committed_at DESC)`; BRIN `(committed_at)`; GIN `(paths)` | T | L |

## A.5 · Phase 5 — bots, gateways, memory, approvals

| Table | Purpose | Key columns | Indexes | RLS | Persist |
|---|---|---|---|---|---|
| `bots` | rebuilt from `BOT.md` | `team_id u`, `slug t`, `kind t`, `runtime t`, `visibility t`, `definition_sha t`, `status t`, `placement` **J** | UNIQUE `(team_id, slug)` | T; `workspace` visibility readable by members | L |
| `bot_pairing_tokens` | bot credential (hash) | `bot_id u`, `token_hash bytea`, `revoked_at tz?` | partial UNIQUE `(token_hash) WHERE revoked_at IS NULL` | S | L |
| `bot_runs` | one run | `bot_id u`, `team_id u`, `trigger_type t`, `asker_id u?`, `thread_id u?`, `ended_at tz?`, `status t` | `(bot_id, id DESC)`; partial `(bot_id) WHERE ended_at IS NULL` | T; asker own | L |
| `run_source_log` | what a run read | `run_id u`, `seq i`, `source_type t`, `source_ref t`, `scope t` (`team`,`channel`,`person`) | PK `(run_id, seq)` | T | L; Part by month when large |
| `llm_keys`, `llm_budgets` | virtual keys; budgets | `bot_id u`, `secret_id u`; `level t`, `ref_id u`, `period t`, `limit_micro bigint` | PK; UNIQUE `(level, ref_id, period)` | S; W (T read) | L |
| `llm_spend` | spend records (feeds analytics) | `bot_id u`, `run_id u`, `alias t`, `model t`, `tokens_in i`, `tokens_out i`, `cost_micro bigint` | BRIN `(created_at)`; `(bot_id, created_at)` | T | L; **Part** by month |
| `approvals`, `approval_decisions` | one mechanism, many sources; decisions | `team_id u`, `source t` (`environment`,`dispatch`,`dlp`,`grant`), `requester_id u`, `bot_id u`, `tool t`, `args_preview` **J**, `status t`, `approver_scope` **J**; `(approval_id, decider_id, decision t, note t)` | partial `(team_id, id DESC) WHERE status='pending'`; `(requester_id)` | T; decide needs the tag and `requester <> actor` | L |
| `conversations`, `answers` | conversation index; `AnswerPayload` | `thread_root_id u PK`, `bot_id u`, `person_id u`, `shared_to u?`; `message_id u PK`, `payload` **J** | `(bot_id, person_id, id DESC)`; PK | P (shared rows follow the channel); C | L |
| `memory_retain_log` | what was retained where | `run_id u`, `store t` (`team_bank`,`person_file`), `ref t`, `source_scopes t[]` | `(run_id)`; BRIN `(created_at)` | T | L |

## A.6 · Phase 6 — tasks, rhythms, pages, runners

| Table | Purpose | Key columns | Indexes | RLS | Persist |
|---|---|---|---|---|---|
| `goals`, `tasks` | goals; task substrate | `team_id u`, `title t`, `status t`; `goal_id u?`, `state t` (`open`,`in_progress`,`verify`,`waiting_on_person`,`done`), `owner_id u?`, `branch_id u`, `base_sha t`, `tested_sha t`, `thread_root_id u`, `environment_id u?` | `(team_id, status)`; partial `(team_id, state) WHERE state <> 'done'`; `(owner_id) WHERE state IN ('open','in_progress')`; `(branch_id)` | T | L |
| `task_claims` | ownership | `task_id u`, `branch_id u`, `actor_id u`, `released_at tz?`, `expires_at tz` | **partial UNIQUE `(branch_id) WHERE released_at IS NULL`** | T | L |
| `task_events`, `handoffs` | history; handover records | `task_id u`, `actor_id u`, `type t`, `data` **J**; `task_id u`, `from_actor u`, `to_actor u`, `note t`, `mode t` | `(task_id, id)`; BRIN `(created_at)`; `(to_actor)` | T | L |
| `environments` | production, staging | `team_id u`, `name t`, `protected b`, `windows` **J**, `deploy_cap i`, `auto_rollback b`, `credential_ref t` | UNIQUE `(team_id, name)` | T read; leads write | L |
| `boards` | saved views | `team_id u`, `name t`, `columns` **J**, `filter` **J** | `(team_id)` | T | L |
| `rhythms`, `rhythm_runs` | schedules; their runs | `team_id u`, `bot_id u`, `kind t` (`heartbeat`,`routine`,`task`), `schedule t`, `model_alias t`, `enabled b`, `next_run_at tz`; `rhythm_id u`, `run_id u`, `status t`, `output_path t` | partial `(next_run_at) WHERE enabled`; `(rhythm_id, id DESC)`; BRIN | T | L |
| `page_docs`, `page_updates` | Yjs snapshot; append-only updates | `(team_id u, path t)` PK, `snapshot bytea`, `last_commit_sha t`; `team_id u`, `path t`, `actor_id u`, `update bytea` | PK; `(team_id, path, id)`; BRIN `(created_at)` | T | L |
| `page_awareness` | live cursors | `team_id u`, `path t`, `actor_id u`, `state` **J**, `expires_at tz` | PK `(team_id, path, actor_id)` | T | **U** |
| `runners` | connected runners | `team_id u`, `name t`, `capabilities t[]`, `last_seen_at tz` | `(team_id)`; GIN `(capabilities)` | T | L |

## A.7 · Analytics time-series table (phase 8)

```sql
CREATE TABLE analytics_events (
  id uuid NOT NULL DEFAULT uuidv7(), occurred_at timestamptz NOT NULL,
  workspace_id uuid NOT NULL, team_id uuid, actor_id uuid, bot_id uuid,
  metric text NOT NULL,                 -- 'llm.cost_micro', 'run.count', 'answer.scoped' ...
  value double precision NOT NULL, dims jsonb NOT NULL DEFAULT '{}',   -- open: alias, tool, outcome
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE analytics_events_2026_10 PARTITION OF analytics_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE INDEX ON analytics_events USING brin (occurred_at);
CREATE INDEX ON analytics_events (workspace_id, metric, occurred_at);
CREATE INDEX ON analytics_events USING gin (dims jsonb_path_ops);
CREATE TABLE analytics_daily (day date, workspace_id uuid, team_id uuid, bot_id uuid,
  metric text, total double precision, n bigint, PRIMARY KEY (day, workspace_id, metric, team_id, bot_id));
```

RLS **T** on `team_id`; workspace-level rows for admins. Jobs: `analytics.partitions` creates partitions two months ahead; `analytics.rollup` (hourly) rolls two days into `analytics_daily` with `ON CONFLICT … DO UPDATE`; `analytics.retain` detaches old partitions. Usage pages read `analytics_daily` for ranges over a week and `analytics_events` for the last day.

## A.8 · Outbox and job claiming

Tables are in A.1. Claiming with `SKIP LOCKED`:

```sql
WITH next AS (SELECT id FROM outbox
  WHERE subscriber = $1 AND done_at IS NULL AND available_at <= now()
  ORDER BY available_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
UPDATE outbox o SET attempts = attempts + 1 FROM next WHERE o.id = next.id RETURNING o.*;

WITH next AS (SELECT id FROM jobs WHERE queue = $1 AND state = 'ready' AND run_at <= now()
  ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED),
upd AS (UPDATE jobs j SET state = 'running', attempts = attempts + 1
  FROM next WHERE j.id = next.id RETURNING j.id)
INSERT INTO job_leases (job_id, worker_id, expires_at)
SELECT id, $2, now() + interval '60 seconds' FROM upd RETURNING job_id;
```

Wake-ups: after commit the writer runs `NOTIFY manythreads_outbox, '<subscriber>'` and `NOTIFY manythreads_jobs, '<queue>'`; workers `LISTEN` and poll every 5 s as a net. A reaper returns `running` jobs with a missing or expired lease to `ready`. Every job must be idempotent, because the UNLOGGED lease table is empty after a crash.

## A.9 · Get-or-create in one statement

`ON CONFLICT … DO SELECT` — verify on the CNPG Postgres 19 image in P1-12; the fallback is `DO UPDATE … RETURNING`. It returns the existing row without writing. Use it for DMs, template-created channels, bank creation, any "make sure it exists". Use `DO UPDATE` only for a real update.

```sql
-- the DM channel for a set of people (dm_key = sorted person ids joined)
INSERT INTO channels (workspace_id, name, kind, private, dm_key)
VALUES ($1, $2, 'dm', true, $3)
ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm'
DO SELECT
RETURNING id, name;
```

The older `DO UPDATE SET dm_key = EXCLUDED.dm_key` trick writes a dead row version on every call and fires update triggers; do not use it. The probe test P1-12 asserts the `DO SELECT` form works on the CI image and returns the existing row.

---

# Appendix B · Zod schemas in `packages/shared`

Decision D1: one place for every shape. The server validates with it, web and mobile import it, and there is no second type layer.

## B.1 · Folder layout

```
packages/shared/
  package.json          "@manythreads/shared"; exports map; "sideEffects": false; peer: zod
  src/
    index.ts            re-exports only
    version.ts          SHARED_SCHEMA_VERSION
    ids.ts              branded uuids: MessageId, ChannelId, TeamId, ActorId ...
    common/             time.ts (IsoDateTime), page.ts (Cursor, Page<T>), error.ts (ErrorEnvelope)
    entities/           one file per entity: workspace, person, team, channel, message, thread, file,
                        repo, bot, task, approval, answer, proposal, eval, connection, knowledge,
                        surface, onboarding, template, environment ...
    api/<area>/<op>.ts  e.g. messages/post-message.ts exports PostMessageRequest, PostMessageResponse, route
    events/             one file per event + registry.ts (type -> version -> schema)
    bot-md/             frontmatter.ts (strict), json-schema.ts (generated, committed)
    surfaces/registry.ts  component name -> props schema (phase 9)
    tokens.ts           design tokens mirrored from tokens.css
  test/                 round trips, strict-key rejection, snapshots/ of JSON Schema per schema
```

The server keeps `packages/server/src/db/mappers/<table>.ts`, one per table. Nothing else converts rows.

## B.2 · Naming rules

1. A schema and its type share one name: `export const Message = z.object({…}); export type Message = z.infer<typeof Message>;`.
2. Entities are singular nouns. Operations are `<Verb><Noun>Request` and `<Verb><Noun>Response`. Events are `<Domain><Verb>Event` with `type: z.literal("channel.message.posted")`; event types are `domain.noun.verb`.
3. Create and update schemas derive from the entity with `.pick`, `.omit`, `.partial`; they are not retyped.
4. `.strict()` for anything a client or bot sends (`BotFrontmatter` included). Responses strip unknown keys so a newer server does not break an older client.
5. Ids are branded, never a bare `string`. Dates cross the wire as ISO strings; the mapper converts `timestamptz` once.
6. No `any` and no bare `z.unknown()` in a public schema; open `jsonb` fields say what is allowed by a union or refinement.
7. Enums are `z.enum` and match the SQL `CHECK` exactly; a test compares both.
8. No class, function or `node:` import in `shared` (it runs in React Native). Names ending `Dto`, `Model`, `ViewModel` are banned by lint.

## B.3 · Worked example: Message

**Schema** (`entities/message.ts`).

```ts
export const Message = z.object({
  id: MessageId, workspaceId: WorkspaceId, channelId: ChannelId, authorId: ActorId,
  body: z.string().min(1).max(40_000),            // markdown
  bodyPlain: z.string(),                           // derived by the server, used for search
  threadRootId: MessageId.nullable(),
  editedAt: IsoDateTime.nullable(), deletedAt: IsoDateTime.nullable(),
  meta: z.object({ answerRef: z.string().optional(), surfaceRef: z.string().optional() }),
  createdAt: IsoDateTime,
});
export type Message = z.infer<typeof Message>;
```

**Operation and event** (`api/messages/post-message.ts`, `events/channel.message.posted.ts`).

```ts
export const PostMessageRequest = Message.pick({ channelId: true, body: true, threadRootId: true }).strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;
export const PostMessageResponse = Message;
export const postMessageRoute = { method: "POST", path: "/api/channels/:channelId/messages" } as const;

export const ChannelMessagePostedEvent = z.object({
  type: z.literal("channel.message.posted"), schemaVersion: z.literal(1),
  workspaceId: WorkspaceId, channelId: ChannelId, teamId: TeamId.nullable(),
  messageId: MessageId, authorId: ActorId, threadRootId: MessageId.nullable(),
});   // registry.ts: { "channel.message.posted": { 1: ChannelMessagePostedEvent } }
```

**Mapper** (`server/src/db/mappers/messages.ts`): the only place a row becomes a `Message`.

```ts
export const toMessage = (r: MessagesRow): Message => Message.parse({
  id: r.id, workspaceId: r.workspace_id, channelId: r.channel_id, authorId: r.author_id,
  body: r.body, bodyPlain: r.body_plain, threadRootId: r.thread_root_id,
  editedAt: r.edited_at?.toISOString() ?? null, deletedAt: r.deleted_at?.toISOString() ?? null,
  meta: r.meta, createdAt: r.created_at.toISOString() });
```

**Server validation** (Fastify, Zod type provider).

```ts
app.post(postMessageRoute.path, {
  schema: { params: z.object({ channelId: ChannelId }), body: PostMessageRequest, response: { 200: PostMessageResponse } },
}, async (req) => {
  const msg = await withActor(req.actor, (tx) => insertMessage(tx, req.params.channelId, req.body));
  await events.emit(ChannelMessagePostedEvent.parse({ type: "channel.message.posted", schemaVersion: 1, /* ids */ }));
  return msg;
});
```

A body that fails the schema returns 400 with `ErrorEnvelope` and the field path. A response that fails its schema is a 500 and an alert: the server has a bug.

**Client usage** (web or mobile, identical; no DTO, no copied type).

```ts
import { PostMessageRequest, PostMessageResponse, postMessageRoute, type Message } from "@manythreads/shared";
export const send = (channelId: ChannelId, body: string): Promise<Message> =>
  api.call(postMessageRoute, { request: PostMessageRequest, response: PostMessageResponse },
           PostMessageRequest.parse({ channelId, body, threadRootId: null }));   // fail early on the client
// the list component takes Message[] directly: (props: { messages: Message[] }) => …
```

Tests that prove the chain: a `Message` round trip in `shared`; an API test that posts and parses the response with `Message`; an event-contract test against `ChannelMessagePostedEvent`; the `*Dto` lint.

## B.4 · Versioning schemas

1. `@manythreads/shared` has one semver. Server and clients in the repo build from one commit, so the rules matter for stored data, event history, `BOT.md` files and installed mobile apps.
2. **Additive inside a version only:** a new optional field, or a new enum value on a response. Removing or renaming a field, making it required, narrowing a type or dropping an enum value is breaking.
3. A breaking change adds a new schema file beside the old one (`channel.message.posted.v2.ts`); the registry lists both. Emitters write the newest; consumers read the stored `schemaVersion` and **upcast** to the newest, so old events stay readable forever.
4. A breaking API change gets a new route version (`/api/v2/…`) kept for at least one mobile release cycle; the server declares a minimum client version and older apps show "Update the app".
5. `BOT.md` has an implied `schema: 1`; a new version adds an explicit key, the loader accepts both, and the Workshop proposes the upgrade as a diff.
6. `pnpm test:schema-compat` writes each schema as JSON Schema to `test/snapshots/`; a breaking diff fails the build unless the PR adds the new version file and an upcast with a test.
7. SQL follows the same idea: forward-only migrations; drop a column in two steps (stop writing, release, drop later).

---

*End of plan.*

# Appendix C · Decisions on points raised against the spec

Raised while writing this plan and decided by the coordinator. Spec v1.4.1 already contains items 1, 4, 5, 6, 7, 9, 10 and 14.

| # | Point | Decision |
|---|---|---|
| 1 | Postgres version, queue, ephemeral data | Postgres 19, `pg_trgm`, our own queue and outbox tables, UNLOGGED ephemeral tables and in-memory rate limits are in spec §2. Probe test P1-12 keeps checking `ON CONFLICT DO SELECT`; if it fails, the fallback is `DO UPDATE SET key = EXCLUDED.key RETURNING *` |
| 2 | Onboarding step count | Nine steps (0–8) per spec §16; the guide's "eight" is wrong. Plates exist for 1–6 and 8; steps 0 and 7 get wireframes (phases 2 and 10) |
| 3 | Bot page tabs | Thirteen sections per spec §7.2; the prototype copy is corrected |
| 4 | Roles | Workspace `owner`, `admin`, `member`, `guest`; team `lead`, `member`; role tags in `TEAM.md` such as `role:on-call`. Lena is a workspace `guest` added to one channel; guests cannot talk to or mention bots. Priya is a `member` of two teams |
| 5 | Threads "Mine" | Threads the person started or holds a task in |
| 6 | Editing `bots/`, `TEAM.md`, `skills/`, `routines/` | Team leads and workspace admins change them through the UI (proposal, then commit); everyone else by pull request |
| 7 | Hindsight database | A second database in the same CNPG cluster |
| 8 | Per-replica limits and UNLOGGED leases | Accepted as documented limits: rate limits are per replica; after failover leases are re-acquired and every job is idempotent. In phase 1 acceptance criteria and the phase 10 Helm notes |
| 9 | Counting benchmark | Spec §8: twenty bots, one counter task, claim, add one, release; log reads 1 to 20 exactly, no duplicate or gap, within 60 s. Rules variant per PR, Hermes variant nightly |
| 10 | `analytics` plugin | In the spec plugin list; stays in phase 8 |
| 11 | Runners, subscription runtimes, Tauri, `slack-compat` | Runners in phase 6; subscription flag and Tauri in 10; spike opens 5 |
| 12 | Milestones against phases | Milestones are time-based, phases dependency-based. M1 = phases 1–5 plus a minimal onboarding slice in phase 5 (steps 0, 1, 2, 5, 6). Full onboarding and the audit console stay in phase 10; the append-only audit log is the phase 1 event log |
| 13 | Guests and Brain or bots | Guests cannot use Brain or bots |
| 14 | Office preview; failed `BOT.md` | Server-side conversion to PDF by an optional LibreOffice worker (phase 4, optional task P4-12). A `BOT.md` that fails to load shows a red banner and the previous version stays live (phase 5 criterion 2) |
| 15 | Brain on mail | Opt-in per person (spec §20) |

---
