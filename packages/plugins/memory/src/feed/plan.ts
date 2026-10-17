import type { MemoryBank, PluginLogger, PluginTx } from '@manythreads/sdk';
import { feedTuning } from '../config.ts';
import { decide, type Decision } from '../decide.ts';
import { latestLine, type LastLine } from '../rows.ts';
import { readWorkspaceKey } from '../keys.ts';
import { resolve, type Provenance } from '../sources.ts';
import type { SlidingWindow } from '../window.ts';

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

export const emptyStats = (): DrainStats => ({ considered: 0, retained: 0, forgotten: 0, withheld: 0, deferred: 0, unchanged: 0, throttled: 0, failed: 0, dropped: 0 });

export interface PendingRow extends Record<string, unknown> {
  source_kind: string;
  source_id: string;
  workspace_id: string;
  requested_at: string;
  attempts: number;
  deferred_ms: number | null;
}

export interface Planned {
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

export type BankOf = (teamId: string) => Promise<MemoryBank | null>;

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** A source that has waited this many passes for a key it never got is dropped. */
export const KEYLESS_MAX_DEFERRALS = 20;
export const KEYLESS_WARN_EVERY_MS = 60 * 60 * 1000;
/** Process memory: when a workspace's missing-key line was last written. */
export const recentlyWarned = new Map<string, number>();

export const byTeam = <T extends Planned>(list: readonly T[]): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const p of list) {
    const group = out.get(p.teamId);
    if (group) group.push(p);
    else out.set(p.teamId, [p]);
  }
  return out;
};

// Plan: what each source is now, what the log says the bank holds, and the one decision that follows.
export async function planBatch(
  tx: PluginTx,
  due: PendingRow[],
  keys: Map<string, Buffer>,
  log: PluginLogger,
  rt: FeedRuntime,
  stats: DrainStats,
  settle: (row: PendingRow) => Promise<void>,
): Promise<Planned[]> {
  const planned: Planned[] = [];
  for (const row of due) {
    const res = await resolve(tx, row.source_kind, row.source_id);
    const last = await latestLine(tx, row.source_kind, row.source_id);
    const key = await readWorkspaceKey(tx, row.workspace_id, keys);
    if (key === null) {
      // The handler that marked this source makes the key in its own transaction, which commits with the row; a row without one is not retained
      // under a key made here (a rollback would orphan what the engine was given). Looked at again shortly — and given up on after
      // KEYLESS_MAX_DEFERRALS looks (a row that has no key by then never will: its handler's transaction made none), with one warning an hour per
      // workspace instead of one per row per pass.
      const attempts = row.attempts + 1;
      const quiet = recentlyWarned.get(row.workspace_id) !== undefined && rt.now() - (recentlyWarned.get(row.workspace_id) as number) < KEYLESS_WARN_EVERY_MS;
      if (attempts >= KEYLESS_MAX_DEFERRALS) {
        await settle(row);
        stats.dropped += 1;
      } else {
        await tx.query(
          `UPDATE app.memory_feed_pending SET attempts = $3, not_before = now() + $4 * interval '1 millisecond' WHERE source_kind = $1 AND source_id = $2`,
          [row.source_kind, row.source_id, attempts, feedTuning().deferMs],
        );
        stats.deferred += 1;
      }
      if (!quiet) {
        recentlyWarned.set(row.workspace_id, rt.now());
        log.warn(`memory: no digest key for workspace ${row.workspace_id}: ${row.source_kind} ${row.source_id} ${attempts >= KEYLESS_MAX_DEFERRALS ? 'was dropped after repeated waits' : 'waits'} (further lines of this kind for the workspace are suppressed for an hour)`);
      }
      continue;
    }
    const decision = decide({
      kind: row.source_kind,
      sourceId: row.source_id,
      res,
      last,
      deferredForMs: row.deferred_ms ?? 0,
      key,
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
  return planned;
}
