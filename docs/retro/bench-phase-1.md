# Phase 1 week-1 benchmarks (P1-11)

Run with `pnpm --filter @manythreads/tools-bench bench:server` and `bench:list`. Sources: `tools/bench/src/server.ts`, `tools/bench/src/list.ts`, `tools/bench/list/`.

## Environment

- Sandbox: 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, Postgres in docker on the same host (shared with the benchmark client).
- PostgreSQL 19beta4 (Debian, `manythreads/postgres:19`), default config: shared_buffers 160 MB, work_mem 4 MB, max_parallel_workers_per_gather 2.
- Node 22, pg 8, Chromium 1194 (Playwright 1.56.1), React 19.

## 1. Server: 1,000,000 messages under FORCE RLS

Setup: fresh migrated database (`createTestDatabase`), bench-only schema `bench` with `bench_messages` shaped like A.3 `messages`
(uuidv7 id, workspace_id, team_id, channel_id, author_id, body, body_plain, created_at), 200 channels (about 5,000 messages each),
50 people, each a member of 20 channels (1,000 membership rows). `ENABLE` + `FORCE ROW LEVEL SECURITY`; the policy is
`channel_id IN (SELECT channel_id FROM bench_members WHERE person_id = app.person_id())`. Indexes: pkey, `(channel_id, id DESC)`,
GIN `gin_trgm_ops (body_plain)`. Table 282 MB, indexes 175 MB. Load 16-18 s (generate_series, 100k batches), btree 1 s, GIN 13 s.
Queries ran as `manythreads_app` through kernel `withActor` (BEGIN + set_config + query + COMMIT per call, included in the timings).
The actor is a real `app.actors` person row, so `app.person_id()` is exercised.

| Measure | p50 | p95 |
|---|---|---|
| Newest 50 in a member channel (200 runs) | 1.8-2.3 ms | 3.1-6.2 ms (two runs) |
| Search `ILIKE '%deploy%'` (4% of rows), `ORDER BY id DESC LIMIT 20`, 50 runs | 2.7-4.4 ms | 4.0-8.7 ms |
| Search medium term (4%), same query | 3.0-3.8 ms | 4.5-5.8 ms |
| Search rare term (0.05%, about 500 rows), same query | 131-139 ms | 177-224 ms |
| Search, `ORDER BY created_at DESC LIMIT 20` (any term) | 332-434 ms | 425-519 ms |

EXPLAIN (ANALYZE, BUFFERS) for newest-50: `Limit -> Index Scan using bench_messages_channel_id (Cond channel_id = ...)`, RLS subplan resolved as
`Index Scan using bench_members_person`; 57 shared buffers hit, execution 0.17-0.19 ms. The index is used, RLS adds negligible cost here.

Outbox (kernel `emit` from 8 concurrent app-pool writers, 4 subscribers, 4 `startConsumer` consumers on the system pool, batch 200,
no-op handler), 20,000 events = 80,000 deliveries: emit-only 700-770 events/s; end-to-end (last delivery done) 696-765 events/s
(about 2,800-3,060 deliveries/s), 26-29 s.

### Findings

- Newest-50 and a common-term search are comfortably fast with the member-channel RLS policy (single-digit ms).
- Trigram search is not reliably index-driven. With `ORDER BY id DESC LIMIT 20` the planner walks the pkey backward and filters; this is fast for
  common terms and slow (about 130 ms) for rare ones. With a different sort key it chose a Seq Scan (about 300-500 ms over 1M rows) rather than the GIN,
  because the RLS membership qual and the row estimate push it off the bitmap path. Before phase 3 ships search: scope search to one channel or team,
  or use a materialised accessible-channel list, and re-check the plan with the real policy. This is a tuning item, not a blocker, at 1M rows.
- Outbox throughput is bounded by `emit` itself (one transaction with 4 fan-out inserts + NOTIFY each): consumers keep up with the emit rate,
  so about 700 events/s per this 4-core box with the DB sharing the CPUs. Ample for the manythreads workload; no change required.
- Partitioning `messages` by month is not indicated by these numbers at 1M rows (the A.3 note "partition if the phase 1 benchmark says so"): do not partition.

## 2. Phone list: Chromium proxy (NOT the on-device benchmark)

The guide section 5.1 benchmark (React Native, 5,000 messages, mid-range Android device, p50/p95 frame time, JS/UI thread split, memory) **cannot run in this
sandbox**: there is no device or emulator. It is **deferred to the phase 11 gate**; the numbers below are a proxy that only informs it and
must not be recorded as the section 5.1 result.

Proxy: a hand-windowed (fixed 76 px rows, 6 rows overscan, about 18 mounted) React 19 list of 5,000 messages in Chromium at 390x844 (dpr 2, touch),
CDP `Emulation.setCPUThrottlingRate` 4, three programmatic 10 s top-to-bottom scrolls after a 2 s warm-up, frame times from `requestAnimationFrame`.
A frame counts as dropped above 25 ms. Verdict rule: p95 frame time < 17 ms and under 2% dropped frames (occasional drops allowed, per PLAN criterion 6); multi-frame stalls are reported separately.

| Throttle | avg fps | frame p50 / p95 / p99 | dropped | multi-frame stalls |
|---|---|---|---|---|
| x1 | 60.0 | 16.7 / 16.7 / 16.8 ms | 0.0% | 0 |
| x4 run A | 59.4 | 16.7 / 16.8 / 16.8 ms | 0.9% | 3 |
| x4 run B | 59.9 | 16.7 / 16.7 / 16.8 ms | 0.1% | 0 |

JS heap stayed flat (about 4-6 MB, no growth across scrolls). **60 fps (proxy): PASS** (p95 16.7-16.8 ms and 0.1-0.9% dropped in every clean run; a third run had 0.3% dropped, 1 stall), but the 0-3 multi-frame stalls per 30 s are noisy on a shared 4-core box. Treat as "windowing in React holds about 60 fps at 4x CPU slowdown with occasional stalls".
The first scripted runs while the server benchmark was running concurrently showed 56-58 fps; do not run the two together.

## Caveats

- Postgres is a beta build with default tuning, co-located with the load generator; absolute numbers will differ on the target k3s host.
- The data is synthetic (about 6-19 words per message from a 300-word list, uniform), so trigram selectivity is idealised.
- Only one actor (20 of 200 channels) was measured; a user in many more channels will pay more for the membership subplan.
- Chromium CPU throttling approximates, not equals, a mid-range Android SoC; React DOM windowing is not React Native (FlatList/FlashList, JS vs UI thread).
