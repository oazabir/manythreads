# memory

Feeds a team's memory bank from what the team did (SPEC §12.1, §15; PLAN P5-13). Team-visible messages and threads, run summaries, decided approvals and pages are retained to the bank of **their own team**, each with source, actor, time and link; nothing from a private channel, a DM or a bot conversation is ever read, and a run that touched a `person` source (or anything narrower than the team) retains nothing, with the log saying why. `memory_retain_log` is the record of what was retained, replaced, forgotten and withheld.

Package: `packages/plugins/memory` (PLAN writes `plugins/memory`; same `discoverPlugins` deviation as the other plugins). Schemas: `packages/shared/src/{entities/memory,api/memory,events/bots.run.closed}.ts`. Manifest: `extends: ['event.subscribe', 'job.register']`, `dependsOn: ['channels', 'bots', 'files', 'approvals', 'repo-git']`; `memory-hindsight` depends on it (the rule and the log are the platform's; the engine is the adapter's).

It writes to the engine only through the memory provider (`ctx.providers.get<MemoryProvider>('memory')`, today memory-hindsight): `provider.forTeam(tx, teamId)` in a system transaction, so the bank is derived from the team the **database** says the source belongs to — never from an event field, an argument or a bot. An event that names the wrong team changes nothing (`test:memory-cross-team` forges one).

## Sources

| Kind | Marked by | Document | Never |
|---|---|---|---|
| `message` | `channel.message.posted/edited/deleted` (a root message) | `<author> wrote in #<channel> on <day>:` + the plain text, ≤ 18,000 characters | a message of a private channel, a DM or a bot conversation; a deleted one; a reply (it is part of its thread) or a root that has live replies (the thread document quotes it) |
| `thread` | the same events, for a reply (and for an edit or delete of a root) | `Thread in #<channel>` (+ `: <first line of the root>` only when the root is quoted: never `threads.title`, which is a copy of the root's first characters and would leak a withheld root) then `[time] author: text` for the root and up to 100 replies, oldest first; a partial thread says how many more | the same; a bot reply (or a bot root) whose run read something narrower than the team is left out of the document, with one `withheld` line per excluded message |
| `run` | `bots.run.closed` (new, emitted once by the run service when a run leaves `running`) | `The bot X of team T ran for a mention in #dev, asked by N.` + outcome + `It read 4 sources: 1 memory, 3 message.` — types and counts, never ids or text | a run the narrowest-source rule refuses (below); a run of a private context (a `conversation` trigger, a private or DM channel, a thread in one) leaves no line at all — decided from the run itself before anything it read, so a DM run that read a person source leaves none either |
| `approval` | `approvals.approval.decided`, `approvals.approval.resumed` | who asked, the one-line summary, tool, source, the decision and how the call ended — never the arguments | a pending one; one raised in a private channel or conversation; one whose run the rule refuses |
| `page` | `repo.repo.committed`, for every `pages/` path of a commit (put or delete, whoever committed: `pages.write`, the Files screen's save, a restore) | `Page pages/x.md, last written by N on <day>:` + the text from the repo index (≤ 1 MB, UTF-8) | a path outside `pages/`; a page a bot wrote during a run the rule refuses |
| `run_tool` | a bot's own `memory.retain` (memory-hindsight) | — (the bot's text goes to the bank by the tool; the log line says that it did) | — |

A bot's own `memory.retain` (`run_tool` line) is shown by its run: the API answers the run id as `sourceId` and no `documentId`, because the id the platform derived for that text is a digest of it.

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
* **Idempotent per source object.** The document id is `feed:<kind>:<source id>:<first 16 hex of the content's keyed digest>`; the digest is an HMAC-SHA-256 under a per-workspace random key (`memory_workspace_keys`, system only, created on first use, never returned): an unkeyed hash of a message would let anyone who reads the log or a document id test a guess against it, and a `forgotten` line is a deleted, perhaps secret, text. The same text in the same workspace has the same digest, so a repeat does nothing. An **edit** is a new document: the old one is forgotten *first* (an edit may be the correction of a mistake or a secret), then the new one retained; if the forget fails the retain waits.
* **The workspace key** is read inside the drain's own transaction and kept for that drain only (never in the process): a key created by a drain that then rolled back must not outlive it while no other replica has it.
* **One drain at a time** across replicas (`pg_try_advisory_xact_lock`; no row locks are held across an engine call, so a handler never waits on the engine), at most 200 sources per run, at most 25 items per engine call, `async: true` (the engine distils facts in the background). A follow-up is queued for the earliest `not_before` left in the list.
* **Rate limit.** A sliding window in process memory per team (CLAUDE.md: never in the database): 120 retained and 600 forgotten documents per minute per replica. The rest stays in the work list with a delay; nothing is dropped.
* **The engine failing** backs the source off in its own row (30 s, 60 s, … to 30 min; `last_error` says what) and the rest of the batch goes on. A 400, 413 or 422 on a chunk retries its items one at a time, so one item the engine will not take cannot hold back the other twenty-four. After 8 failed attempts to **retain**, a `failed` line is written and the source dropped (the next change retries it). A **forget** is never given up on: after the 8th attempt the `failed` line carries the document id, and the work row stays, tried every half hour until it works.
* **Not configured** (`MANYTHREADS_HINDSIGHT_URL` unset): the handlers write one `not_configured` line per team per day (`bank` = `(no engine)`) and queue only the changes of sources the bank holds a document for, so a delete or an edit made while the engine is off is carried out when it is back (a drain with no engine looks at them again every ten minutes; every other change is dropped: no backfill). Neither can fail or hold up the outbox consumer, which every other plugin's events share.
* **What the bank holds for a source** is the newest line of it among `retained` / `forgotten` / `withheld`. A `not_configured` or `failed` line is a note about an attempt and never shadows it — otherwise a document could stay in the bank with nothing left that remembers to remove it. The hourly sweep and the channel handlers read the same rule.

Tuning (read per use, whole milliseconds 0..3,600,000): `MANYTHREADS_MEMORY_DEBOUNCE_MS` (15,000), `MANYTHREADS_MEMORY_DEFER_MS` (30,000: how often a source waiting for a run is looked at), `MANYTHREADS_MEMORY_BACKOFF_MS` (30,000).

## Forgetting

| When | How |
|---|---|
| a message is deleted (soft delete), emptied or its channel is gone | the next drain finds `deleted` / `gone`: the document in the newest `retained` line is forgotten; line `forgotten`, reason `deleted` |
| a message is edited | replaced (above); line `forgotten` `replaced`, then `retained` |
| a root gets its first reply | its own document is forgotten (`in_thread`) and the thread document is retained; the last reply deleted reverses it (`no_replies`) |
| a channel stops being a public channel of its team | `channel.channel.updated` for a channel that is no longer public marks every source of that channel the log says is in the bank; the drain forgets them (`not_team_visible`). An operator's SQL leaves no event: `memory.reconcile` (hourly) finds log lines whose channel is no longer public and marks them the same way. (Privacy never changes through the API: `channels_guard` — this is for the day it does, and for the operator.) A **rename** marks the channel's retained sources too: their documents say `in #name` and are replaced (within the per-team limit). |
| a page is edited, deleted or has no text any more | `repo.repo.committed` (any commit that touches a `pages/` path) / the index; an edit replaces the document (a pasted secret removed from a page is removed from the bank), a delete forgets it: reason `deleted` / `no_text` |
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

The lines are resolved by `app.memory_run_lines(run)`: a join on the primary key of `messages` / `files` with the ref turned into a uuid behind a shape guard — never `m.id::text = ref` (a scan of the table for every line, on every recall, retain, summary and authored verdict). `test/rls/plan.test.ts` EXPLAINs it over 30,000 messages and 10,000 files with hash and merge joins off and refuses a sequential scan (with a control that shows the cast column as one). It also answers the narrowest scope (`person` < `channel` < `team`), the number of lines and the scope labels they carried (stored on the log line as `source_scopes`). Lines labelled `team` for non-message, non-file sources (a memory bank, a team file) are team-visible by construction.

**Who reads it.** `memory.retain` (memory-hindsight) through `app.memory_run_scope()`, which now takes `retain_refusal` from the verdict instead of its own check (memory-hindsight 0002: same refusals, same order, same trust base, one step stricter as above; **nothing was weakened**: the person line, conversation trigger, private channel/thread and "never approval-gated" are all still there, and `memory.retain` stays refused for a run that is not provably team-visible). The feed's run summaries, and the approvals of a run. A person-scoped run retains only to `people/<asker>.md` (P5-26, `memory.write`), never here.

**What a bot wrote without being asked to retain it** (`app.memory_authored_verdict(bot actor, at)`): a message a bot posted or a page it wrote is team-visible where it was posted, but the run that wrote it may have read something narrower, and the bank must not carry it then (it would outlive and out-reach the run's own scope). The bot's runs that were open at that instant (±2 s: git dates have one-second resolution) decide: the first refusal wins, a run that has not closed makes the source wait (`defer`: its source log can still grow; a day later it is withheld as `run_open`), no run at all means the bot wrote it outside a run and it is an ordinary team message. A run that has not ended covers every instant since its start, however long it runs (`timeoutSeconds` has no maximum), and until it ends the source waits (`defer`; a source deferred for a day is withheld as `run_open`); no run that started more than a day before is looked for (`memory_bot_runs_started (bot_id, started_at)` makes it a range scan of one bot's day), so a lost worker holds a bot's text back for at most a day. A page is judged at both its git author date and the instant the index recorded it (`repo_commits.indexed_at`, the database's clock; repo-git 0002), so a clock that is not the database's cannot put it outside the run that wrote it; a commit indexed before that column existed has `indexed_at` NULL and is judged at its author date only (`coalesce(indexed_at, committed_at)`), never at the instant of the migration. A run whose worker died is closed by the bots plugin's hourly reaper (`bots.reap-runs`: `running` past the bot's `limits.timeoutSeconds` + 10 minutes, or 6 hours when none, closed `failed` through the run service so `bots.run.closed` is emitted), so a bot's output is not held back for the day the lookup reaches. A bot that no longer exists is refused as `bot_removed` (deleting a bot deletes its runs, so its earlier replies would otherwise read as "written outside a run" and a re-rendered thread would quote them). **An approved call re-runs in a new run, so that run starts having read what the stopped run had read** (`ctx.runs.inheritSources`: one set-based statement that copies every distinct line of the stopped run, no cap, and refuses — the call is not made — when it cannot): a `pages.write` or `messages.post` approved after a run read a person source is judged by that run. Correlating by time is conservative (two overlapping runs of one bot withhold each other's output) and needs no change to the channels plugin.

## When a document cannot be forgotten

A forget that fails is retried every half hour for as long as it takes: its work row stays, `last_error` says why, and one `failed` line (with the document id) is written when the eighth attempt fails. To see what is stuck, as the owner role:

```sql
SELECT source_kind, source_id, attempts, last_error, not_before
  FROM app.memory_feed_pending WHERE attempts >= 8 AND last_error <> '' ORDER BY requested_at;
```

If the engine is gone for good (a bank that no longer exists, an engine that was replaced) there is nothing left to forget, and an operator ends the retries and records it — the log is append-only, so the record is a line, not an edit:

```sql
SET ROLE manythreads_system;
BEGIN;
INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, channel_id, document_id, outcome, reason)
SELECT l.workspace_id, l.team_id, l.bank, l.source_kind, l.source_id, l.channel_id, l.document_id, 'forgotten',
       'cleared by an operator: the engine no longer holds it'
  FROM app.memory_feed_pending p
  JOIN LATERAL (SELECT * FROM app.memory_retain_log x
                 WHERE x.source_kind = p.source_kind AND x.source_id = p.source_id AND x.outcome IN ('retained', 'forgotten')
                 ORDER BY x.id DESC LIMIT 1) l ON l.outcome = 'retained'
 WHERE p.attempts >= 8 AND p.last_error <> '';
DELETE FROM app.memory_feed_pending WHERE attempts >= 8 AND last_error <> '';
COMMIT;
```

(Narrow the `WHERE` to one team or one source when only some banks are gone.) Nothing else ever drops a failing forget.

## memory_retain_log

`app.memory_retain_log` (migration 0001; PLAN A.5 `memory_retain_log`): `workspace_id`, `team_id`, `store` (`team_bank`; `person_file` is P5-26's), `bank`, `source_kind`, `source_id`, `channel_id?` (so a channel that stops being public finds its documents), `document_id?`, `content_hash?` (the keyed digest of the retained text: the text itself is never stored; a column, **not a field of the API shape** — the scanner of `secret-readback.spec.ts` rightly refuses any key called `*hash*`), `outcome` (`retained` \| `forgotten` \| `withheld` \| `not_configured` \| `failed`), `reason`, `run_id?`, `source_scopes[]`, `actor_id?`, `link`, `created_at`. **Append-only** (no UPDATE/DELETE for any role). The newest line of a source says what the bank holds for it. A private channel's or DM's messages leave **no** line (the id of a private message is not for a lead who is not in the channel), and neither does a run of a private conversation (one line per turn would be a log of who talks to which bot); runs that read a person or private source, approvals and bot-authored text in public channels do, which is SPEC §15's "what was withheld".

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
