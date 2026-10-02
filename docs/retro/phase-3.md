# Phase 3 retro · Channels, threads and direct messages

## 1. Reflect and refactor (P3-00)

Done before any channel or message table exists (PLAN Phase 3 section 0; the carried findings are in `docs/retro/phase-2.md` sections 9 and 10).

### RLS cost: hoisted visibility sets

`app.can()` inside a policy is a per-row `STABLE` plpgsql call. Kernel migration `0011_hoisted_rls.sql` adds `app.readable_team_ids(permission)`,
`app.member_team_ids(permission)`, `app.acl_grant_ids(resource_type, permission)` and `app.held_role_ids()` (definer functions owned by `manythreads_system`, caller from `app.actor()`,
checked with `lookup_*` as in 0006; guests and suspended people get `{}`) and rewrites every read policy that called a per-row helper to `team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`:
`teams`, `team_members`, `events`, `capability_grants`, `entity_links`, `scoped_kv`, `invitations`, `acl_entries` (kernel), `team_role_tags` (teams plugin `0003`), `stub_resources` (test-kernel `0003`).
Semantics did not change: the whole existing RLS suite passed untouched, and `kernel/test/rls/hoisted.test.ts` compares each set with `app.can_in_team` / `is_team_member` / `team_role` / `app.can` for
all seven personas, every permission and every grant kind. `app.can()` stays for single-row checks.

Benchmark (`pnpm --filter @manythreads/tools-bench bench:rls`: 300,000 `stub_resources` over three teams, FORCE RLS, unscoped `SELECT count(*)`, best of 3, Postgres 19 beta in the dev container):

| caller | before (per-row `can_in_team OR can`) | with sets, bare `app.is_system()` | with sets, `(SELECT app.is_system())` (shipped) |
|---|---|---|---|
| Nadia (member of Engineering, 100,000 visible) | 96.1 s (77 s in the P2 gate) | 0.51 s | **55 ms** |
| Lena (guest, sees nothing) | 94.3 s (74 s) | 0.49 s | **50 ms** |
| Omar (owner, 300,000 visible) | 27.5 s (21 s) | 0.48 s | **46 ms** |
| newest 50 of Engineering as Lena (denied, scans everything) | 32.8 s (24.5 s) | 0.2 s | 45 ms |

(Before: re-measured with `--legacy`, which reinstalls the old policy, while another suite was running, hence slower than the P2 numbers. The budget is 2 s; the script exits 1 above it.)
The P2 prototype's 0.48 s was the middle column: the sets removed the per-row team lookups, and wrapping the remaining `app.is_system()` in `(SELECT ...)` removed the last per-row call, a further 10x.
No covering index was needed. Lessons are in `MISTAKES.md` and `docs/plugins/README.md` ("Visibility sets"): the array is fixed at statement start (`INSERT ... RETURNING` of a row the statement itself makes visible needs a
branch that does not look it up, as `teams_select` does for admins), and every caller-dependent call in a policy goes in `(SELECT ...)`.

Enforcement: `findPerRowPolicyCalls(client, table)` in `@manythreads/test-utils` runs `EXPLAIN (VERBOSE, FORMAT JSON) SELECT count(*)` as `manythreads_app` and reports any `app.can` / `can_in_team` / `is_team_member` / `team_role` / `has_role`
in a scan, join or index condition outside an InitPlan. The RLS harness runs it for **every** table (allowlist `PER_ROW_ALLOWLIST` in `harness.test.ts`, with a reason per entry; empty today, a stale entry fails)
and proves the check catches a per-row policy and accepts the hoisted form. Workspace-level policies that still call `app.workspace_role()` / `app.is_workspace_admin()` per row (`people`, `roles`, `workspace_members`, ...) are
bounded by headcount and not covered; hoist them the same way if one ever grows.

Private channels and DMs (visibility per membership row, not per team): documented as the same idiom with a plugin-owned helper returning the visible ids; the channels plugin adds `app.visible_channel_ids()` in its first migration (docs/plugins/README.md).

### Plugin duplicates removed (SDK helpers)

`ctx.db.getOneOrCreate(tx, input)` (the kernel's `DO SELECT` helper behind the plugin transaction guard), `ctx.audit.emit(tx, event)` (`events.emit` with `schemaVersion` 1 and the transaction's workspace filled in) and
`ctx.templates.list()/get(id)` (kernel `loadTemplates`, cached). `packages/plugins/teams` uses all three; its `templates.ts` loader, the hand-written get-or-create statement and the `emit` wrapper are deleted (and its `yaml` dependency).
Tests: `kernel/test/plugins/sdk-helpers.test.ts` (twenty concurrent get-or-create callers converge on one row; gating; cache) plus the unchanged teams API suite.

### Last-lead guard

`0012_last_lead_guard.sql`: a trigger on `team_members` refuses (check_violation, 409 in the API) removing, demoting or moving the last `lead` of a team, unless the caller is a workspace owner or admin or the system role;
a team or workspace being deleted is exempt, concurrent demotions deadlock instead of both succeeding. Definer caller check by `lookup_workspace_role()` and `session_user`, not the `is_*` helpers (MISTAKES). Tests: `kernel/test/rls/last-lead.test.ts`, `teams-api.test.ts` ("last-lead guard").
Behaviour change for clients: a lead leaving a team with no other lead now gets 409 "a team must keep at least one lead"; the team settings screen should offer "make someone else lead first".

### Job worker host

`startServer` now starts workers (`jobWorkers`, default on; `MANYTHREADS_JOB_WORKERS=0` off) for the kernel's `kms.rewrap` queue and for each queue a plugin registers with `ctx.jobs.register(queue, handler, options?)`.
Decision: a new extension point `job.register` (one entry in the manifest enum) rather than reusing `trigger.register`, whose meaning is bot triggers. It is declared in `extends` because a plugin handler runs as the **system actor**,
one transaction per attempt scoped to `payload.workspaceId`, exactly the privilege `provider.identity` is gated for; queues must be named `<plugin>.<name>`, so two plugins cannot collide. This adds to the list in SPEC-FINAL section 3: the spec text needs a line (not edited here).
`ctx.jobs.enqueue(tx, queue, payload, { runAt, dedupeKey })` enqueues in the caller's transaction. Admin CLI `admin kms-rewrap` enqueues the rewrap (deduplicated while one waits or runs); `MANYTHREADS_KMS_PREVIOUS_KEYS` (comma-separated base64) lets the
process Kms unwrap the old key during rotation (before, only a hand-built Kms could, so the job could not have worked). Tests: `server/test/job-host.test.ts` (plugin job as system in the right workspace, failing attempt rolls back and is retried, a secret moves from the old key to the new one through the real worker), `admin-cli.test.ts`, `kms.test.ts`.
Open: the Helm chart does not template `MANYTHREADS_KMS_PREVIOUS_KEYS` yet (docs/deploy.md says so); a web-only replica can set `MANYTHREADS_JOB_WORKERS=0`.

### Zod enum and SQL CHECK

`kernel/test/schema-enums.test.ts` replaces the text-regex comparison that lived in `shared/test/common.test.ts`: it reads every `CHECK (col IN (...))` of the migrated database (`pg_get_constraintdef`, kernel plus the teams and test-kernel plugins),
requires each to be in the table-to-enum map (`ENUM_COLUMNS`: eleven columns today, including `workspace_members.role`, `team_members.role`, `people.status`) and compares values and order with the `z.enum`. A migration that adds an enum column without
listing its Zod schema fails the test, naming the column; the channels, messages and tasks plugins add their rows to the map.

### Not done, carried to later tasks

- Typed API client and settings frame (the other two prompts of section 0): answered in `docs/retro/phase-2.md` section 10; unchanged.
- `TEAM.md` still waits in `team_pending_files` for phase 4 (channels from `team.template.applied` are P3-05).
