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
  file changes (`CASE WHEN b.status = 'disabled'`). The row also carries the definition's own projections: `placement`,
  `triggers` (the list the router matches on, migration 0005) and `native` (the compiled `capabilities.native`, kept so the
  allowlist can be resynced without re-reading the file it replaced). The bot's actor row is found-or-made
  (`ctx.db.getOneOrCreate`, unique on `workspace_id, kind, ref_id`); the loader then (P5-10)
  * makes the actor a **member of the bot's team** (`team_members`, `role: member` — the table the kernel comments as "the
    roster of people *and* bots"), which is what gives a bot its team's public channels and nothing private;
  * compiles `capabilities.native` into `capability_grants` **as written** — `messages.*` stays a namespace grant, which the
    broker's lookup answers for every verb under it, while a destructive verb is still refused before the allowlist is
    consulted — and `approvals.needsApproval` sets `needs_approval` on the grants it names (such a call waits in the
    [approvals](./approvals.md) inbox). Entries the previous load compiled and this one dropped are deleted;
  * projects `approvals.approvers` onto `bots.approvers` (bots 0009), which the approvals plugin reads for a call that has no definition at hand;
  * compiles `handover.mayTag` into the bot's `tasks.handoff` grant (upserted while the key is in the file, **deleted when it
    leaves** — the loader owns this grant, and it wins over a `tasks.handoff` in `native`);
  then `bots.bot.loaded` is emitted with `definitionSha` and `mayTag`, never the content.
* **invalid frontmatter** (unknown key, missing key, bad YAML, a folder that is not a lowercase slug) → the previous
  row, if any, stays live with `status = 'invalid'` (last-good definition keeps running; the loader never overwrites
  `definition_sha` on a failure) and `bots.bot.invalid` carries the reason: `fieldPath` is what the schema named
  (`capabilities.native[3]`, `capabilties` for an unknown key, `guard.gate.1` for a gate-list entry the linear-time subset refuses — a nested repetition like `(a+)+`, a backreference, lookaround,
  a flag other than `i`, a pattern or a list over its size limits; see [runtime-hermes](./runtime-hermes.md), "The gate") plus `message`. The event is the alert; the row also
  keeps the last failure in `invalid_reason` (migration 0006), which P5-05's red banner reads and the next good load
  clears — a repaired file shows no banner. A `disabled` bot stays `disabled` through invalid and valid loads alike
  (only `active` becomes `invalid`). No row ever existed →
  event only (the `kind`/`runtime` columns are NOT NULL, a broken definition never lands half a row).
* **file deleted** → the row is deleted (pairing tokens and runs cascade), its capability grants and the team membership
  row are deleted with it, the actor row kept (messages reference it), then `bots.bot.removed`.

Parsing lives in `src/bot-md.ts`: a line-scanned `---` fence (a BOM is stripped, nothing else is lenient), `yaml`,
then the strict `BotFrontmatter` of `packages/shared/src/bot-md/frontmatter.ts`. A failure anywhere in the handler
throws, so the outbox rolls the whole event back and retries; every step is an upsert or a delete, so a retry changes
nothing twice.

### The model_aliases backfill

`bots.model_aliases` (migration 0008) is the loader's projection of one *file*, so SQL cannot fill it for the bots that were loaded
before the column existed. `bots.backfill-model-aliases` (`src/backfill.ts`, daily at 03:11 UTC, a `job.register` cron) re-reads
`bots/<slug>/BOT.md` at `main` through the repo provider for every **active hermes bot with an empty projection**, and — only
when that file is the one the row was loaded from (same sha256; a newer one is the loader's) and it names a model — writes the list and
emits `bots.bot.loaded` again, which the gateway turns into the bot's LLM key. A bot whose file names no model stays empty and
costs one blob read a day. There is no server-start hook for a non-identity plugin, so the first run is the next 03:11 UTC; recommitting
a `BOT.md` does the same at once.

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
caller check, and unknown, revoked, malformed tokens **and the token of a bot that is not `active`** all answer no rows, one answer for all of them. Mint and
resolve are open only to `manythreads_app, manythreads_system` (`REVOKE ... FROM PUBLIC` first).

Events (`app.events`, team-readable): `bots.bot.loaded`, `bots.bot.invalid`, `bots.bot.removed` — all v1, registered
in `packages/shared/src/events/registry.ts`.

## Tables

| Table | What it holds | Key columns | Indexes |
|---|---|---|---|
| `bots` | one loaded bot, rebuilt from its `BOT.md` | `team_id`, `slug`, `kind` (`agent` \| `automation`), `runtime` (`hermes` \| `rules`), `visibility` (`team` \| `workspace`), `definition_sha` (sha256 of the file it came from), `status` (`active` \| `disabled` \| `invalid`), `placement` (jsonb), `triggers` and `native` (jsonb; the loader's own projections, migration 0005), `invalid_reason` (jsonb, null while the file loads) | UNIQUE `(team_id, slug)`; UNIQUE `(id, team_id)`; `(team_id)` |
| `bot_pairing_tokens` | a pairing credential: **sha256 only**, never the token | `bot_id`, `token_hash`, `revoked_at?` | partial UNIQUE `(token_hash) WHERE revoked_at IS NULL`; `(bot_id)` |
| `bot_runs` | one run | `bot_id`, `team_id`, `trigger_type` (the BOT.md trigger that fired it), `asker_id?`, `thread_id?`, `status` (`running` \| `done` \| `failed` \| `stopped`), `started_at`, `ended_at?` | `(bot_id, id DESC)`; partial `(bot_id) WHERE ended_at IS NULL`; `(team_id, id DESC)`; `(thread_id)` |
| `run_source_log` | what a run read: the evidence behind "Sources reached" | `run_id`, `seq`, `source_type` (open set: `message`, `page`, `file`, `memory`, ...), `source_ref`, `scope` (`team` \| `channel` \| `person`) | PK `(run_id, seq)` |

`bot_runs` has a composite foreign key `(bot_id, team_id) → bots (id, team_id)`, so a run cannot name a bot of another team, and
its INSERT policy admits only a run that starts `running` with no `ended_at` (migration 0006).

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
   the run's team is elsewhere (a person asks Brain from a DM) — **except a run of the `conversation` trigger, which only
   its asker reads** (migration 0011: a conversation is one person's private use of the bot, so a teammate, the team's
   lead and a workspace admin do not list it; a bot inside the run reads its own run through `app.run_id()`). The
   bot page's run list (`GET …/bots/:botSlug`) repeats the predicate (`trigger_type <> 'conversation' OR asker_id =
   app.actor()`) so it is right on its own. The app role may **INSERT** a run only for itself, in
   a team it can read (`workspace_id`, `app.readable_team_ids` and `asker_id = app.actor()` all in the WITH CHECK);
   status changes and deletes are the runtime (system). A new reader of `bot_runs` as the request role must decide
   what a conversation run shows: the system role (router, reaper, feed, retention, approvals' hand-back) reads all.
4. **`run_source_log` — `rls: team`.** Readable with the run's team (a join onto `bot_runs`, no per-row helper; so a
   conversation run's lines follow the run: its asker only), and
   appended to only by the run itself: the INSERT check is `run_id = app.run_id()`, the GUC `withActor` sets from the
   actor's `runId` (kernel `with-actor.ts`). Another writer is the system role.

Read plans are hoisted: `bots`, `bot_runs` and `run_source_log` are checked by
`findPerRowPolicyCalls` in `test/rls/bots.test.ts`, which fails the moment a policy calls a per-row helper.

## The stale-run reaper

`bots.reap-runs` (hourly, `maxAttempts: 1`): a run still `running` past its bot's `bots.run_timeout_seconds` (BOT.md `limits.timeoutSeconds` as written, migration 0010, filled by the loader on every load and, for a bot loaded before the column, by the daily `backfillRunTimeouts` which re-reads BOT.md at `main` when it is the file the row was loaded from; `run_timeout_known` says it was read) plus ten minutes — six hours when the definition names none — is a run whose worker died. It is closed `failed` through the run service (`ctx.runs.close`: the manifest extends `run.close`, the close-only door of [security.md](./security.md), not the whole run door), so `bots.run.closed` is emitted and its endpoint token is revoked; at most 200 per pass. A worker that still holds the reaped run's handle can do nothing more with it. Nothing else ever ended such a run, and everything that waits for runs to end (the memory feed holds a bot's output back while one of its runs is open) waited with it.

## Events

Emitted: `bots.bot.loaded`, `bots.bot.invalid`, `bots.bot.removed` (the loader above; payload in
`packages/shared/src/events/bots.bot.*.ts`). `bots.run.closed` (v1: workspace, team, bot, run, trigger, status `done`/`failed`/`stopped`) is written by the run service (`ctx.runs.close`, kernel) in the transaction that moves a run out of `running` — once per run, nothing for a repeated close — and is what the `memory` plugin feeds a run summary from ([memory.md](./memory.md)).

## Tests

`test/rls/bots.test.ts`: the RLS harness (forced, policy, comment on all four tables) and the hoisted read plans; the
visibility matrix (team bot to its team and a workspace owner, workspace bot to non-guests, a guest to neither);
pairing tokens invisible to the request role; runs readable by team and asker with INSERT restricted to the caller in
a team it can read; the run's own log line through `app.run_id`; and one row of each table mapped through `src/rows.ts`
into its shared entity. The Zod ↔ SQL enum agreement is `packages/kernel/test/schema-enums.test.ts`.

`test/bot-md.test.ts`: the parser alone — unknown key by name, bad value at its index, missing key, no/unclosed
fence, unparseable YAML, a tolerated BOM.

`test/backfill.test.ts` (needs the DB): a pre-0008 row with an empty `model_aliases` is filled from its file at `main` (aliases, then fallbacks) and re-announced; a row whose file moved on, names no model, is missing, or is not an active hermes bot is left alone.

`test/loader.test.ts` (needs the DB): the seeded `bots/coder/BOT.md` lands with its actor and the right
`definition_sha` (hash of the file, not of the git blob); a valid file appears in the roster **within 5 s** with its
actor, its compiled `mayTag` grant, its `triggers`/`native` projections, a `capability_grants` row per native entry and its
**team membership** (P5-10); an unknown key alerts with `fieldPath` and makes no row; a bad capability fails at
`capabilities.native[3]` while **the previous definition stays live** (`status = 'invalid'`, old sha, grant intact),
then fixing the file re-activates it with the new sha and allowlist; deleting the file drops row + grants + the membership
row + a live pairing token (cascade) and keeps the actor row; a non-slug folder alerts instead of skipping.

`test/pairing.test.ts` (needs the DB): mint by a lead returns the token once and stores only its sha256, and it
resolves to the bot's ids + actor; forged/unknown tokens resolve to null; member, outsider and guest are 403, nobody
401, unknown slugs 404 and no refusal writes; the definer functions refuse a member and an outsider with **42501**,
refuse a short hash (22000) and a random bot id (02000), while the system role mints and revokes past the caller
check; revoke turns every live token off (`{ revoked: 2 }` → `{ revoked: 0 }`) and a new mint works again.

## Definitions a template ships (P5-19)

A team made from a template starts with the bots its template ships: Brain in all five, plus Coder (Engineering), Support responder
(Customer support) and Content drafter (Marketing). They are `bots/<slug>/BOT.md` files in the first commit of the team's repository, and
this loader reads that commit like any other, so nothing here knows a bot came from a template. The files, what each one grants and why,
the scenario set Brain's `evals: { set: brain, minScore: 1 }` names (`bots/brain/evals/brain.yaml`, schema `BotEvalSet` in
`packages/shared/src/bot-md/evals.ts`; the Evals tab shows the set's name and the minimum, the cases are read by the eval harness) and the
mail opt-in are in [docs/templates.md](../templates.md). A template's gate lists are patterns, never phrases: a phrase entry needs the
classifier on the `local` alias for every message ([runtime-hermes.md](./runtime-hermes.md#the-gate-p5-11)).
