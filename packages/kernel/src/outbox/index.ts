import { upcast, type LatestEvent } from '@majlis/shared';
import type pg from 'pg';
import { getAppPool, withSystem, type Tx } from '../db/index.ts';
import { eventToRaw } from '../events/index.ts';
import { backoffMs, listen, sleepUnlessWoken } from './listen.ts';

export interface OutboxMeta {
  /** Event id: the idempotency key handlers dedupe on (see processedOnce). */
  eventId: string;
  deliveryId: string;
  subscriber: string;
  /** 1 on the first delivery. */
  attempts: number;
}

export type OutboxHandler = (event: LatestEvent, meta: OutboxMeta) => Promise<void> | void;

export interface ConsumerOptions {
  subscriber: string;
  handler: OutboxHandler;
  /** Rows claimed per round (default 50). */
  batch?: number;
  /** Poll interval, the safety net behind LISTEN (default 5000). */
  pollMs?: number;
  /** How long a claim is held before another consumer may take the row again (default 30000). */
  leaseMs?: number;
  /** Delivery attempts before the row is dead-lettered (default 8). */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  pool?: pg.Pool;
}

export interface Consumer {
  /** Stop claiming and wait for in-flight deliveries to settle. */
  stop(): Promise<void>;
  /** Stop without finishing anything: in-flight outcomes are dropped (simulates a crash). */
  halt(): void;
  readonly delivered: () => number;
}

interface ClaimedRow {
  id: string;
  event_id: string;
  attempts: number;
}

export interface ClaimOptions {
  batch?: number;
  leaseMs?: number;
  maxAttempts?: number;
  pool?: pg.Pool;
}

/**
 * A.8 claim with a lease: SKIP LOCKED picks rows nobody holds (`claimed_until` empty or past), bumps `attempts`
 * and sets the lease, in its own short transaction. A consumer that dies leaves the lease to expire, after which
 * the row is claimable again: at-least-once. Rows whose attempts are exhausted by crashes are dead-lettered first.
 */
export async function claimOutbox(subscriber: string, options: ClaimOptions = {}): Promise<ClaimedRow[]> {
  const { batch = 50, leaseMs = 30_000, maxAttempts = 8 } = options;
  return withSystem(
    async (tx) => {
      await tx.query(
        `UPDATE app.outbox SET dead_at = now(), claimed_until = NULL, last_error = coalesce(last_error, 'lease expired')
         WHERE subscriber = $1 AND done_at IS NULL AND dead_at IS NULL AND attempts >= $2
           AND claimed_until IS NOT NULL AND claimed_until < now()`,
        [subscriber, maxAttempts],
      );
      const res = await tx.query<ClaimedRow>(
        `WITH next AS (
           SELECT id FROM app.outbox
           WHERE subscriber = $1 AND done_at IS NULL AND dead_at IS NULL AND available_at <= now()
             AND (claimed_until IS NULL OR claimed_until < now())
           ORDER BY available_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE app.outbox o SET attempts = o.attempts + 1,
           claimed_until = now() + $3 * interval '1 millisecond'
         FROM next WHERE o.id = next.id
         RETURNING o.id, o.event_id, o.attempts`,
        [subscriber, batch, leaseMs],
      );
      return res.rows;
    },
    options.pool ? { pool: options.pool } : {},
  );
}

/**
 * Exactly-once effects on top of at-least-once delivery: call it first inside the handler's own transaction and skip
 * the effect when it returns false. Backed by app.outbox_processed (system-only: use a system tx).
 */
export async function processedOnce(tx: Tx, subscriber: string, eventId: string): Promise<boolean> {
  const res = await tx.query(
    `INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ($1, $2)
     ON CONFLICT (subscriber, event_id) DO NOTHING RETURNING event_id`,
    [subscriber, eventId],
  );
  return res.rowCount === 1;
}

/** Publisher/consumer for one subscriber: LISTEN majlis_outbox plus a poll, claim, handle, mark done / back off / dead-letter. */
export function startConsumer(options: ConsumerOptions): Consumer {
  const {
    subscriber,
    handler,
    batch = 50,
    pollMs = 5000,
    leaseMs = 30_000,
    maxAttempts = 8,
    backoffBaseMs = 1000,
    backoffCapMs = 300_000,
  } = options;
  const pool = options.pool ?? getAppPool();
  const poolOpt = { pool };
  const signal: { wake: (() => void) | null } = { wake: null };
  let running = true;
  let halted = false;
  let deliveredCount = 0;
  let stopListening: (() => Promise<void>) | undefined;

  const processRound = async (rows: ClaimedRow[]): Promise<void> => {
    const events = await withSystem(
      (tx) =>
        tx.query<{ id: string; type: string; schema_version: number; workspace_id: string; payload: unknown }>(
          'SELECT id, type, schema_version, workspace_id, payload FROM app.events WHERE id = ANY($1)',
          [rows.map((r) => r.event_id)],
        ),
      poolOpt,
    );
    const byId = new Map(events.rows.map((e) => [e.id, e]));
    const ok: string[] = [];
    const failed: { id: string; attempts: number; error: string }[] = [];
    await Promise.all(
      rows.map(async (row) => {
        try {
          const ev = byId.get(row.event_id);
          if (!ev) throw new Error(`event ${row.event_id} not found`);
          await handler(upcast(eventToRaw(ev)), {
            eventId: row.event_id,
            deliveryId: row.id,
            subscriber,
            attempts: row.attempts,
          });
          ok.push(row.id);
        } catch (err) {
          failed.push({ id: row.id, attempts: row.attempts, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    if (halted) return; // a crashed consumer reports nothing; the leases expire
    await withSystem(async (tx) => {
      if (ok.length > 0) {
        await tx.query(
          'UPDATE app.outbox SET done_at = now(), claimed_until = NULL WHERE id = ANY($1) AND done_at IS NULL',
          [ok],
        );
      }
      for (const f of failed) {
        const dead = f.attempts >= maxAttempts;
        await tx.query(
          `UPDATE app.outbox SET claimed_until = NULL, last_error = $2,
             dead_at = CASE WHEN $3 THEN now() END,
             available_at = now() + $4 * interval '1 millisecond'
           WHERE id = $1`,
          [f.id, f.error, dead, backoffMs(f.attempts, backoffBaseMs, backoffCapMs)],
        );
      }
    }, poolOpt);
    deliveredCount += ok.length;
  };

  const loop = (async () => {
    stopListening = await listen(pool, 'majlis_outbox', (payload) => {
      if (payload === subscriber) signal.wake?.();
    });
    while (running) {
      let rows: ClaimedRow[] = [];
      try {
        rows = await claimOutbox(subscriber, { batch, leaseMs, maxAttempts, pool });
        if (rows.length > 0 && running) await processRound(rows);
      } catch {
        rows = []; // transient DB error: fall through to the poll sleep
      }
      if (running && rows.length < batch) await sleepUnlessWoken(pollMs, signal);
    }
  })();

  return {
    delivered: () => deliveredCount,
    halt() {
      halted = true;
      running = false;
      signal.wake?.();
      void loop.then(() => stopListening?.());
    },
    async stop() {
      running = false;
      signal.wake?.();
      await loop;
      await stopListening?.();
    },
  };
}
