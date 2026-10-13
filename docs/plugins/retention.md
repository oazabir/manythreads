# retention

Run logs are kept for a window and then pruned; **the audit trail never is** (SPEC §15, PLAN P5-14). One plugin, one daily sweep, small batches, a dry-run mode, and a window each workspace chooses within bounds.

Package: `packages/plugins/retention`. Manifest: `extends: ['event.emit', 'job.register']`, `dependsOn: ['bots', 'memory', 'approvals']`, emits `retention.sweep.completed` and `retention.settings.changed`. Schemas: `packages/shared/src/{entities/retention,api/retention,events/retention.*}`.

## What is pruned, and what never is

| Pruned | When | How |
|---|---|---|
| `bot_runs` (an ended run: status not `running`, `ended_at` set) | older than the workspace's **run-log window** (default 90 days, 30 to 3650) | deleted by id in batches; `run_source_log` and `mcp_run_tokens` go with them (foreign key cascade); `approvals.run_id` and `memory_retain_log.run_id` become NULL (the foreign keys' own SET NULL) |
| `memory_retain_log`: attempt notes (`not_configured`, `failed`) and lines a newer `retained` / `forgotten` line of the same source has superseded | older than the workspace's **memory-log window** (default 365 days, 90 to 3650) | `app.memory_retain_log_prune`, a page at a time, keyset-paged |
| `memory_run_memo` of a bot that no longer exists | at the sweep | deleted in batches |

| Never pruned | Why |
|---|---|
| `events` (and everything an auditor export reads from it), `outbox`, `jobs` | the audit trail. The system role has no UPDATE or DELETE on `events`, and no code here names it. The sweep's own result is an event. Delivery state (`outbox`, `jobs`) is the kernel's: no retention policy yet (open) |
| `approvals` and `approval_decisions` | who decided what is an action record (SPEC §15); the Approvals inbox's history. Not pruned by default and not configurable here (a workspace that wants it later gets a third window, and a memo for the feed — see below) |
| `llm_spend` | the money ledger is append-only for every role |
| `memory_retain_log` lines `withheld` | SPEC §15's "what was withheld" record: one per source and reason, bounded by the feed's volume |
| the newest `retained` / `forgotten` line of every source | it says what the bank holds, so a later edit finds the document to replace and a delete finds the document to forget |
| a run still `running`; a run a **pending** approval (or an approved one not yet finished) was filed from | the approval's resume copies the run's source log (`ctx.runs.inheritSources`) |
| `memory_run_memo` of a bot that exists | it is what keeps a withheld bot message withheld (below) |
| documents in the memory bank, the team repo, pages, files | retention is about logs, not about memory: the run summary document of a pruned run stays in the bank |

> **Open, for the owner:** `run_source_log` is today the only record of "what a run reached" (SPEC §15's audit store is the `audit` plugin, phase 10). Pruning it at 90 days is PLAN's rule and the default; a workspace can raise it to ten years, and the deployment keeps it at `dry-run` until an operator says `on`.

## Mode and windows

* **The deployment** (`MANYTHREADS_RETENTION`): `dry-run` (the default; counts, reports and deletes nothing) | `on` (deletes) | `off` (does not even count). Anything else, empty or misspelt, is `dry-run`: only the word `on` deletes, as for the blob garbage collector. `MANYTHREADS_RETENTION_BATCH` (runs per step, default 500, 1 to 5,000; the log page is four times that).
* **The workspace** (`app.retention_settings`, `GET`/`PUT /api/workspace/retention`, workspace owners and admins only): `runLogDays` 30..3650 and `memoryLogDays` 90..3650. A value outside the bounds is **refused (400), never clamped**; the table has the same CHECKs. The floor of 30 days keeps the window above the platform's own clocks (approvals expire in 7 days, a run's verdict looks back a day). A change is an audited event (`retention.settings.changed`: who, from, to).
* `POST /api/workspace/retention/preview` queues a **dry run** for the workspace whatever the mode is (409 when the mode is `off`); its counts appear as `lastSweep` and as an event.

## The sweep

`retention.sweep` (cron `7 3 * * *`, UTC) starts one chain of `retention.prune` jobs per workspace, deduplicated per workspace and day. **Each step is one transaction** that does at most one batch and enqueues the next step with the state it reached (`phase`, `cursor`, running counts; the cutoffs are fixed when the sweep starts, so every step judges against the same instants). A backlog of a million runs is thousands of short transactions, never one long lock; a step that fails is retried from the state it was given, and the state advances only in the transaction that did the work.

1. **runs** — ended runs older than the cutoff, oldest first, keyset-paged on `(ended_at, id)` (the cursor carries the timestamp as text, so microseconds are exact). For each batch: `app.memory_memoize_runs(ids)` first, then the delete, in the same transaction.
2. **log** — `app.memory_retain_log_prune(workspace, cutoff, cursor, limit, dry_run)`.
3. **memos** — memos of removed bots.

A mode of `dry-run` turns a queued real sweep into a dry run (a deployment that left `on` never deletes under a mode that did not ask for it); `off` stops a sweep in the middle. The result is `retention_settings.last_sweep`, a job log line with the counts, and the audit event `retention.sweep.completed` (workspace, sweep id, dry run, cutoffs, counts, duration — never an id or a line of what was removed). A dry run does everything except the memo and the delete and counts what it would have done (`runMemos` is 0 in a dry run).

## The feed's verdict

The memory feed decides what to do about something a bot wrote (a message, a page, a concept) from the bot's runs **by time window** (`app.memory_authored_verdict`): a run that read a person source makes what the bot wrote inside it unretainable. Delete the run and the verdict would become "the bot wrote it outside a run": the message withheld at 10:02 would be quoted in the thread document the next time a person replies to it, 91 days later. So the feed's verdict must not depend on rows retention removes:

* **Memo first** (`memory` 0002). In the transaction that deletes a batch of runs, `app.memory_memoize_runs` leaves a row in `app.memory_run_memo` — run id, bot, window, refusal, the approvals filed from the run; never its source lines — for each run that still matters: one with a refusal that applies to something the bot authored in its window (a message in a public channel, a commit), one a retained document of the feed derives from (`source_kind = 'run'`), or one an approval was filed from. A run that read only the team's sources and wrote nothing leaves nothing. A run that read private things but wrote nothing team-visible leaves nothing either (a DM chat is not worth a row).
* **One set.** `app.memory_authored_verdict` reads live runs and memos as one set with the same window rules, so its answer is the same before and after a prune. Memos are kept as long as their bot exists (a removed bot's verdict is `bot_removed` for everything, and the sweep removes its memos).
* **Documents outlive the run.** `resolveRun` answers `skip('pruned')` for a run that has a memo, so a re-read never forgets the run's summary from the bank because its log is gone; a run gone any other way (its bot removed) still forgets it.
* **Approvals fail closed.** `approvals.run_id` is SET NULL when the run goes. `resolveApproval` reads `had_run` (set by trigger at insert): a run-less approval that had a run takes its verdict from the memo (found by `approval_ids`), and one with no memo cannot be judged and is withheld as `run_gone`. "No run" is never read as "a run that read nothing".
* A memo is a snapshot of `app.run_retain_verdict` at prune time; the refusal is never relaxed later (privacy does not change through the API, and a source that vanished reads as private — conservative).

## Door and policies

The system role has no DELETE on the append-only retain log and gains none: `app.memory_retain_log_prune` is a SECURITY DEFINER function **owned by the migrating role** with a SELECT and a DELETE policy of its own `TO manythreads_owner`; `manythreads_system` may execute it and nothing more. The bots plugin gave `bot_runs` and `run_source_log` no DELETE policy (a bot's removal cascades through the foreign key, which is not subject to row level security); retention's migration adds one for the system role, and the request role has no DELETE privilege on either table.

## Tests

* `test/config.test.ts` — `on` is the only word that deletes; the batch bounds.
* `test/sweep.test.ts` — against a real database: which runs go (window edge, running, pending / approved-unfinished / settled approvals), source lines and tokens cascade, a dry run, batches and cursors, per-workspace windows, the bounds the table refuses; the verdict survives a prune (with a control that shows it does not without the memo), pages judged the same way, no memo for a run that does not matter, memos for a held document and an approval, memos of removed bots; the retain log (what goes, what never goes, paging, still no DELETE for the system role, a different window).
* `test/retention.test.ts` — through the real server: who may read and change the windows (200 / 403 / 401), bounds refused (400), the audit events (none for a no-op change), a dry run that deletes nothing, the daily job with the mode `on` pruning exactly what is outside the workspace's window, `off`, the audit trail untouched.
* `packages/plugins/memory/test/feed-drain.test.ts` ("after retention pruned the run") and `test/rls/memo.test.ts`; `packages/shared/test/events/phase5-retention-contracts.test.ts`.

## Not here (open)

* `app.jobs`, `app.outbox`, `app.outbox_processed` and `app.events` have no policy: events never (the audit trail); jobs and outbox are the kernel's delivery state and grow without bound.
* Decided approvals are not pruned (see above); a window for them needs the memo to carry what `resolveApproval` reads.
* Revoked pairing tokens, expired sessions: identity's and bots' own housekeeping.
* The Workspace → Retention screen (the routes are ready).
