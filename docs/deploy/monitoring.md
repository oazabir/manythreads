# Monitoring

manythreads watches itself in two ways: a **`/metrics` page** for a monitoring system (Prometheus and friends), and a **built-in watcher** that tells your workspace's owners and admins when something goes wrong, with no monitoring system at all. Both come from the `ops-health` plugin ([plugins/ops-health.md](../plugins/ops-health.md)).

## The `/metrics` page

`GET /metrics` on the server (port 3000) answers the Prometheus text format.

- **It needs a token.** Send `Authorization: Bearer <token>`. No token, or a wrong one, gets `401`. If no token is configured on the server (or it is shorter than 16 characters) the page answers `404`, as if it did not exist. It is never open.
- **The token** is the environment variable `MANYTHREADS_METRICS_TOKEN`. The Helm chart makes it for you, once, and keeps it: secret `manythreads-server-secrets`, key `metrics-token` (40 random characters). It appears on the next `helm upgrade`. Read it with:

  ```sh
  kubectl -n <namespace> get secret manythreads-server-secrets -o jsonpath='{.data.metrics-token}' | base64 -d
  ```

- **Where it is reachable.** Only inside the cluster: the web pod's nginx passes `/api`, `/healthz`, `/readyz`, `/ws` and `/mcp` to the server and nothing else, so `/metrics` is not on the public address. Scrape the server service directly: `manythreads-server.<namespace>.svc.cluster.local:3000`.
- **It is cheap.** The numbers are taken from the database at most once every five seconds, however many scrapers ask. Rate limit: 120 requests a minute.

Example scrape job (a Prometheus that reads the token from a file):

```yaml
scrape_configs:
  - job_name: manythreads
    metrics_path: /metrics
    scrape_interval: 30s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/manythreads-metrics-token
    static_configs:
      - targets: ['manythreads-server.manythreads.svc.cluster.local:3000']
```

### What is in it

All names start with `manythreads_`. Labels are few and fixed (no user, team or bot names), so the page stays small.

| Metric | Meaning |
|---|---|
| `outbox_backlog`, `outbox_retrying` | changes written and not yet handed to every subscriber; how many of those have failed at least once |
| `outbox_oldest_age_seconds` | the **outbox lag**: age of the oldest change still waiting |
| `jobs_ready`, `jobs_running`, `jobs_dead` | background jobs waiting for a worker, running, given up on |
| `jobs_oldest_ready_age_seconds` | age of the oldest job that is due and not yet taken |
| `jobs_queue_ready{queue}`, `jobs_queue_oldest_age_seconds{queue}` | the same per queue (only queues that have waiting jobs) |
| `run_slots_used`, `run_slots_limit` | bot runs in progress, and the limit of runs at once (`MANYTHREADS_RUN_CONCURRENCY`, default 6, per server process) |
| `runs_queued`, `runs_oldest_queued_age_seconds` | bot runs waiting for a slot |
| `approvals_pending`, `approvals_oldest_pending_age_seconds` | approvals nobody has decided |
| `budget_limits`, `budget_limits_near`, `budget_limits_exhausted`, `budget_burn_ratio_max` | model budgets with a cap; at 80 % or more; used up; the fullest one (0 to 1 and above) |
| `db_connections_in_use`, `db_connections_max` | database connections open, and the server's limit |
| `process_resident_memory_bytes`, `process_heap_used_bytes` | server memory |
| `event_loop_lag_p99_seconds` | how late the server's timers fire (99th percentile of the last stretch); a busy or blocked server shows here |
| `process_uptime_seconds` | seconds since the server started |
| `volume_total_bytes{volume}`, `volume_free_bytes{volume}`, `volume_used_ratio{volume}` | the attachment store (`blobs`) and the team repositories (`repos`); more with `MANYTHREADS_OPS_VOLUMES=name=/path,...` |
| `health_check_breached{check}` | 1 while the built-in watcher counts the check as breached, else 0 |
| `ops_section_ok{section}` | 0 when one part of the numbers could not be read (its other metrics are then left out) |
| `ops_scrape_timestamp_seconds` | when the numbers were taken |

> **Volumes are the node's disk.** A local-path volume reports the whole node filesystem, so `volume_used_ratio` is the node's disk, which is what runs out first (a full node disk once evicted pods). With S3 for attachments the `blobs` volume is left out.

## The built-in watcher

Once a minute the server judges the numbers above against these limits. Set them in the server's environment (Helm: `server.env`). `0` switches a check off.

| Check | Trips when | Variable | Default |
|---|---|---|---|
| Volume | a volume is fuller than | `MANYTHREADS_ALERT_VOLUME_PERCENT` | 85 (percent) |
| Outbox lag | the oldest waiting change is older than | `MANYTHREADS_ALERT_OUTBOX_LAG_SECONDS` | 60 |
| Oldest job | the oldest due job has waited longer than | `MANYTHREADS_ALERT_JOB_AGE_SECONDS` | 600 |
| Run slots | all slots are taken **and** runs are queued, for longer than | `MANYTHREADS_ALERT_RUN_SLOTS_SECONDS` | 600 |
| Approval | the oldest pending approval is older than | `MANYTHREADS_ALERT_APPROVAL_HOURS` | 24 |
| Model budget | the fullest budget is used to | `MANYTHREADS_ALERT_BUDGET_PERCENT` | 90 (percent) |
| Database | connections in use reach | `MANYTHREADS_ALERT_DB_CONNECTIONS_PERCENT` | 90 (percent of the limit) |

Other switches: `MANYTHREADS_ALERTS=off` (no events or mail; `/metrics` and the panel still work), `MANYTHREADS_ALERT_MAIL=0` (events and panel, no mail), `MANYTHREADS_ALERT_RECOVER_ROUNDS` (quiet minutes in a row before "back to normal"; default 3).

**What you get.** One message when a check trips and one when it clears. A check that stays tripped does not repeat, and one that flaps does not clear until it has been fine for several rounds in a row. Each message is:

- a mail to the workspace's owners and admins (needs working mail: [deploy.md](../deploy.md)),
- an `ops.health.changed` event in the audit trail,
- and the **Workspace settings > System health** panel (admins only), which shows every number and check at any time. The same data: `GET /api/admin/health`.

## Example Prometheus alert rules

Use these if you run Prometheus; they say the same as the built-in limits, so the two agree.

```yaml
groups:
  - name: manythreads
    rules:
      - alert: ManythreadsDown
        expr: up{job="manythreads"} == 0
        for: 2m
      - alert: ManythreadsVolumeFull
        expr: manythreads_volume_used_ratio > 0.85
        for: 5m
      - alert: ManythreadsOutboxLag
        expr: manythreads_outbox_oldest_age_seconds > 60
        for: 2m
      - alert: ManythreadsJobsStuck
        expr: manythreads_jobs_oldest_ready_age_seconds > 600
        for: 1m
      - alert: ManythreadsRunSlotsSaturated
        expr: manythreads_run_slots_used >= manythreads_run_slots_limit and manythreads_runs_queued > 0
        for: 10m
      - alert: ManythreadsApprovalWaiting
        expr: manythreads_approvals_oldest_pending_age_seconds > 24 * 3600
      - alert: ManythreadsBudgetNearlyUsed
        expr: manythreads_budget_burn_ratio_max > 0.9
      - alert: ManythreadsDatabaseConnections
        expr: manythreads_db_connections_in_use / manythreads_db_connections_max > 0.9
        for: 5m
      - alert: ManythreadsEventLoopSlow
        expr: manythreads_event_loop_lag_p99_seconds > 1
        for: 5m
      - alert: ManythreadsDeadJobs
        expr: increase(manythreads_jobs_dead[1h]) > 0
```

## Logs

The server logs one JSON object per line on standard output (Fastify's logger, `pino`). Fields:

| Field | Meaning |
|---|---|
| `level` | number: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal |
| `time` | milliseconds since 1970 |
| `msg` | the message |
| `reqId` | the request id; on request lines `req` and `res` also carry method, URL and status, and `responseTime` is in milliseconds |
| `pid`, `hostname` | the process |

Request addresses are cleaned before they are written: the one-time token in an embedded-app address and anything odd after `/api/mcp/runs/` is replaced by `[redacted]`. Useful filters: `level >= 40` for trouble; one `reqId` for everything a single request did.
