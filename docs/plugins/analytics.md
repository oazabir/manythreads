# analytics

The `analytics` plugin counts what the platform already records (a model call's cost, a bot run that ended, a tool call, an approval, an answer, a knowledge document a run reached, a sign-in) into a monthly-partitioned time-series table, adds it up per day, and serves the usage pages: workspace, team, bot and Brain quality. It stores **counts, ids and amounts only, never what anyone wrote, asked, answered or read** (PLAN P8-11, SPEC §10.1, Appendix A.7).

Package: `packages/plugins/analytics`. Manifest: `extends: ['event.subscribe', 'job.register']`, `dependsOn: ['bots', 'gateway-llm', 'approvals']`, emits nothing. Migration: `0001_analytics.sql` (the PLAN's "0062" is the global count; migration numbers are per plugin). Schemas: `packages/shared/src/{entities/analytics.ts, api/analytics}`. No other plugin was changed: the live numbers come from events that already exist, the rest from a read of tables that already exist.

## What is counted

| Metric | Source | Value | Label (kept apart in the daily rows) |
|---|---|---|---|
| `run.count` | event `bots.run.closed` | 1 | `status` (done, failed, stopped) |
| `approval.requested` / `approval.decided` | events `approvals.approval.requested` / `.decided` | 1 | `source` / `decision` |
| `approval.wait_seconds` | the decided event plus the approval's two times | seconds | `decision` |
| `answer.scoped` / `answer.full` | event `answer.answer.posted` (scoped: someone asked; full: nobody asked, e.g. a routine) | 1 | none |
| `answer.citations`, `answer.dropped`, `answer.reached` | the same event | the event's counts | none |
| `signin.ok` / `signin.failed` | events `identity.session.signed_in`, `identity.oidc.signed_in`, `identity.session.sign_in_failed` | 1 | `method` / `reason` |
| `llm.cost_micro`, `llm.tokens` | table `llm_spend` (the gateway's ledger) | millionths of a dollar / tokens | `alias` |
| `tool.call` | table `run_decisions` where `kind = 'tool'` | 1 | `outcome` (allowed, needs_approval, denied) |
| `knowledge.hit` | table `run_source_log` where `source_type = 'knowledge'` | 1 | `scope` |

Rows with a team carry `team_id` and `bot_id`. A sign-in belongs to a person, not to a team, so it carries `actor_id` instead and has no team (a CHECK refuses a row with both). The `answer.answer.posted` event carries no team (an answer to a private conversation is that person's), so the team is looked up from the run's own row.

### Content-blind

* The emitters read ids, outcomes, counts and fixed words from an event. A lookup (the run's team, an approval's two times, a person's actor) takes an id or a time, never text.
* `dims` keeps only short plain labels: a key of letters, and a value that is a string of at most 80 characters, a finite number or a boolean. The table refuses a `dims` that is not an object or is over 1000 bytes, and a metric name that is not `word.word`.
* The tests store canary text in the event fields a person could have written (an IP, a session id, a model name, a document reference) and check that none of it reaches a row.

## Tables (`0001_analytics.sql`)

| Table | What | RLS |
|---|---|---|
| `analytics_events` | one row per counted thing; **monthly range partitions** `analytics_events_YYYY_MM` on `occurred_at`; primary key `(id, occurred_at)`; BRIN on `occurred_at`; btree on `(workspace_id, metric, occurred_at)`, `(team_id, …)`, `(bot_id, …)`; GIN `dims jsonb_path_ops` | team (forced) |
| `analytics_daily` | the events added up per UTC day, team, bot, metric and one label | team (forced) |
| `analytics_progress` | how far each sweep has read (a name and a text value) | system only |

**Who reads what** (the same policy on both big tables): a workspace owner or admin reads every row of their workspace; a team member reads the rows of the teams they can read, **except money** (metrics starting `llm.`, which is the admin-only ledger `llm_spend` says it is); a guest reads nothing; one workspace never sees another. Only the system role writes; no role may update, delete or truncate an event (the privilege is revoked, on the parent and on every partition). The app role has SELECT on the two big tables only, and no privilege on a partition directly.

**Deviations from Appendix A.7** (A.7 is a sketch; these are the shape that works):

* `analytics_daily` has a surrogate `id` primary key and an extra `dim` column (one label per metric, `''` when the metric has none), because a day's spend per model alias, or runs per status, must stay apart. The A.7 primary key `(day, workspace_id, team_id, bot_id, metric)` becomes a `UNIQUE … NULLS NOT DISTINCT` index on `(workspace_id, day, metric, dim, team_id, bot_id)`, because a key cannot hold NULL and a row with no team or no bot is common. The rollup's `ON CONFLICT` names that index's columns.
* `actor_id` exists on `analytics_events` for the team-less sign-in rows only (the CHECK above).
* A.7 says "RLS T on team_id"; the `llm.` rule above is added so a team member cannot read dollars the workspace keeps admin-only.

## Partitions

Two `SECURITY DEFINER` functions, owned by the migrating role (making or detaching a partition needs to own the parent), executable by the system role only, whose only input is a date:

* `app.analytics_ensure_month(month, oldest)` returns whether a partition exists for the month, making it under an advisory lock when it does not. It refuses a month older than the kept window or more than three months ahead (a clock gone wrong makes no partitions) and answers `false`. A new partition gets forced RLS, a system-only policy, no privilege for the app role and no UPDATE, DELETE or TRUNCATE for the system role.
* `app.analytics_detach_before(date)` detaches (never drops) every partition whose month ended on or before the date, renames it `…_detached_<timestamp>` and comments it as system-only. An operator exports and drops it by hand.

The migration makes the current month and the next two. Every write calls `analytics_ensure_month` for its months first, so a late event never fails for a missing partition (and never poisons the transaction the other subscribers share). A one-day query names constant bounds and therefore scans one partition (tested with `EXPLAIN`).

## Jobs

| Queue | Cron (UTC) | Does |
|---|---|---|
| `analytics.partitions` | `17 2 * * *` | ensures this month and the next two |
| `analytics.sweep` | `*/5 * * * *` | reads `llm_spend`, `run_decisions`, `run_source_log` from where it stopped (less a 10-minute overlap) and stores new rows under ids made from the source row, `ON CONFLICT DO NOTHING`; the first run on a deployment with history reads the last 35 days |
| `analytics.rollup` | `7 * * * *` | adds yesterday and today up into `analytics_daily` with `ON CONFLICT … DO UPDATE`; after downtime it starts at the last day it finished, and on a first run at the oldest event |
| `analytics.retain` | `37 3 * * *` | rolls up any day about to leave, then detaches months older than the window |

Every step can run twice: a row's id comes from its source (the event id and metric, or the source row's keys), and the rollup rewrites its days from the events.

## The usage pages

| API | Who | Page |
|---|---|---|
| `GET /api/workspace/usage?days=` | workspace owners and admins (403 otherwise) | Settings → Usage |
| `GET /api/teams/:slug/usage?days=` | members of the team and admins (403 for an unseen team); money only for an admin | Settings → team → Usage; its table links to each bot |
| `GET /api/teams/:slug/bots/:botSlug/usage?days=` | the same; an unknown bot and a bot of another team both answer 404 | the bot page's **Usage** button (not a fifteenth tab: the fourteen are fixed by SPEC §7.2) |

`days` is 1 to 366 (default 30; the page offers 7, 30, 90 and a year). A page reads `analytics_daily` for the days before yesterday and `analytics_events` for yesterday and today, so it is live and never waits for the next rollup. Days are UTC calendar days. A reader who may not see money gets `null` money fields (shown as "Admins only"), never a zero. **Brain quality** is the answer counts (cited, held back from the asker, looked at, knowledge used) of the team's `brain` bot; a team without one gets the numbers of all its answers and the page says so. The budget bar reads `llm_limits` and `llm_spend` directly, the same rows the gateway enforces against, so the bar and the refusal agree.

The charts are plain CSS columns using the colour tokens (no chart library).

## Settings

* `MANYTHREADS_ANALYTICS=off` stops the live writers and the sweeps (the pages show what was kept). Anything else is on: counting changes nothing about what it counts.
* `MANYTHREADS_ANALYTICS_EVENT_MONTHS` (default 14, 2 to 120): calendar months of detailed events kept; the daily rows are never removed.

## Tests

* `packages/plugins/analytics/test/rls/analytics.test.ts`: the RLS harness, who reads which rows (admin, team members, a lead who is not an admin, a guest, another workspace), who writes, the CHECKs, the partition rollover (made on demand, refused outside the window, detached and renamed with its rows kept and its lock-down intact) and the one-partition plan.
* `packages/plugins/analytics/test/analytics.test.ts`: a real server and the real outbox: the emitters, the sweep (idempotent), the rollup (idempotent), the three routes as different people, older days read from the daily rows, content-blindness, retention.
* `packages/plugins/analytics/test/units.test.ts` and `clients/web/test/usage-format.test.ts`: the pure parts.
* Not yet written: the browser specs `e2e/usage/usage-pages.spec.ts` and `e2e/api/analytics/partitions.spec.ts` named in PLAN.
