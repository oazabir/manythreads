# ops-health

The server's way of watching itself: a token-gated `/metrics` page for a monitoring system, a once-a-minute watcher that tells the workspace's owners and admins when something is wrong, and a read-only **System health** panel (PLAN P10-10, SPEC §10.1). How to scrape it and the limits: [deploy/monitoring.md](../deploy/monitoring.md).

Package: `packages/plugins/ops-health`. Manifest: `extends: ['event.emit', 'job.register']`, `dependsOn: ['approvals', 'gateway-llm']`, emits `ops.health.changed`. No tables and no migration. Schemas: `packages/shared/src/{api/ops,events/ops.health.changed.ts}`.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /metrics` | a caller holding `MANYTHREADS_METRICS_TOKEN` as a bearer token | Prometheus text. `404` when no token (16 characters or more) is configured; `401` on a missing or wrong token. Never public, and the web pod does not pass it on. |
| `GET /api/admin/health` | workspace owner or admin (`403` for a member, `401` signed out) | `{ snapshot, checks }`: every number and the verdict of each check. The System health panel reads this. |

## How a round works

1. The `ops-health.tick` job runs every minute (cron, so one server process takes each round).
2. It reads the numbers from the database (the outbox, the queue of events written with a change and not yet passed on, counting only rows still waiting and not those given up on; the job queue; approvals; budgets; `pg_stat_activity`, the server's list of open connections), the process and the volumes. Each database part is read inside its own savepoint (a rollback point within the transaction, so one failing query leaves the others alone): if one fails, only that part is missing, and its checks keep their last verdict instead of guessing.
3. It judges each check against its limit and compares with what it remembered for the workspace (plugin storage, key `health-state`).
4. A check that has just tripped writes one `ops.health.changed` event (`state: breached`) and queues one mail. A check that has been fine for several rounds in a row writes one event (`state: recovered`) and one mail. Nothing is written while a state does not change.

The mail goes out in a separate job (`ops-health.mail`) to the workspace's owners and admins who are active people; a slow mail server never holds the round. If nobody can be reached, the job fails and is retried a few times. The job trusts nothing in its payload but numbers: it writes the words itself from the check's name, and sends only when the state the watcher stored for that workspace agrees with the payload, so a job enqueued by anything else cannot put its own text into a mail from this server.

## Why events and mail, not a channel message

A channel needs a team and a message needs a poster, and there is no system channel to post to. Adding one would be a schema change for little gain, so the alert is the audit event, the mail and the panel. If a system channel is added later, the watcher announces in `announce()` (`src/watcher.ts`) and nothing else changes.

## Rules to keep

- `/metrics` stays behind the token. Do not add it to the web proxy.
- Metric labels stay few and fixed (`queue`, `volume`, `check`, `section`): never a user, team, bot or run id.
- The numbers come from one place (`monitor.measure()`), shared by `/metrics`, the panel and the watcher, so they cannot disagree.
- The mail job never takes its text from the payload (`sendAlertMail` in `src/watcher.ts`).
- The outbox numbers skip rows with `dead_at` set: a row the outbox gave up on never ages out, so counting it would hold the lag check tripped for ever.
- Dead jobs are counted at most every five minutes (no index covers them). Add an index in the kernel before making that faster.
- A new check is one entry in `evaluate.ts`, one setting in `config.ts`, one line in the docs table.
