import { MemoryError, type MemoryBank, type MemoryProvider, type PluginContext, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import { feedTuning } from './config.ts';
import { BACKOFF_CAP_MS, DRAIN_BATCH, FEED_QUEUE, MAX_ATTEMPTS, RETAIN_CHUNK } from './constants.ts';
import { decide, type Decision } from './decide.ts';
import { appendLine, latestLine, type LastLine } from './rows.ts';
import { workspaceKey } from './keys.ts';
import { resolve, type Provenance } from './sources.ts';
import type { SlidingWindow } from './window.ts';

// The drain: reads the feed's work list, asks each source what it is now, and makes the bank agree. One drain at a time across replicas (an
// advisory lock, not row locks: a handler that marks a source never waits on an engine call), at most DRAIN_BATCH sources per run, one engine call
// per team per chunk. The engine being down, slow or unconfigured never throws out of here and never touches the outbox: a failed source backs off in
// its work row and the rest of the batch goes on.

export interface FeedRuntime {
  retainWindow: SlidingWindow;
  forgetWindow: SlidingWindow;
  now(): number;
}

export interface DrainStats {
  considered: number;
  retained: number;
  forgotten: number;
  withheld: number;
  deferred: number;
  unchanged: number;
  throttled: number;
  failed: number;
  /** Rows dropped because no engine is configured. */
  dropped: number;
}

const emptyStats = (): DrainStats => ({ considered: 0, retained: 0, forgotten: 0, withheld: 0, deferred: 0, unchanged: 0, throttled: 0, failed: 0, dropped: 0 });

interface PendingRow extends Record<string, unknown> {
  source_kind: string;
  source_id: string;
  workspace_id: string;
  requested_at: string;
  attempts: number;
  deferred_ms: number | null;
}

interface Planned {
  row: PendingRow;
  decision: Decision;
  last: LastLine | null;
  teamId: string;
  workspaceId: string;
  channelId: string | null;
  runId: string | null;
  actorId: string | null;
  scopes: string[];
  link: string;
  /** Replies of a thread that were left out of its document (one `withheld` line each). */
  excluded: NonNullable<Provenance['excluded']>;
  /** Set when the row cannot be settled this round: `throttled` keeps it for later, `failed` counts an attempt (`phase`: which engine call). */
  hold: null | { kind: 'throttled'; delayMs: number } | { kind: 'failed'; error: string; phase: 'forget' | 'retain' } | { kind: 'team_gone' };
}

/** The engine's answers that mean "this payload is wrong" (not "I am down" or "you may not"): worth trying the items singly. */
const PAYLOAD_STATUSES = new Set([400, 413, 422]);

const backoffMs = (attempts: number): number => Math.min(BACKOFF_CAP_MS, feedTuning().backoffBaseMs * 2 ** Math.max(0, attempts));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

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
    await tx.query('DELETE FROM app.memory_feed_pending WHERE source_kind = $1 AND source_id = $2 AND requested_at = $3::timestamptz', [row.source_kind, row.source_id, row.requested_at]);
  };

  // The next look: at the earliest time anything in the work list becomes due (a deferred run, a back-off, a throttled team, a full batch, a
  // source waiting for the engine). Its own key per second, because a job that is running holds its key and would swallow a follow-up under the
  // same one.
  const scheduleNext = async (): Promise<void> => {
    const next = (await tx.query<{ at: Date | null }>('SELECT min(not_before) AS at FROM app.memory_feed_pending')).rows[0]?.at ?? null;
    if (next === null) return;
    const runAt = new Date(Math.max(next.getTime(), rt.now()));
    await ctx.jobs.enqueue(tx, FEED_QUEUE, {}, { runAt, dedupeKey: `feed:at:${Math.floor(runAt.getTime() / 1000)}` });
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
    await scheduleNext();
    return stats;
  }

  // Plan: what each source is now, what the log says the bank holds, and the one decision that follows.
  const planned: Planned[] = [];
  for (const row of due) {
    const res = await resolve(tx, row.source_kind, row.source_id);
    const last = await latestLine(tx, row.source_kind, row.source_id);
    const decision = decide({
      kind: row.source_kind,
      sourceId: row.source_id,
      res,
      last,
      deferredForMs: row.deferred_ms ?? 0,
      key: await workspaceKey(tx, row.workspace_id, keys),
    });
    const at = 'at' in res ? res.at : null;
    const teamId = at?.teamId ?? last?.team_id ?? null;
    if (teamId === null) {
      // The source is gone and nothing was ever held for it.
      await settle(row);
      stats.unchanged += 1;
      continue;
    }
    planned.push({
      row,
      decision,
      last,
      teamId,
      workspaceId: at?.workspaceId ?? last?.workspace_id ?? row.workspace_id,
      channelId: at?.channelId ?? last?.channel_id ?? null,
      runId: at?.runId ?? null,
      actorId: at?.actorId ?? null,
      scopes: at?.scopes ?? [],
      link: at?.link ?? '',
      excluded: at?.excluded ?? [],
      hold: null,
    });
  }

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

  const byTeam = <T extends Planned>(list: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const p of list) {
      const group = out.get(p.teamId);
      if (group) group.push(p);
      else out.set(p.teamId, [p]);
    }
    return out;
  };

  // A: take out what must go (a deleted or edited source, a withheld one): before anything is put in, so an edit that was a correction never
  // leaves the old text beside the new.
  for (const [teamId, list] of byTeam(planned.filter((p) => p.decision.forget !== null))) {
    const bank = await bankOf(teamId);
    if (bank === null) {
      for (const p of list) p.hold = { kind: 'team_gone' };
      continue;
    }
    const allow = rt.forgetWindow.remaining(teamId);
    const now = list.slice(0, allow);
    for (const p of list.slice(allow)) p.hold = { kind: 'throttled', delayMs: Math.max(feedTuning().deferMs, rt.forgetWindow.retryAfterMs(teamId)) };
    if (now.length === 0) continue;
    try {
      await bank.forget(now.map((p) => p.decision.forget!.documentId));
      rt.forgetWindow.spend(teamId, now.length);
      for (const p of now) {
        await appendLine(tx, {
          workspaceId: p.workspaceId,
          teamId,
          bank: bank.id,
          sourceKind: p.row.source_kind,
          sourceId: p.row.source_id,
          channelId: p.last?.channel_id ?? p.channelId,
          documentId: p.decision.forget!.documentId,
          outcome: 'forgotten',
          reason: p.decision.forget!.reason,
          runId: p.runId,
          scopes: p.scopes,
          actorId: p.actorId,
          link: p.link,
        });
        stats.forgotten += 1;
      }
    } catch (err) {
      for (const p of now) p.hold = { kind: 'failed', error: errorText(err), phase: 'forget' };
    }
  }

  // B: say why something was not retained.
  for (const p of planned) {
    if (p.hold !== null || p.decision.withhold === null) continue;
    const bank = await bankOf(p.teamId);
    if (bank === null) {
      p.hold = { kind: 'team_gone' };
      continue;
    }
    await appendLine(tx, {
      workspaceId: p.workspaceId,
      teamId: p.teamId,
      bank: bank.id,
      sourceKind: p.row.source_kind,
      sourceId: p.row.source_id,
      channelId: p.channelId,
      outcome: 'withheld',
      reason: p.decision.withhold.reason,
      runId: p.runId,
      scopes: p.scopes,
      actorId: p.actorId,
      link: p.link,
    });
    stats.withheld += 1;
  }
  // ... and one line for each reply that was left out of a thread's document, once per reason (what was withheld is on the record, per message).
  for (const p of planned) {
    if (p.hold !== null || p.excluded.length === 0) continue;
    const bank = await bankOf(p.teamId);
    if (bank === null) continue;
    for (const e of p.excluded) {
      // Not for a message the bank holds a document for: that document is taken out by the message's own row (it may be failing right now),
      // and a `withheld` line written beside it would say "nothing is held" about something that is.
      const known = await latestLine(tx, 'message', e.messageId);
      if (known !== null && known.outcome === 'retained') continue;
      if (known !== null && known.outcome === 'withheld' && known.reason === e.reason) continue;
      await appendLine(tx, {
        workspaceId: p.workspaceId,
        teamId: p.teamId,
        bank: bank.id,
        sourceKind: 'message',
        sourceId: e.messageId,
        channelId: p.channelId,
        outcome: 'withheld',
        reason: e.reason,
        actorId: e.actorId,
        link: p.link,
      });
      stats.withheld += 1;
    }
  }

  // C: put in what changed, in chunks, asynchronously (the engine distils facts in the background; the call returns when it has the text).
  for (const [teamId, list] of byTeam(planned.filter((p) => p.hold === null && p.decision.retain !== null))) {
    const bank = await bankOf(teamId);
    if (bank === null) {
      for (const p of list) p.hold = { kind: 'team_gone' };
      continue;
    }
    const allow = rt.retainWindow.remaining(teamId);
    const now = list.slice(0, allow);
    for (const p of list.slice(allow)) p.hold = { kind: 'throttled', delayMs: Math.max(feedTuning().deferMs, rt.retainWindow.retryAfterMs(teamId)) };
    // One engine call per chunk. A 400, 413 or 422 says something in the chunk is wrong, not which: then the items go one at a time, so one
    // item the engine will not take cannot hold back the other twenty-four (a 5xx or no answer fails the chunk: the engine is down for all).
    const retainChunk = async (items: Planned[]): Promise<void> => {
      try {
        await bank.retain(
          items.map((p) => {
            const r = p.decision.retain!;
            return {
              content: r.item.content,
              context: r.item.context,
              timestamp: r.item.timestamp,
              tags: r.item.tags,
              documentId: r.documentId,
              metadata: r.item.metadata,
            };
          }),
          { async: true },
        );
        rt.retainWindow.spend(teamId, items.length);
        for (const p of items) {
          const r = p.decision.retain!;
          await appendLine(tx, {
            workspaceId: p.workspaceId,
            teamId,
            bank: bank.id,
            sourceKind: p.row.source_kind,
            sourceId: p.row.source_id,
            channelId: p.channelId,
            documentId: r.documentId,
            contentHash: r.hash,
            outcome: 'retained',
            runId: p.runId,
            scopes: p.scopes,
            actorId: p.actorId,
            link: p.link,
          });
          stats.retained += 1;
        }
      } catch (err) {
        if (items.length > 1 && err instanceof MemoryError && err.status !== null && PAYLOAD_STATUSES.has(err.status)) {
          for (const one of items) await retainChunk([one]);
          return;
        }
        for (const p of items) p.hold = { kind: 'failed', error: errorText(err), phase: 'retain' };
      }
    };
    for (let i = 0; i < now.length; i += RETAIN_CHUNK) await retainChunk(now.slice(i, i + RETAIN_CHUNK));
  }

  // D: settle the work rows. A source changed again while we worked has a newer `requested_at` and stays.
  for (const p of planned) {
    const { row } = p;
    if (p.hold?.kind === 'team_gone') {
      await settle(row);
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
        await settle(row);
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
    await settle(row);
  }

  await scheduleNext();
  return stats;
}
