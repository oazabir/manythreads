# bots

The identity of a team's bots: one row per `bots/<slug>/BOT.md` of the team repo, the runs it makes and what those runs
read (SPEC section 7, PLAN P5-03/P5-04). Code: `packages/plugins/bots`. Schemas:
`packages/shared/src/entities/bot.ts`, route schemas in `packages/shared/src/api/bots/`. Migrations:
`migrations/0001_bots.sql` (namespace `bots`, ordered after `channels` through the manifest's
`dependsOn: ['channels']`, because `bot_runs` references `app.threads`) and `migrations/0002_pairing.sql` (the three
SECURITY DEFINER functions over `bot_pairing_tokens`).

`register` wires two things (both extend `event.subscribe` + `event.emit`): the **loader**, a `repo.repo.committed`
subscription, and the **pairing routes**. Runs themselves (`bot_runs`) follow in P5-07.

## The loader

Every commit that touches `bots/<slug>/BOT.md` is read in the outbox consumer's system transaction
(`src/loader.ts`), one file per change of the event:

* **valid frontmatter** → one `bots` row: `INSERT ... ON CONFLICT (team_id, slug) DO UPDATE`, `definition_sha` the
  sha256 of the bytes, status `active` — except a row a lead turned **`disabled` by hand stays disabled** when its
  file changes (`CASE WHEN b.status = 'disabled'`). The bot's actor row is found-or-made
  (`ctx.db.getOneOrCreate`, unique on `workspace_id, kind, ref_id`), `handover.mayTag` is compiled into the bot's
  `tasks.handoff` grant (upserted while the key is in the file, **deleted when it leaves** — the loader owns this
  grant), then `bots.bot.loaded` is emitted with `definitionSha` and `mayTag`, never the content.
* **invalid frontmatter** (unknown key, missing key, bad YAML, a folder that is not a lowercase slug) → the previous
  row, if any, stays live with `status = 'invalid'` (last-good definition keeps running; the loader never overwrites
  `definition_sha` on a failure) and `bots.bot.invalid` carries the reason: `fieldPath` is what the schema named
  (`capabilities.native[3]`, `capabilties` for an unknown key) plus `message`. There is **no error column on the
  row** — the event is the alert, and P5-05's red banner reads these team-readable events. No row ever existed →
  event only (the `kind`/`runtime` columns are NOT NULL, a broken definition never lands half a row).
* **file deleted** → the row is deleted (pairing tokens and runs cascade), its capability grants deleted with it, the
  actor row kept (messages reference it), then `bots.bot.removed`.

Parsing lives in `src/bot-md.ts`: a line-scanned `---` fence (a BOM is stripped, nothing else is lenient), `yaml`,
then the strict `BotFrontmatter` of `packages/shared/src/bot-md/frontmatter.ts`. A failure anywhere in the handler
throws, so the outbox rolls the whole event back and retries; every step is an upsert or a delete, so a retry changes
nothing twice.

## Pairing (SPEC §7.6)

A bot never holds a credential — its runtime holds a **pairing token**: 256 random bits, base64url, **shown once**;
only its sha256 is stored (`bot_pairing_tokens`, no app GRANT, same shape as `app.session_tokens`).

* `POST /api/teams/:slug/bots/:botSlug/pairing-tokens` — a team lead or workspace admin mints one (rate 10/min),
  answered `{ token, createdAt }` at 201.
* `DELETE` the same path — revokes **every** live token of that bot, answered `{ revoked: n }`.

Both routes check `manage`, and the SECURITY DEFINER functions of `0002_pairing.sql` check it again for themselves
(`session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(team,'manage'), false)` — never the
`is_*` helpers, which are always true inside a system-owned definer).

**Resolving is not an HTTP route** (plugins never import each other): the caller of a token — the gateway of P5-09, a
rules run of P5-10 — hashes it and calls `app.bots_pairing_resolve(sha256(token))` in its own transaction
(`resolvePairingToken` in `src/pairing.ts` is the same call, exported for tests and for the plugin's own future
use). It answers `bot_id, team_id, workspace_id, actor_id, slug` — the token **is** the credential, so there is no
caller check, and unknown, revoked and malformed tokens all answer no rows, one answer for all three. Mint and
resolve are open only to `manythreads_app, manythreads_system` (`REVOKE ... FROM PUBLIC` first).

Events (`app.events`, team-readable): `bots.bot.loaded`, `bots.bot.invalid`, `bots.bot.removed` — all v1, registered
in `packages/shared/src/events/registry.ts`.

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

Emitted: `bots.bot.loaded`, `bots.bot.invalid`, `bots.bot.removed` (the loader above; payload in
`packages/shared/src/events/bots.bot.*.ts`). The run lifecycle events follow with `bot_runs`.

## Tests

`test/rls/bots.test.ts`: the RLS harness (forced, policy, comment on all four tables) and the hoisted read plans; the
visibility matrix (team bot to its team and a workspace owner, workspace bot to non-guests, a guest to neither);
pairing tokens invisible to the request role; runs readable by team and asker with INSERT restricted to the caller in
a team it can read; the run's own log line through `app.run_id`; and one row of each table mapped through `src/rows.ts`
into its shared entity. The Zod ↔ SQL enum agreement is `packages/kernel/test/schema-enums.test.ts`.

`test/bot-md.test.ts`: the parser alone — unknown key by name, bad value at its index, missing key, no/unclosed
fence, unparseable YAML, a tolerated BOM.

`test/loader.test.ts` (needs the DB): the seeded `bots/coder/BOT.md` lands with its actor and the right
`definition_sha` (hash of the file, not of the git blob); a valid file appears in the roster **within 5 s** with its
actor and compiled `mayTag` grant; an unknown key alerts with `fieldPath` and makes no row; a bad capability fails at
`capabilities.native[3]` while **the previous definition stays live** (`status = 'invalid'`, old sha, grant intact),
then fixing the file re-activates it with the new sha and allowlist; deleting the file drops row + grants + a live
pairing token (cascade) and keeps the actor row; a non-slug folder alerts instead of skipping.

`test/pairing.test.ts` (needs the DB): mint by a lead returns the token once and stores only its sha256, and it
resolves to the bot's ids + actor; forged/unknown tokens resolve to null; member, outsider and guest are 403, nobody
401, unknown slugs 404 and no refusal writes; the definer functions refuse a member and an outsider with **42501**,
refuse a short hash (22000) and a random bot id (02000), while the system role mints and revokes past the caller
check; revoke turns every live token off (`{ revoked: 2 }` → `{ revoked: 0 }`) and a new mint works again.
