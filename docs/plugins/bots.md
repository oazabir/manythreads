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
| `bots` | one loaded bot, rebuilt from its `BOT.md` | `team_id`, `slug`, `kind` (`agent` \| `automation`), `runtime` (`hermes` \| `rules`), `visibility` (`team` \| `workspace`), `definition_sha` (sha256 of the file it came from), `status` (`active` \| `disabled` \| `invalid`), `placement` (jsonb), `triggers` and `native` (jsonb; the loader's own projections, migration 0005), `invalid_reason` (jsonb, null while the file loads), `knowledge` (jsonb, migration 0017: BOT.md's `knowledge:` list as `[{ base, answer_only_from }]`; NULL for a bot loaded before the column, which the knowledge tool reads as no list) | UNIQUE `(team_id, slug)`; UNIQUE `(id, team_id)`; `(team_id)` |
| `bot_pairing_tokens` | a pairing credential: **sha256 only**, never the token | `bot_id`, `token_hash`, `revoked_at?` | partial UNIQUE `(token_hash) WHERE revoked_at IS NULL`; `(bot_id)` |
| `bot_runs` | one run | `bot_id`, `team_id`, `trigger_type` (the BOT.md trigger that fired it), `asker_id?`, `thread_id?`, `status` (`running` \| `done` \| `failed` \| `stopped`), `rehearsal` (boolean, migration 0018: the run is a rehearsal, see The Test action), `started_at`, `ended_at?` | `(bot_id, id DESC)`; partial `(bot_id) WHERE ended_at IS NULL`; `(team_id, id DESC)`; `(thread_id)` |
| `bot_eval_runs` | one run of a bot's scenario set (P7-08, migration 0016) | `bot_id`, `bot_slug`, `set_name`, `commit_sha?`, `trigger` (`on_demand` \| `on_commit` \| `nightly`), `mode` (`static` \| `model`), `status` (`running` \| `finished` \| `failed`), `min_score`, `total` / `judged` / `passed`, `score?`, `ok?`, `cost_tokens`, `error?`, `results` (jsonb, at most 100 verdicts), `requested_by?` | `(bot_id, id DESC)`; `(workspace_id)`; `(team_id)`; partial `(started_at) WHERE status = 'running'` |
| `rehearsal_questions` | the one message a lead or admin asked as a rehearsal (P7-11, migration 0018) | `message_id` (PK, the question), `team_id`, `bot_id`, `asked_by` | `(bot_id, asked_by, created_at DESC)`; `(workspace_id)`; `(team_id)`; `(asked_by)` |
| `rehearsal_intercepts` | one line per write a rehearsal run tried and the gateway held back: the tool name and where it aimed, **never the text** (P7-11, migration 0018) | PK `(run_id, seq)`, `capability`, `target?`, `would_wait` | PK |
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
   the outbox consumer, and a person edits a bot by proposing a change to `BOT.md` that a lead or admin applies (P7-01, [proposals](proposals.md)), never by UPDATE (42501).
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

## Evals (P7-08)

A bot's **evals** are the scenario set its BOT.md names (`evals: { set, minScore }`): the file `bots/<slug>/evals/<set>.yaml` in the team repo, a list of questions with what a good answer must and must not do (schema `BotEvalSet`, `packages/shared/src/bot-md/evals.ts`). Running them tells a lead whether a change to the bot's prompt or permissions made it worse. A run gives every case a verdict, and the set a score (cases passed out of cases that could be checked). The score is compared with `minScore`: below it, the run is flagged (`ok: false`) on the bot's Evals tab and in the event.

**Two modes**, because a model costs money and a commit should not:

- `static` (free, the default): no model is asked. Only what the definition itself decides can be judged: a case that *requires* a call (`toolCalls.required`) cannot pass if BOT.md does not grant that capability. Having a capability does not mean the bot will call it, so the cases that forbid a call, and every case about words (citations, "mentions", hand-offs, the list of what could not be reached), are shown as **not checked** and are left out of the score. They are never counted as passed.
- `model`: the bot's own prompt (the BOT.md body) goes to the first model alias the definition names, together with the case's world (the sources the asker may open; a source they may not open is never shown, it is only reported as out of reach). The model replies with a small JSON object (its answer, the sources it cites, the capabilities it would call); the reply is judged on every assertion. It goes through the gateway's pre-call check and spend ledger like any other call (`provider.llm.evalComplete`, [gateway-llm.md](./gateway-llm.md)), costs tokens, and is only run when a lead asks for it.

The judge is one function (`runEvalScenario` / `runEvalSet`, `packages/shared/src/bot-md/eval-run.ts`) that the server job, the command line and the tests all call; the loader (`loadBotEval`, `eval-load.ts`) reads the definition and the set and refuses, in plain words, a bot with no definition, a definition that does not load, no `evals` block, a missing set file, a set that fails its schema, and a set whose `set:` differs from the name in BOT.md.

**What starts a run**

| Trigger | When | Mode |
|---|---|---|
| `on_demand` | `POST /api/teams/:slug/bots/:botSlug/evals/run` by a lead or workspace admin (a member gets 403; 409 while a run started in the last ten minutes is still open; the check runs under a per-bot advisory lock, so two requests at once start one run; at most 20 requests a minute per client). Body `{ "mode": "static" \| "model" }`, default `static`. Answers 202 with the run in state `running`. | either |
| `on_commit` | `proposals.proposal.applied` for `bots/<slug>/BOT.md` or a file in `bots/<slug>/evals/` (a deleted BOT.md is ignored). The subscriber only enqueues the job (`bots.eval-run`, one per commit and bot); the job reads the files **at that commit**. A bot with no set makes no row. | `static` |
| `nightly` | `bots.eval-nightly` (cron `27 3 * * *`): one job per active bot, the same job; a bot with no set makes no row. | `static` |

The job (`bots.eval-run`, `detached`, one at a time per bot) reads the files in one short system transaction, judges the cases outside any transaction, and writes the verdict once in another. A run that cannot be made (no set file, a model refused, no model alias, a model run that would send more than 2 000 000 characters of prompt in all: the prompt once per case plus 8 000 for a case's world) ends `failed` with a plain sentence in `error`; so does an on-demand run whose job runs out of attempts before it could read the files. `bots.eval-reap` (hourly) ends a run still `running` after an hour. A commit that changes BOT.md before its set file exists shows one failed run saying so; the next commit, once the file is there, shows the real score.

**Reading**: `GET /api/teams/:slug/bots/:botSlug/evals` returns the set and minimum of the newest run, the newest finished run with every case (`latest`), the last ten runs without cases (`recent`) and whether the caller may run them (`canRun`). Everyone who can read the team reads it (RLS: `bot_eval_runs` is team-readable; a lead or admin may insert the first state of an `on_demand` run; every later change is the system role).

**The web**: the bot page's **Evals** tab shows the set, the minimum and the newest verdict as "Eval 17 of 20 passed · minimum 0.90 · view failures", a red flag when the score is below the minimum, a count of cases that passed on the calls they require while their other assertions were not checked ("only partly checked"), each failing case with its reasons, the cases that were not checked, earlier runs, and (for a lead or admin) "Run evals" and "Run with the model".

**The command line**: `pnpm test:evals -- --bot=<slug>` (`tools/evals`) runs the free mode against a bot folder on disk (the working folder, or a template under `templates/`; `--root=<folder>` names a checkout of a team repo; `--verbose` lists every case). Exit 0 at or above the minimum, 1 below it, 2 when the files cannot be used.

**Open items**: a lead is not notified when a run is below the minimum (notifications are tied to a message; the flag is the run and the event `bots.eval.run.finished`). The nightly pass is free-mode only; nobody has asked to spend tokens every night. The live model call has been exercised against the fake gateway only.

## The Test action (P7-11)

On a bot's page a team lead or workspace admin presses **Test**, types one question and reads the bot's answer in the panel. The bot runs for real: its prompt, its
knowledge, its read tools, the data-loss check, the gate and the budgets all apply. The one difference is that **every write it tries over the platform's tool door is held
back** and listed as "not done — rehearsal". Nothing is built as a new plugin: the data is `bots` migration 0018, the two routes are in `conversations`
(`src/rehearsal.ts`), the hold-back is in `gateway-mcp` and the router and run job are in `runtime-hermes`. (PLAN names `plugins/workshop` for the larger P7 workshop; it is not
needed for this.)

**How a run becomes a rehearsal.** Never from anything the client sends. `POST /api/teams/:slug/bots/:botSlug/test` takes `{ question }` and nothing else (a strict body: no
flag, channel or asker). In one transaction it opens the caller's own conversation with the bot (`app.conversations_open`), posts the question there as an ordinary message
(through the `messages` provider) and files it in `rehearsal_questions` (the row's RLS: the asker only, a team they manage, a message they wrote, a bot of that team). The
router (`runtime-hermes`) reads that table when the message's event arrives, and queues the run with `rehearsal: true`; the run job writes it into `bot_runs.rehearsal`.
The gateway reads the flag back from the **run's own row** on every call (the run is found from its token), so no argument of a tool call can switch it on or off. Only a
`conversation` run can be a rehearsal (CHECK). Only that one question is a rehearsal: if the person keeps typing in the conversation, the next message is an ordinary run.

**Who may.** `manage` on the bot's team (a lead of that team or a workspace admin): 403 otherwise; an unknown bot is 404; a bot that is not `active`, is not `hermes`, or has no
`conversation` trigger is 409 (`bot_has_no_conversation_trigger` for the last). One test at a time per person and bot (409 while the earlier one is running; a question counts as running from the moment it is filed, for up to five minutes before its run opens, and two presses at the same instant take turns on an advisory lock), at most 10 a minute per client
(the same rate-limit door every route has). The question lives in the caller's private conversation channel and nowhere else; it is not posted to a team channel and the
result route is the asker's alone (RLS on `rehearsal_questions`).

**What is held back** (`docs/plugins/gateway-mcp.md`, "Rehearsal runs"): a tool whose kind is not `read` or `stub`, except the reply itself (`answer.post`). A tool the catalog
does not describe counts as a write. A grant that needs approval files **no** approval in a rehearsal; the line says `would_wait`. A call the broker refuses (no grant, a
forbidden path, the data-loss check) is refused exactly as before and is not listed as held back.

**What cannot be held back, so the test is refused (409).** A bot whose BOT.md grants `capabilities.runtime` (`shell`, `files`, `browser`, ...) has tools in its own Hermes
process that never pass through the gateway. On a gateway or pod placement those are per profile, not per run, so a rehearsal cannot turn them off. The route reads the
definition from the repo (the same file the loader used, checked by sha) and refuses, naming what is granted; if it cannot read the definition it refuses too (it cannot say what the bot may do).
The run job checks again and ends the run `stopped` with a notice if the definition changed in between.

**What the model is told.** `runtime-hermes/src/rehearsal.ts` puts a short note in front of the prompt: this is a test, writes are held back, never say one happened, and say
plainly if there is no knowledge base. The hold-back does not depend on the model obeying it; the note only keeps the reply honest.

**The result.** `GET /api/teams/:slug/bots/:botSlug/test/:messageId` answers `{ messageId, channelId, status, intercepted[], interceptedMore, knowledge }`. `status` is `waiting`
(no run yet, or still running), `answered` (the run is done and the thread holds the bot's reply), `stopped` (ended without a reply on purpose: held, refused, or blocked) or
`failed`. `intercepted` is the first 50 lines (200 are kept per run; past that the call is still held back and `interceptedMore` is true). `knowledge` is `none` (no indexed
document in any base the bot may use: it answers from what it has, and the panel says so), `used` (the run read at least one passage) or `not_used`. The answer itself is the
reply in the thread (an `Answer` with its numbered sources when the bot used `answer.post`), which the panel reads with the thread route.

**Tables and door.** `bot_runs.rehearsal` (+ CHECK), `rehearsal_questions` and `rehearsal_intercepts` (RLS ENABLE+FORCE, indexed foreign keys). The only way to write an intercept line is
`app.rehearsal_intercept_append(capability, target, would_wait)`, a definer function owned by `manythreads_system` with a pinned `search_path`: it takes the run from `app.run_id()`,
refuses a run that is not a live rehearsal (so a normal run cannot record "not done"), takes an advisory lock for the position and keeps at most 200 lines. `ctx.runs.logIntercept` is the
SDK door to it (refused in the restricted `run.close` and `run.resolve` contexts, like `logSource`).

**Not built / limits.** No audit event or entry is written for starting a test beyond the ordinary message and run rows. Continuing the conversation in the thread is not a
rehearsal and is not badged. The model's closing text is posted by the runtime as the reply (not a tool call), so it is the only "write" a rehearsal makes, and it lands in
the asker's private thread. A runtime other than `hermes` (rules bots) cannot be tested here.

**Tests.** `packages/plugins/gateway-mcp/test/rehearsal.test.ts` (a write in a rehearsal changes nothing and is answered "not done", one line kept without the text, an approval is not filed, reads and `answer.post`
still work, the same write on a normal run happens, a tool argument cannot flip the flag, the 200-line cap, a normal run cannot write a line);
`packages/plugins/conversations/test/rehearsal.test.ts` (the whole path with a stand-in Hermes: who may, strict body, 404/409 cases, the run is a rehearsal for the asker, the prompt carries the note, the
next message is a normal run, the result is the asker's alone, one at a time); `packages/plugins/runtime-hermes/test/rehearsal.test.ts` (the note and the runtime-grant refusal);
`test/rls/bots.test.ts` ("rehearsal runs"); web `clients/web/test/bot-test-run.test.ts`; browser `e2e/bots/test-action.spec.ts` (desktop and phone); live-only `e2e/screens/task.p7-11.shots.ts`.

## The stale-run reaper

`bots.reap-runs` (hourly, `maxAttempts: 1`): a run still `running` past its bot's `bots.run_timeout_seconds` (BOT.md `limits.timeoutSeconds` as written, migration 0010, filled by the loader on every load and, for a bot loaded before the column, by the daily `backfillRunTimeouts` which re-reads BOT.md at `main` when it is the file the row was loaded from; `run_timeout_known` says it was read) plus ten minutes — six hours when the definition names none — is a run whose worker died. It is closed `failed` through the run service (`ctx.runs.close`: the manifest extends `run.close`, the close-only door of [security.md](./security.md), not the whole run door), so `bots.run.closed` is emitted and its endpoint token is revoked; at most 200 per pass. A worker that still holds the reaped run's handle can do nothing more with it. Nothing else ever ended such a run, and everything that waits for runs to end (the memory feed holds a bot's output back while one of its runs is open) waited with it.

## Events

Emitted: `bots.bot.loaded`, `bots.bot.invalid`, `bots.bot.removed` (the loader above; payload in
`packages/shared/src/events/bots.bot.*.ts`). `bots.eval.run.finished` (v1: workspace, team, bot, run, set, trigger, mode, status, commit, total / judged / passed, score, minScore, `ok`; counts only, never a case's answer) is written once when an eval run ends, whoever started it. Consumed: `repo.repo.committed` (the loader) and `proposals.proposal.applied` (the eval trigger above). `bots.run.closed` (v1: workspace, team, bot, run, trigger, status `done`/`failed`/`stopped`) is written by the run service (`ctx.runs.close`, kernel) in the transaction that moves a run out of `running` — once per run, nothing for a repeated close — and is what the `memory` plugin feeds a run summary from ([memory.md](./memory.md)).

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

`test/evals.test.ts` (needs the DB): a lead runs a set and a member gets 403; a definition missing a required call scores 0 and `ok: false`; a second run while one is open is 409; the hourly pass ends a dead run; a bot with no set fails in plain words and a missing set file is named; the model mode through a fake answerer (counts, tokens, a failing case's reason) and without a model binding (the run fails with a sentence); an applied proposal for BOT.md starts an `on_commit` run at that commit and the worse definition is flagged, the event says so, and a change to `TEAM.md` or to a bot with no set starts nothing; the nightly pass. `test/evals-answerer.test.ts`: how a model reply becomes an answer. `test/rls/bots.test.ts` covers `bot_eval_runs`. The judge and loader are `packages/shared/test/bot-eval-run.test.ts`; the command line is `tools/evals/test/cli.test.ts`; the browser path is `e2e/evals/on-commit.spec.ts`.

## Definitions a template ships (P5-19)

A team made from a template starts with the bots its template ships: Brain in all five, plus Coder (Engineering), Support responder
(Customer support) and Content drafter (Marketing). They are `bots/<slug>/BOT.md` files in the first commit of the team's repository, and
this loader reads that commit like any other, so nothing here knows a bot came from a template. The files, what each one grants and why,
the scenario set Brain's `evals: { set: brain, minScore: 1 }` names (`bots/brain/evals/brain.yaml`, schema `BotEvalSet` in
`packages/shared/src/bot-md/evals.ts`; the Evals tab shows the set's name and the minimum, the cases are read by the eval harness) and the
mail opt-in are in [docs/templates.md](../templates.md). A template's gate lists are patterns, never phrases: a phrase entry needs the
classifier on the `local` alias for every message ([runtime-hermes.md](./runtime-hermes.md#the-gate-p5-11)).

## Gateway placement and the bot token

`placement.gateway` puts a bot on a Hermes gateway (docs/plugins/runtime-hermes.md); `placement.runner` is legacy. The bot token is the pairing
token: `POST …/pairing-tokens` mints one, `POST …/pairing-tokens/rotate` revokes all live ones and mints a new one in one step (event
`bots.pairing.rotated`), `DELETE …/pairing-tokens` revokes. Only a lead or workspace admin may.
