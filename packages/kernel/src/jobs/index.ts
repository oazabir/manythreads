import type pg from 'pg';
import { toJob, getSystemPool, withSystem, type Tx, type JobRow } from '../db/index.ts';
import { backoffMs, listen, sleepUnlessWoken } from '../outbox/listen.ts';
import { latestSlot, parseCron } from './cron.ts';

export { cronMatches, latestSlot, parseCron } from './cron.ts';

export type Job = ReturnType<typeof toJob>;

export interface EnqueueOptions {
  runAt?: Date;
  /** While a job with this key is ready or running in the queue, enqueue returns it instead of adding another. */
  dedupeKey?: string;
}

/**
 * Adds a job in the caller's transaction (it becomes visible, and workers are notified, at commit). `jobs` is
 * system-only, so the insert goes through the SECURITY DEFINER function app.enqueue_job, which does a fixed
 * get-or-create on the dedupe index and never elevates the caller's transaction.
 */
export async function enqueue(
  tx: Tx,
  queue: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<Job> {
  const res = await tx.query<JobRow>('SELECT * FROM app.enqueue_job($1, $2::jsonb, $3, $4)', [
    queue,
    JSON.stringify(payload ?? {}),
    options.runAt ?? null,
    options.dedupeKey ?? null,
  ]);
  return toJob(res.rows[0] as JobRow);
}

export interface JobContext {
  jobId: string;
  /** 1 on the first run. Use `processedOnce`-style keys on the job id for exactly-once effects. */
  attempt: number;
  workerId: string;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void> | void;

export interface WorkerOptions {
  queue: string;
  handler: JobHandler;
  workerId: string;
  /** Jobs in flight at once (default 1). */
  concurrency?: number;
  pollMs?: number;
  /** Lease length; heartbeats renew it every leaseMs/3 (default 60000, as in A.8). */
  leaseMs?: number;
  /** How often this worker runs the reaper (default leaseMs/2). */
  reaperMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Must log in as manythreads_system (default: the shared system pool). */
  pool?: pg.Pool;
}

export interface Worker {
  stop(): Promise<void>;
  /** Stop everything at once and drop in-flight outcomes, leaving leases to expire (simulates a crash). */
  halt(): void;
  readonly completed: () => number;
}

interface ClaimedJob {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** A.8 claim: ready job -> running plus an UNLOGGED lease, in one statement. */
export async function claimJobs(
  queue: string,
  workerId: string,
  limit: number,
  options: { leaseMs?: number; pool?: pg.Pool } = {},
): Promise<ClaimedJob[]> {
  const { leaseMs = 60_000 } = options;
  return withSystem(
    async (tx) => {
      const res = await tx.query<ClaimedJob>(
        `WITH next AS (
           SELECT id FROM app.jobs WHERE queue = $1 AND state = 'ready' AND run_at <= now()
           ORDER BY run_at, id LIMIT $4 FOR UPDATE SKIP LOCKED),
         upd AS (
           UPDATE app.jobs j SET state = 'running', attempts = j.attempts + 1
           FROM next WHERE j.id = next.id RETURNING j.id, j.payload, j.attempts),
         lease AS (
           INSERT INTO app.job_leases (job_id, worker_id, expires_at)
           SELECT id, $2, now() + $3 * interval '1 millisecond' FROM upd RETURNING job_id)
         SELECT upd.id, upd.payload, upd.attempts FROM upd JOIN lease ON lease.job_id = upd.id`,
        [queue, workerId, leaseMs, limit],
      );
      return res.rows;
    },
    options.pool ? { pool: options.pool } : {},
  );
}

/**
 * Reaper: running jobs whose lease is missing (the UNLOGGED table was emptied by a crash) or expired go back to
 * ready, or to dead when attempts are exhausted. Returns how many were requeued.
 */
export async function reapJobs(options: { maxAttempts?: number; pool?: pg.Pool } = {}): Promise<number> {
  const { maxAttempts = 5 } = options;
  return withSystem(
    async (tx) => {
      const res = await tx.query(
        `WITH orphan AS (
           SELECT j.id FROM app.jobs j
           WHERE j.state = 'running'
             AND NOT EXISTS (SELECT 1 FROM app.job_leases l WHERE l.job_id = j.id AND l.expires_at > now())
           FOR UPDATE OF j SKIP LOCKED),
         gone AS (DELETE FROM app.job_leases WHERE job_id IN (SELECT id FROM orphan))
         UPDATE app.jobs j SET
           state = CASE WHEN j.attempts >= $1 THEN 'dead' ELSE 'ready' END,
           run_at = now(), last_error = coalesce(j.last_error, 'lease lost'),
           finished_at = CASE WHEN j.attempts >= $1 THEN now() END
         FROM orphan WHERE j.id = orphan.id`,
        [maxAttempts],
      );
      return res.rowCount ?? 0;
    },
    options.pool ? { pool: options.pool } : {},
  );
}

/** Pulls ready jobs of one queue, runs them with bounded concurrency, heartbeats leases, backs off, dead-letters. */
export function startWorker(options: WorkerOptions): Worker {
  const {
    queue,
    handler,
    workerId,
    concurrency = 1,
    pollMs = 5000,
    leaseMs = 60_000,
    maxAttempts = 5,
    backoffBaseMs = 1000,
    backoffCapMs = 300_000,
  } = options;
  const reaperMs = options.reaperMs ?? Math.max(50, Math.floor(leaseMs / 2));
  const pool = options.pool ?? getSystemPool();
  const poolOpt = { pool };
  const signal: { wake: (() => void) | null } = { wake: null };
  const held = new Map<string, number>(); // job id -> attempt claimed
  let running = true;
  let halted = false;
  let completedCount = 0;
  let stopListening: (() => Promise<void>) | undefined;
  const inflight = new Set<Promise<void>>();

  const finish = async (job: ClaimedJob, err: unknown): Promise<void> => {
    if (halted) return;
    await withSystem(async (tx) => {
      // Fenced on attempts: a run whose lease was lost and reclaimed elsewhere can no longer change the job.
      if (err === undefined) {
        const r = await tx.query(
          `UPDATE app.jobs SET state = 'done', finished_at = now()
           WHERE id = $1 AND state = 'running' AND attempts = $2`,
          [job.id, job.attempts],
        );
        if (r.rowCount === 1) completedCount += 1;
      } else {
        const dead = job.attempts >= maxAttempts;
        await tx.query(
          `UPDATE app.jobs SET state = CASE WHEN $3 THEN 'dead' ELSE 'ready' END, last_error = $4,
             run_at = now() + $5 * interval '1 millisecond', finished_at = CASE WHEN $3 THEN now() END
           WHERE id = $1 AND state = 'running' AND attempts = $2`,
          [
            job.id,
            job.attempts,
            dead,
            err instanceof Error ? err.message : String(err),
            backoffMs(job.attempts, backoffBaseMs, backoffCapMs),
          ],
        );
      }
      await tx.query('DELETE FROM app.job_leases WHERE job_id = $1 AND worker_id = $2', [job.id, workerId]);
    }, poolOpt);
  };

  const runJob = async (job: ClaimedJob): Promise<void> => {
    held.set(job.id, job.attempts);
    let err: unknown;
    try {
      await handler(job.payload, { jobId: job.id, attempt: job.attempts, workerId });
    } catch (e) {
      err = e ?? new Error('job failed');
    }
    held.delete(job.id);
    try {
      await finish(job, err);
    } catch {
      // Could not record the outcome: the lease will expire and the reaper requeues the job.
    }
  };

  const heartbeat = setInterval(() => {
    if (halted || held.size === 0) return;
    withSystem(
      (tx) =>
        tx.query(
          `UPDATE app.job_leases SET expires_at = now() + $3 * interval '1 millisecond'
           WHERE worker_id = $1 AND job_id = ANY($2)`,
          [workerId, [...held.keys()], leaseMs],
        ),
      poolOpt,
    ).catch(() => undefined);
  }, Math.max(20, Math.floor(leaseMs / 3)));

  const reaper = setInterval(() => {
    if (halted) return;
    reapJobs({ maxAttempts, pool }).then((n) => n > 0 && signal.wake?.(), () => undefined);
  }, reaperMs);

  const loop = (async () => {
    stopListening = await listen(pool, 'manythreads_jobs', (payload) => {
      if (payload === queue) signal.wake?.();
    });
    while (running) {
      const free = concurrency - inflight.size;
      let claimed: ClaimedJob[] = [];
      if (free > 0) {
        try {
          claimed = await claimJobs(queue, workerId, free, { leaseMs, pool });
        } catch {
          claimed = [];
        }
        for (const job of claimed) {
          const p = runJob(job).finally(() => {
            inflight.delete(p);
            signal.wake?.();
          });
          inflight.add(p);
        }
      }
      // A full claim means more may be waiting; otherwise sleep until NOTIFY, a finished job, or the poll net.
      if (running && (free <= 0 || claimed.length < free)) await sleepUnlessWoken(pollMs, signal);
    }
  })();

  let shutdownDone: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (shutdownDone ??= (async () => {
      clearInterval(heartbeat);
      clearInterval(reaper);
      await loop;
      await stopListening?.();
    })());

  return {
    completed: () => completedCount,
    halt() {
      halted = true;
      running = false;
      signal.wake?.();
      shutdown().catch(() => undefined);
    },
    async stop() {
      running = false;
      signal.wake?.();
      await loop;
      await Promise.allSettled([...inflight]);
      await shutdown();
    },
  };
}

// cron ----------------------------------------------------------------------------------------------------------

/** Stores (or replaces) a cron schedule; the ticker enqueues `payload` on `queue` once per matching UTC minute. */
export async function schedule(
  tx: Tx,
  name: string,
  cronExpr: string,
  queue: string,
  payload: unknown = {},
): Promise<void> {
  parseCron(cronExpr); // reject bad expressions at write time
  await tx.query('SELECT app.upsert_job_schedule($1, $2, $3, $4::jsonb)', [
    name,
    cronExpr,
    queue,
    JSON.stringify(payload ?? {}),
  ]);
}

/**
 * Enqueues the latest due slot of every enabled schedule (missed slots coalesce into one run). Safe from many
 * replicas: the schedule row is locked, `last_slot` advances in the same transaction as the enqueue, and the dedupe
 * key is `name@slot`. Returns the number of jobs enqueued.
 */
export async function tickSchedules(options: { now?: Date; pool?: pg.Pool } = {}): Promise<number> {
  const now = options.now ?? new Date();
  return withSystem(
    async (tx) => {
      const rows = await tx.query<{
        name: string;
        cron_expr: string;
        queue: string;
        payload: Record<string, unknown>;
        last_slot: Date | null;
        created_at: Date;
      }>(`SELECT * FROM app.job_schedules WHERE enabled FOR UPDATE SKIP LOCKED`);
      let n = 0;
      for (const s of rows.rows) {
        const slot = latestSlot(s.cron_expr, now, s.last_slot ?? s.created_at);
        if (!slot) continue;
        await enqueue(tx, s.queue, s.payload, { dedupeKey: `${s.name}@${slot.toISOString()}` });
        await tx.query('UPDATE app.job_schedules SET last_slot = $2 WHERE name = $1', [s.name, slot]);
        n += 1;
      }
      return n;
    },
    options.pool ? { pool: options.pool } : {},
  );
}

/** Runs tickSchedules every `tickMs` (default 15 s). */
export function startScheduler(options: { tickMs?: number; pool?: pg.Pool } = {}): { stop(): void } {
  const timer = setInterval(() => {
    tickSchedules(options.pool ? { pool: options.pool } : {}).catch(() => undefined);
  }, options.tickMs ?? 15_000);
  return { stop: () => clearInterval(timer) };
}
