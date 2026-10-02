# bots

The identity of a team's bots: one row per `bots/<slug>/BOT.md` of the team repo, the runs it makes and what those runs
read (SPEC section 7, PLAN P5-03; the loader, the pairing route and the bot actor are P5-04). Code:
`packages/plugins/bots`. Schemas: `packages/shared/src/entities/bot.ts`. Migration: `migrations/0001_bots.sql`
(namespace `bots`, ordered after `channels` through the manifest's `dependsOn: ['channels']`, because `bot_runs`
references `app.threads`).

This plugin ships the schema — its `register` adds nothing yet. Everything below is what the tables promise now, so
P5-04 to P5-10 can build against it.

## Tables

| Table | What it holds | Key columns | Indexes |
|---|---|---|---|
| `bots` | one loaded bot, rebuilt from its `BOT.md` | `team_id`, `slug`, `kind` (`agent` \| `automation`), `runtime` (`hermes` \| `rules`), `visibility` (`team` \| `workspace`), `definition_sha` (sha256 of the file it came from), `status` (`active` \| `disabled` \| `invalid`), `placement` (jsonb) | UNIQUE `(team_id, slug)`; `(team_id)` |
| `bot_pairing_tokens` | a pairing credential: **sha256 only**, never the token | `bot_id`, `token_hash`, `revoked_at?` | partial UNIQUE `(token_hash) WHERE revoked_at IS NULL`; `(bot_id)` |
| `bot_runs` | one run | `bot_id`, `team_id`, `trigger_type` (the BOT.md trigger that fired it), `asker_id?`, `thread_id?`, `status` (`running` \| `done` \| `failed` \| `stopped`), `started_at`, `ended_at?` | `(bot_id, id DESC)`; partial `(bot_id) WHERE ended_at IS NULL`; `(team_id, id DESC)`; `(thread_id)` |
| `run_source_log` | what a run read: the evidence behind "Sources reached" | `run_id`, `seq`, `source_type` (open set: `message`, `page`, `file`, `memory`, ...), `source_ref`, `scope` (`team` \| `channel` \| `person`) | PK `(run_id, seq)` |

`definition_sha`, the slug shape and `seq >= 0` are enforced by CHECK as well as by the Zod schema, so a row is valid
whatever wrote it. The four `text` columns with a value set are the shared enums of `entities/bot.ts`
(`BotKind`, `BotRuntime`, `BotVisibility`, `BotStatus`, `BotRunTrigger`, `BotRunStatus`, `RunSourceScope`); the
kernel's `schema-enums` test fails if SQL and Zod ever list different values.

## Who may, and where

1. **`bots` — `rls: team`.** Readable by every caller whose `app.readable_team_ids('read')` contains the row's team
   (a member, or a workspace owner/admin; a guest gets none), plus, for `visibility: 'workspace'`, every **non-guest**
   member of the workspace — the same line `scoped_kv` uses. Writes are the **system role only**: the loader runs in
   the outbox consumer, and a person edits a bot by committing `BOT.md`, never by UPDATE (42501).
2. **`bot_pairing_tokens` — `rls: system`, no `GRANT` at all.** The request role cannot SELECT it, exactly like
   `app.session_tokens`: the gateway resolves a presented token as the system role (`ctx.identity.runAsSystem`),
   comparing hashes and revoking through `revoked_at`. Nothing that carries a token reads it through a request.
3. **`bot_runs` — `rls: team; asker own`.** A run is readable by its team's readers and by its `asker_id` even when
   the run's team is elsewhere (a person asks Brain from a DM). The app role may **INSERT** a run only for itself, in
   a team it can read (`workspace_id`, `app.readable_team_ids` and `asker_id = app.actor()` all in the WITH CHECK);
   status changes and deletes are the runtime (system).
4. **`run_source_log` — `rls: team`.** Readable with the run's team (a join onto `bot_runs`, no per-row helper), and
   appended to only by the run itself: the INSERT check is `run_id = app.run_id()`, the GUC `withActor` sets from the
   actor's `runId` (kernel `with-actor.ts`). Another writer is the system role.

Read plans are hoisted: `bots`, `bot_runs` and `run_source_log` are checked by
`findPerRowPolicyCalls` in `test/rls/bots.test.ts`, which fails the moment a policy calls a per-row helper.

## Events

None yet. P5-04 emits when a definition loads (and when one turns `invalid`); the run lifecycle events follow with
`bot_runs`.

## Tests

`test/rls/bots.test.ts`: the RLS harness (forced, policy, comment on all four tables) and the hoisted read plans; the
visibility matrix (team bot to its team and a workspace owner, workspace bot to non-guests, a guest to neither);
pairing tokens invisible to the request role; runs readable by team and asker with INSERT restricted to the caller in
a team it can read; the run's own log line through `app.run_id`; and one row of each table mapped through `src/rows.ts`
into its shared entity. The Zod ↔ SQL enum agreement is `packages/kernel/test/schema-enums.test.ts`.
