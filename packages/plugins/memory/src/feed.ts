import { MemoryError, type MemoryBank, type MemoryProvider, type PluginContext, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import { feedTuning } from './config.ts';
import { DRAIN_BATCH } from './constants.ts';
import { latestLine } from './rows.ts';
import { runForgetPhase } from './feed/phase-forget.ts';
import { runWithholdPhase } from './feed/phase-withhold.ts';
import { runRetainPhase } from './feed/phase-retain.ts';
import { scheduleNext, settleBatch, settleRow } from './feed/settle.ts';
import { emptyStats, planBatch, type DrainStats, type FeedRuntime, type PendingRow } from './feed/plan.ts';

// The drain: reads the feed's work list, asks each source what it is now, and makes the bank agree. One drain at a time across replicas (an
// advisory lock, not row locks: a handler that marks a source never waits on an engine call), at most DRAIN_BATCH sources per run, one engine call
// per team per chunk. The engine being down, slow or unconfigured never throws out of here and never touches the outbox: a failed source backs off in
// its work row and the rest of the batch goes on.

export type { DrainStats, FeedRuntime } from './feed/plan.ts';

export async function drainFeed(ctx: PluginContext, tx: PluginTx, log: PluginLogger, rt: FeedRuntime): Promise<DrainStats> {
  const stats = emptyStats();
  const keys = new Map<string, Buffer>(); // this drain's reads of the workspace keys (never kept longer: see keys.ts)
  const lock = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', ['memory.feed.drain']);
  if (lock.rows[0]?.ok !== true) return stats; // another replica is draining

  const due = (
    await tx.query<PendingRow>(
      `SELECT source_kind, source_id, workspace_id, requested_at::text AS requested_at, attempts,
              CASE WHEN deferred_since IS NULL THEN NULL ELSE (extract(epoch FROM now() - deferred_since) * 1000)::float8 END AS deferred_ms
         FROM app.memory_feed_pending WHERE not_before <= now() ORDER BY requested_at LIMIT $1`,
      [DRAIN_BATCH],
    )
  ).rows;
  stats.considered = due.length;
  if (due.length === 0) return stats;

  const settle = async (row: PendingRow): Promise<void> => {
    await settleRow(tx, row);
  };

  const provider = ctx.providers.get<MemoryProvider>('memory');
  if (!provider || !provider.enabled) {
    // Nothing waits for an engine that is not there — except taking out what is already in it: a source the log says the bank holds a document
    // for keeps its work row (looked at again after twenty defer periods: ten minutes by default), so a delete or an edit made while the engine is off is still carried out when it
    // is back. A source the bank holds nothing for has nothing to forget and no backfill is part of this task: its row goes.
    for (const row of due) {
      const last = await latestLine(tx, row.source_kind, row.source_id);
      if (last !== null && last.outcome === 'retained') {
        await tx.query(
          `UPDATE app.memory_feed_pending SET not_before = now() + $3 * interval '1 millisecond' WHERE source_kind = $1 AND source_id = $2`,
          [row.source_kind, row.source_id, feedTuning().deferMs * 20],
        );
        stats.deferred += 1;
      } else {
        await settle(row);
        stats.dropped += 1;
      }
    }
    log.warn(`memory: no memory engine is configured; ${stats.dropped} changed source(s) were not retained, ${stats.deferred} wait to be taken out of the bank`);
    await scheduleNext(ctx, tx, rt);
    return stats;
  }

  // Plan: what each source is now, what the log says the bank holds, and the one decision that follows.
  const planned = await planBatch(tx, due, keys, log, rt, stats, settle);

  const banks = new Map<string, MemoryBank | null>();
  const bankOf = async (teamId: string): Promise<MemoryBank | null> => {
    if (banks.has(teamId)) return banks.get(teamId) ?? null;
    let bank: MemoryBank | null = null;
    try {
      bank = await provider.forTeam(tx, teamId);
    } catch (err) {
      if (!(err instanceof MemoryError) || err.code !== 'unknown_team') throw err;
    }
    banks.set(teamId, bank);
    return bank;
  };

  await runForgetPhase(tx, planned, stats, bankOf, rt);
  await runWithholdPhase(tx, planned, stats, bankOf);
  await runRetainPhase(tx, planned, stats, bankOf, rt);
  await settleBatch(tx, planned, stats, bankOf);

  await scheduleNext(ctx, tx, rt);
  return stats;
}
