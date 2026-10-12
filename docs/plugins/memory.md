# memory

Feeds a team's memory bank from what the team did (SPEC §12.1, §15; PLAN P5-13). Team-visible messages and threads, run summaries, decided approvals and pages are retained to the bank of **their own team**, each with source, actor, time and link; nothing from a private channel, a DM or a bot conversation is ever read, and a run that touched a `person` source (or anything narrower than the team) retains nothing, with the log saying why. `memory_retain_log` is the record of what was retained, replaced, forgotten and withheld.

Package: `packages/plugins/memory` (PLAN writes `plugins/memory`; same `discoverPlugins` deviation as the other plugins). Schemas: `packages/shared/src/{entities/memory,api/memory,events/bots.run.closed}.ts`. Manifest: `extends: ['event.subscribe', 'job.register']`, `dependsOn: ['channels', 'bots', 'files', 'approvals', 'repo-git']`; `memory-hindsight` depends on it (the rule and the log are the platform's; the engine is the adapter's).

It writes to the engine only through the memory provider (`ctx.providers.get<MemoryProvider>('memory')`, today memory-hindsight): `provider.forTeam(tx, teamId)` in a system transaction, so the bank is derived from the team the **database** says the source belongs to — never from an event field, an argument or a bot. An event that names the wrong team changes nothing (`test:memory-cross-team` forges one).

## Sources

| Kind | Marked by | Document | Never |
|---|---|---|---|
| `message` | `channel.message.posted/edited/deleted` (a root message) | `<author> wrote in #<channel> on <day>:` + the plain text, ≤ 18,000 characters | a message of a private channel, a DM or a bot conversation; a deleted one; a reply (it is part of its thread) or a root that has live replies (the thread document quotes it) |
| `thread` | the same events, for a reply (and for an edit or delete of a root) | `Thread in #<channel>: <title>` then `[time] author: text` for the root and up to 100 replies, oldest first; a partial thread says how many more | the same; a bot reply (or a bot root) whose run read something narrower than the team is left out |
| `run` | `bots.run.closed` (new, emitted once by the run service when a run leaves `running`) | `The bot X of team T ran for a mention in #dev, asked by N.` + outcome + `It read 4 sources: 1 memory, 3 message.` — types and counts, never ids or text | a run the narrowest-source rule refuses (below) |
| `approval` | `approvals.approval.decided`, `approvals.approval.resumed` | who asked, the one-line summary, tool, source, the decision and how the call ended — never the arguments | a pending one; one raised in a private channel or conversation; one whose run the rule refuses |
| `page` | `pages.page.written`, and `repo.repo.committed` for a deleted `pages/` path | `Page pages/x.md, last written by N on <day>:` + the text from the repo index (≤ 1 MB, UTF-8) | a path outside `pages/`; a page a bot wrote during a run the rule refuses |
| `run_tool` | a bot's own `memory.retain` (memory-hindsight) | — (the bot's text goes to the bank by the tool; the log line says that it did) | — |

**Handovers, task and board changes** are not fed: `handoffs`, `tasks` and boards arrive in phase 6 with their own events (PLAN A.6); each is one more source kind (a resolver in `src/sources.ts`, an event subscription in `src/consumers.ts`, a value in the `source_kind` CHECK). `files.file.uploaded` is not fed either (the team repo and attachments are not text the engine reads).

Every document carries, in the engine's `metadata` (the provider adds `source: platform`, `team`, `workspace`): `feed_kind`, `feed_id`, `actor`, `actor_name`, `occurred_at`, `link` (a path relative to the deployment: `/t/<team>/c/<channel>?message=<id>`, `/t/<team>/bots/<slug>`, `/t/<team>/approvals`, `/t/<team>/files?open=<path>`) and kind-specific keys (`channel`, `bot`, `status`, `tool`, `path`); tags `feed`, `kind:<kind>`, `channel:<name>` / `bot:<slug>` / `tool:<tool>`.

## How a change reaches the bank

```
event ──▶ handler (outbox consumer's transaction): one row in memory_feed_pending, one queued drain
                                  │   never reads text, never calls the engine, never throws for the engine
                                  ▼
          drain job (memory.feed: queued after the debounce, and cron every minute)
             for each due source: resolve it NOW ──▶ decide(resolution, newest log line) ──▶ engine + log
```

* **The event is only "this changed".** The handler writes `(source_kind, source_id)` into the work list (a repeat only moves its time: one row per source, so an edit burst is one retain) and queues `memory.feed` after `MANYTHREADS_MEMORY_DEBOUNCE_MS` (default 15 s; a thread filling up is one document). It first checks cheaply that a message is in a public channel of a team, so a private channel costs nothing and leaves no line. A malformed payload is ignored.
* **The drain reads the source as it is now** (system transaction, `src/sources.ts`) and `decide` (`src/decide.ts`, pure, its table is a unit test) turns that and the newest log line of the source into one of: nothing (unchanged), **retain** (new or edited), **forget** (deleted, emptied, no longer team-visible), **withhold** (the rule), **defer** (a run has not closed), **skip**. Out-of-order or repeated delivery cannot bring back a deleted message: the database, not the event, is the truth.
* **Idempotent per source object.** The document id is `feed:<kind>:<source id>:<first 16 hex of the content's sha-256>`. The same text delivered again has the same hash as the newest `retained` line and does nothing. An **edit** is a new document: the old one is forgotten *first* (an edit may be the correction of a mistake or a secret), then the new one retained; if the forget fails the retain waits.
* **One drain at a time** across replicas (`pg_try_advisory_xact_lock`; no row locks are held across an engine call, so a handler never waits on the engine), at most 200 sources per run, at most 25 items per engine call, `async: true` (the engine distils facts in the background). A follow-up is queued for the earliest `not_before` left in the list.
* **Rate limit.** A sliding window in process memory per team (CLAUDE.md: never in the database): 120 retained and 600 forgotten documents per minute per replica. The rest stays in the work list with a delay; nothing is dropped.
* **The engine failing** backs the source off in its own row (30 s, 60 s, … to 30 min; `last_error` says what), the rest of the batch goes on, and after 8 attempts a `failed` line is written and the source dropped. **Not configured** (`MANYTHREADS_HINDSIGHT_URL` unset): the handlers queue nothing and write one `not_configured` line per team per day (`bank` = `(no engine)`); a drain that finds the engine gone drops its work. Neither can fail or hold up the outbox consumer, which every other plugin's events share. No backfill: what happened before the engine was configured is not fed.

Tuning (read per use, whole milliseconds 0..3,600,000): `MANYTHREADS_MEMORY_DEBOUNCE_MS` (15,000), `MANYTHREADS_MEMORY_DEFER_MS` (30,000: how often a source waiting for a run is looked at), `MANYTHREADS_MEMORY_BACKOFF_MS` (30,000).

## Forgetting

| When | How |
|---|---|
| a message is deleted (soft delete), emptied or its channel is gone | the next drain finds `deleted` / `gone`: the document in the newest `retained` line is forgotten; line `forgotten`, reason `deleted` |
| a message is edited | replaced (above); line `forgotten` `replaced`, then `retained` |
| a root gets its first reply | its own document is forgotten (`in_thread`) and the thread document is retained; the last reply deleted reverses it (`no_replies`) |
| a channel stops being a public channel of its team | `channel.channel.updated` for a channel that is no longer public marks every source of that channel the log says is in the bank; the drain forgets them (`not_team_visible`). An operator's SQL leaves no event: `memory.reconcile` (hourly) finds log lines whose channel is no longer public and marks them the same way. (Privacy never changes through the API: `channels_guard` — this is for the day it does, and for the operator.) |
| a page is deleted or has no text any more | `repo.repo.committed` (delete) / the index; reason `deleted` / `no_text` |
| a run, approval or bot-authored text turns out to be refused by the rule | forgotten with the refusal as the reason, and a `withheld` line |

## The narrowest-source rule

SPEC §12.1/§15: a run may retain only to memory no wider than the narrowest source it read. **`app.run_retain_verdict(run)`** (migration 0001; system role only) is the one place the decision is made, from the run's `run_source_log` **and the data the lines point at**:

| Refusal (first that applies) | When |
|---|---|
| `person_source` | a line with scope `person` |
| `private_source` | a line that is not team-visible: a `message` that does not resolve to a message of a **public channel of the run's own team** (whatever scope label it carries — a private message logged as `team` is still private; 0001 of memory-hindsight let that through), a `file` labelled `channel` that does not, a line of any other type labelled `channel`, another team's channel, a DM, an unresolvable or malformed ref |
| `conversation` | the run's trigger is `conversation` |
| `private_channel` | the run answers in a channel (`bot_runs.channel_id`) that is not a public channel of its team (a run opened by an approval resume carries the approval's channel) |
| `private_thread` | the run's thread is in a channel that is not a public channel of its team |

It also answers the narrowest scope (`person` < `channel` < `team`), the number of lines and the scope labels they carried (stored on the log line as `source_scopes`). Lines labelled `team` for non-message, non-file sources (a memory bank, a team file) are team-visible by construction.

**Who reads it.** `memory.retain` (memory-hindsight) through `app.memory_run_scope()`, which now takes `retain_refusal` from the verdict instead of its own check (memory-hindsight 0002: same refusals, same order, same trust base, one step stricter as above; **nothing was weakened**: the person line, conversation trigger, private channel/thread and "never approval-gated" are all still there, and `memory.retain` stays refused for a run that is not provably team-visible). The feed's run summaries, and the approvals of a run. A person-scoped run retains only to `people/<asker>.md` (P5-26, `memory.write`), never here.

**What a bot wrote without being asked to retain it** (`app.memory_authored_verdict(bot actor, at)`): a message a bot posted or a page it wrote is team-visible where it was posted, but the run that wrote it may have read something narrower, and the bank must not carry it then (it would outlive and out-reach the run's own scope). The bot's runs that were open at that instant (±2 s: git dates have one-second resolution) decide: the first refusal wins, a run that has not closed makes the source wait (`defer`: its source log can still grow; a day later it is withheld as `run_open`), no run at all means the bot wrote it outside a run and it is an ordinary team message. A run that never closed covers two hours from its start and no more. Correlating by time is conservative (two overlapping runs of one bot withhold each other's output) and needs no change to the channels plugin.

## memory_retain_log

`app.memory_retain_log` (migration 0001; PLAN A.5 `memory_retain_log`): `workspace_id`, `team_id`, `store` (`team_bank`; `person_file` is P5-26's), `bank`, `source_kind`, `source_id`, `channel_id?` (so a channel that stops being public finds its documents), `document_id?`, `content_hash?` (sha-256 of the retained text: the text itself is never stored), `outcome` (`retained` \| `forgotten` \| `withheld` \| `not_configured` \| `failed`), `reason`, `run_id?`, `source_scopes[]`, `actor_id?`, `link`, `created_at`. **Append-only** (no UPDATE/DELETE for any role). The newest line of a source says what the bank holds for it. A private channel's or DM's messages leave **no** line (the id of a private message is not for a lead who is not in the channel); runs, approvals and bot-authored text do (they are team-readable already), which is SPEC §15's "what was withheld".

Row level security: `team` kind, `SELECT` for `app.readable_team_ids('manage')` (the team's leads and workspace admins; hoisted), all writes for the system role only, plus the one definer door `app.memory_retain_log_run` (memory-hindsight 0002) through which a run's own `memory.retain` logs `retained` (one line per document, `source_kind` `run_tool`) or `withheld` (the refusal as the reason). `GET /api/teams/:slug/memory/retain-log?outcome=&source=&before=&limit=` (`ListMemoryRetainLogResponse`: newest first, `next` cursor) answers the same people and 403 to everyone else.

`app.memory_feed_pending` is the work list (system only: no privilege for the request role).

## Tests

* `test/render.test.ts`, `test/decide.test.ts`, `test/window.test.ts` — pure: bounded and linear text work (a megabyte of blank lines in well under a second), document ids, the reconcile table (idempotent, replace, forget, withhold once per reason, defer then give up), the sliding window.
* `test/feed-drain.test.ts` — the drain against a real database and a stand-in engine: retained with metadata, unchanged is nothing, an edit forgets then retains, delete, private channel / DM never read, a channel made private, a thread, 60 changes = three calls of ≤ 25 async items, throttling, engine down (back-off, `failed` after 8), forget fails → retain waits, not configured, team gone, one drain at a time, runs (clean / person / private message / DM / conversation / private channel / open then closed / never closed), what a bot wrote, approvals, pages.
* `test/rls/memory.test.ts` — the narrowest-source matrix (27 cases, each also asserted against `app.memory_run_scope()`), `app.memory_authored_verdict`, who reads and writes the log and the work list, the harness and hoisting checks, the run's own logging door.
* `test/feed.test.ts` — through the real server: events from real API calls, the outbox consumer, the job worker, the real provider and `tools/fake-hindsight`: message / edit / delete / repeat delivery, private channel and DM, a channel made private (by event and by sweep), thread, run closed (clean, person, conversation, closed twice), bot message deferred then withheld, approval, page create / replace / delete, a burst, engine down then back, the retain-log API.
* `test/feed-unconfigured.test.ts` — no engine: one `not_configured` line, nothing queued, nothing dead-lettered.
* `packages/plugins/memory-hindsight/test/cross-team/feeding.test.ts` (in `pnpm test:memory-cross-team`) — team A's feed never reaches team B's bank, whatever an event says; private channel and person-scoped run in no bank; a team B bot recalling team A's words gets none.
* `packages/shared/test/events/phase5-memory-contracts.test.ts`, the `bots.run.closed` and `MemoryRetainLogEntry` schema-compat snapshots, `kernel/test/schema-enums.test.ts` (the three CHECKs match their Zod enums).

## Not here (open)

* Handover, task and board changes as sources (phase 6 events); `files.file.uploaded`.
* The feed's text does not pass `hook.pre_egress` (DLP) before it goes to the engine: the engine's own LLM calls go through the LiteLLM proxy, and a secret typed in a public channel is as visible to the team as to the bank. P10-04 (personal-data and custom-regex DLP) is where a feed hook belongs.
* No backfill; no retention of the log itself (it is metadata; the P5-14 `retention` plugin decides).
* The memory screen (P5-26) will read `GET …/retain-log`; no UI change here.
* A thread document is re-retained as a whole when it changes (≤ 18,000 characters): a very busy thread costs one call per debounce window.
