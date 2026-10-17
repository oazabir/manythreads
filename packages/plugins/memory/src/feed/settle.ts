import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { feedTuning } from '../config.ts';
import { BACKOFF_CAP_MS, FEED_QUEUE, MAX_ATTEMPTS } from '../constants.ts';
import { appendLine } from '../rows.ts';
import { type BankOf, type DrainStats, type FeedRuntime, type PendingRow, type Planned } from './plan.ts';

export const backoffMs = (attempts: number): number => Math.min(BACKOFF_CAP_MS, feedTuning().backoffBaseMs * 2 ** Math.max(0, attempts));

export async function settleRow(tx: PluginTx, row: PendingRow): Promise<void> {
  await tx.query('DELETE FROM app.memory_feed_pending WHERE source_kind = $1 AND source_id = $2 AND requested_at = $3::timestamptz', [row.source_kind, row.source_id, row.requested_at]);
}

// The next look: at the earliest time anything in the work list becomes due (a deferred run, a back-off, a throttled team, a full batch, a
// source waiting for the engine). Its own key per second, because a job that is running holds its key and would swallow a follow-up under the
// same one.
export async function scheduleNext(ctx: PluginContext, tx: PluginTx, rt: FeedRuntime): Promise<void> {
  const next = (await tx.query<{ at: Date | null }>('SELECT min(not_before) AS at FROM app.memory_feed_pending')).rows[0]?.at ?? null;
  if (next === null) return;
  const runAt = new Date(Math.max(next.getTime(), rt.now()));
  await ctx.jobs.enqueue(tx, FEED_QUEUE, {}, { runAt, dedupeKey: `feed:at:${Math.floor(runAt.getTime() / 1000)}` });
}

// D: settle the work rows. A source changed again while we worked has a newer `requested_at` and stays.
export async function settleBatch(tx: PluginTx, planned: Planned[], stats: DrainStats, bankOf: BankOf): Promise<void> {
  for (const p of planned) {
    const { row } = p;
    if (p.hold?.kind === 'team_gone') {
      await settleRow(tx, row);
      continue;
    }
    if (p.hold?.kind === 'throttled') {
      await tx.query(
        `UPDATE app.memory_feed_pending SET not_before = now() + $3 * interval '1 millisecond'
          WHERE source_kind = $1 AND source_id = $2`,
        [row.source_kind, row.source_id, p.hold.delayMs],
      );
      stats.throttled += 1;
      continue;
    }
    if (p.hold?.kind === 'failed') {
      const attempts = row.attempts + 1;
      if (p.hold.phase === 'forget') {
        // A document that cannot be taken out is never given up on: the row stays, one attempt a half hour, and the line (with the document id,
        // once) says so. Dropping it would leave the text in the bank with nothing left that remembers to remove it.
        if (attempts === MAX_ATTEMPTS) {
          const bank = await bankOf(p.teamId);
          await appendLine(tx, {
            workspaceId: p.workspaceId,
            teamId: p.teamId,
            bank: bank?.id ?? '(unknown)',
            sourceKind: row.source_kind,
            sourceId: row.source_id,
            channelId: p.last?.channel_id ?? p.channelId,
            documentId: p.decision.forget?.documentId ?? null,
            outcome: 'failed',
            reason: `the document could not be taken out of the bank after ${attempts} attempts; still trying`,
            runId: p.runId,
            actorId: p.actorId,
            link: p.link,
          });
        }
        await tx.query(
          `UPDATE app.memory_feed_pending SET attempts = $3, last_error = $4, not_before = now() + $5 * interval '1 millisecond'
            WHERE source_kind = $1 AND source_id = $2`,
          [row.source_kind, row.source_id, attempts, p.hold.error, BACKOFF_CAP_MS],
        );
      } else if (attempts >= MAX_ATTEMPTS) {
        const bank = await bankOf(p.teamId);
        await appendLine(tx, {
          workspaceId: p.workspaceId,
          teamId: p.teamId,
          bank: bank?.id ?? '(unknown)',
          sourceKind: row.source_kind,
          sourceId: row.source_id,
          channelId: p.channelId,
          outcome: 'failed',
          reason: `the engine did not take it after ${attempts} attempts`,
          runId: p.runId,
          actorId: p.actorId,
          link: p.link,
        });
        await settleRow(tx, row);
      } else {
        await tx.query(
          `UPDATE app.memory_feed_pending SET attempts = $3, last_error = $4, not_before = now() + $5 * interval '1 millisecond'
            WHERE source_kind = $1 AND source_id = $2`,
          [row.source_kind, row.source_id, attempts, p.hold.error, backoffMs(row.attempts)],
        );
      }
      stats.failed += 1;
      continue;
    }
    if (p.decision.defer !== null) {
      await tx.query(
        `UPDATE app.memory_feed_pending
            SET not_before = now() + $3 * interval '1 millisecond', deferred_since = coalesce(deferred_since, now())
          WHERE source_kind = $1 AND source_id = $2`,
        [row.source_kind, row.source_id, feedTuning().deferMs],
      );
      stats.deferred += 1;
      continue;
    }
    if (p.decision.forget === null && p.decision.retain === null && p.decision.withhold === null) stats.unchanged += 1;
    await settleRow(tx, row);
  }
}
