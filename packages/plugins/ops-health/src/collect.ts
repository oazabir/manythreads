import { statfs } from 'node:fs/promises';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { PluginTx } from '@manythreads/sdk';
import type { OpsHealthSnapshot, OpsVolume } from '@manythreads/shared';
import { RUN_QUEUE, type VolumeSpec } from './config.ts';

// One pass over everything the health view and `/metrics` show. The database sections are cheap reads over partial indexes (the outbox's
// pending rows, the jobs that are ready or running, the pending approvals); they run in one system transaction, each inside a savepoint, so a
// section that fails (a table that is missing, a timeout) is reported as `null` and the others still answer.

export interface CollectOptions {
  /** Runs of different bots at once in one server process. */
  runSlotsLimit: number;
  /**
   * The count of dead jobs, read at most every few minutes by the caller (`DeadJobCounter`): no index covers them. Read it before the
   * transaction that `collectDatabaseSections` runs in, so that one pass never holds two database connections at once.
   */
  deadJobs: () => Promise<number | null>;
  /** Called with the name of a section that could not be read. */
  onSectionError?: (section: string, err: unknown) => void;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Runs `fn` inside a savepoint so a failing statement does not abort the surrounding transaction. */
async function section<T>(tx: PluginTx, name: string, opts: CollectOptions, fn: () => Promise<T>): Promise<T | null> {
  await tx.query('SAVEPOINT ops_health_section');
  try {
    const value = await fn();
    await tx.query('RELEASE SAVEPOINT ops_health_section');
    return value;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT ops_health_section');
    opts.onSectionError?.(name, err);
    return null;
  }
}

/** The database sections of a snapshot. Needs a system transaction (the outbox and jobs tables are the system role's alone). */
export async function collectDatabaseSections(
  tx: PluginTx,
  opts: CollectOptions,
): Promise<Pick<OpsHealthSnapshot, 'outbox' | 'jobs' | 'runs' | 'approvals' | 'budgets' | 'database'>> {
  const outbox = await section(tx, 'outbox', opts, async () => {
    const r = (
      await tx.query<{ backlog: number; retrying: number; oldest: number }>(
        `SELECT count(*)::int AS backlog,
                (count(*) FILTER (WHERE attempts > 0))::int AS retrying,
                coalesce(extract(epoch FROM now() - (min(available_at) FILTER (WHERE available_at <= now()))), 0)::float8 AS oldest
           FROM app.outbox WHERE done_at IS NULL AND dead_at IS NULL`,
      )
    ).rows[0];
    return { backlog: num(r?.backlog), retrying: num(r?.retrying), oldestAgeSeconds: Math.max(0, num(r?.oldest)) };
  });

  const queues = await section(tx, 'jobs', opts, async () =>
    (
      await tx.query<{ queue: string; ready: number; running: number; oldest: number }>(
        `SELECT queue,
                (count(*) FILTER (WHERE state = 'ready' AND run_at <= now()))::int AS ready,
                (count(*) FILTER (WHERE state = 'running'))::int AS running,
                coalesce(extract(epoch FROM now() - (min(run_at) FILTER (WHERE state = 'ready' AND run_at <= now()))), 0)::float8 AS oldest
           FROM app.jobs WHERE state IN ('ready', 'running') GROUP BY queue ORDER BY queue`,
      )
    ).rows,
  );
  const dead = queues === null ? null : await opts.deadJobs();

  const approvals = await section(tx, 'approvals', opts, async () => {
    const r = (
      await tx.query<{ pending: number; oldest: number }>(
        `SELECT count(*)::int AS pending,
                coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8 AS oldest
           FROM app.approvals WHERE status = 'pending'`,
      )
    ).rows[0];
    return { pending: num(r?.pending), oldestPendingAgeSeconds: Math.max(0, num(r?.oldest)) };
  });

  // Every dollar cap against what its scope has spent in the cap's window (UTC day or month), the way the gateway's own budget check sums it.
  const budgets = await section(tx, 'budgets', opts, async () => {
    const rows = (
      await tx.query<{ cap: number; spent: number }>(
        `SELECT l.limit_usd::float8 AS cap, coalesce(s.spent, 0)::float8 AS spent
           FROM app.llm_limits l
           CROSS JOIN LATERAL (
             SELECT sum(sp.cost_usd) AS spent FROM app.llm_spend sp
              WHERE sp.workspace_id = l.workspace_id
                AND sp.occurred_at >= (CASE l.budget_window WHEN 'month' THEN date_trunc('month', now() AT TIME ZONE 'UTC')
                                                            ELSE date_trunc('day', now() AT TIME ZONE 'UTC') END) AT TIME ZONE 'UTC'
                AND (l.scope = 'workspace' OR (l.scope = 'team' AND sp.team_id = l.team_id) OR (l.scope = 'bot' AND sp.bot_id = l.bot_id))
           ) s
          WHERE l.limit_usd IS NOT NULL AND l.limit_usd > 0 AND l.scope IN ('workspace', 'team', 'bot')`,
      )
    ).rows;
    return summariseBudgets(rows.map((r) => ({ cap: num(r.cap), spent: num(r.spent) })));
  });

  const database = await section(tx, 'database', opts, async () => {
    const r = (
      await tx.query<{ used: number; max: number }>(
        `SELECT count(*)::int AS used, current_setting('max_connections')::int AS max FROM pg_stat_activity WHERE backend_type = 'client backend'`,
      )
    ).rows[0];
    return { connectionsUsed: num(r?.used), connectionsMax: num(r?.max) };
  });

  const jobs =
    queues === null
      ? null
      : {
          ready: queues.reduce((n, q) => n + num(q.ready), 0),
          running: queues.reduce((n, q) => n + num(q.running), 0),
          dead: dead ?? 0,
          oldestReadyAgeSeconds: Math.max(0, ...queues.map((q) => num(q.oldest))),
          queues: queues.filter((q) => num(q.ready) > 0).map((q) => ({ queue: q.queue, ready: num(q.ready), oldestAgeSeconds: Math.max(0, num(q.oldest)) })),
        };

  // A run in progress holds one running job of the run queue; a run waiting for a slot is a due job of that queue.
  const runQueue = queues?.find((q) => q.queue === RUN_QUEUE);
  const runs =
    queues === null
      ? null
      : {
          slotsUsed: num(runQueue?.running),
          slotsLimit: opts.runSlotsLimit,
          queued: num(runQueue?.ready),
          oldestQueuedAgeSeconds: Math.max(0, num(runQueue?.oldest)),
        };

  return { outbox, jobs, runs, approvals, budgets, database };
}

/** How full the model budgets are: the count with a dollar cap, those at 80 % or more, those used up, and the fullest in percent. */
export function summariseBudgets(rows: ReadonlyArray<{ cap: number; spent: number }>): NonNullable<OpsHealthSnapshot['budgets']> {
  let nearLimit = 0;
  let exhausted = 0;
  let max = 0;
  for (const { cap, spent } of rows) {
    if (cap <= 0) continue;
    const burn = (spent / cap) * 100;
    if (burn >= 80) nearLimit += 1;
    if (burn >= 100) exhausted += 1;
    max = Math.max(max, burn);
  }
  return { limits: rows.filter((r) => r.cap > 0).length, nearLimit, exhausted, maxBurnPercent: round(max) };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** How full each configured volume is. A path that cannot be read is left out (and `onError` told), never reported as empty. */
export async function collectVolumes(specs: readonly VolumeSpec[], onError?: (name: string, err: unknown) => void): Promise<OpsVolume[]> {
  const out: OpsVolume[] = [];
  for (const spec of specs) {
    try {
      const s = await statfs(spec.path);
      const total = s.blocks * s.bsize;
      // `bavail` is what an unprivileged writer can still use; the share used is measured against what it could ever use.
      const free = s.bavail * s.bsize;
      const usable = total - (s.bfree - s.bavail) * s.bsize;
      const usedPercent = usable > 0 ? Math.min(100, Math.max(0, ((usable - free) / usable) * 100)) : 0;
      out.push({ name: spec.name, totalBytes: total, freeBytes: free, usedPercent: round(usedPercent) });
    } catch (err) {
      onError?.(spec.name, err);
    }
  }
  return out;
}

/** Starts the event-loop delay histogram (20 ms resolution). Call once; `snapshotLoopLag` reads and clears it. */
export function startLoopMonitor(): IntervalHistogram {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return h;
}

/** The 99th percentile of the event-loop delay since the last read, in seconds; clears the histogram. */
export function readLoopLagSeconds(h: IntervalHistogram | null): number {
  if (!h || h.count === 0) return 0;
  const p99 = h.percentile(99) / 1e9;
  h.reset();
  return Number.isFinite(p99) ? p99 : 0;
}

/** The process's own numbers. */
export function collectProcess(loop: IntervalHistogram | null): OpsHealthSnapshot['process'] {
  const mem = process.memoryUsage();
  return {
    residentBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    eventLoopLagP99Seconds: readLoopLagSeconds(loop),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

/**
 * Counts dead jobs (given up on after their last attempt). No index covers that state, so the count is read at most every `everyMs` and the
 * last answer is reused in between.
 */
export class DeadJobCounter {
  private at = 0;
  private value: number | null = null;
  constructor(
    private readonly read: () => Promise<number>,
    private readonly everyMs = 5 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}
  async get(): Promise<number | null> {
    const now = this.clock();
    if (this.value !== null && now - this.at < this.everyMs) return this.value;
    try {
      this.value = await this.read();
      this.at = now;
    } catch {
      // keep the last answer; the next call tries again
    }
    return this.value;
  }
}
