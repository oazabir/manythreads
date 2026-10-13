import { randomUUID } from 'node:crypto';
import { NEVER_APPROVAL_GATED, type PluginTx } from '@manythreads/sdk';
import {
  RETENTION_MEMORY_LOG_DAYS,
  RETENTION_RUN_LOG_DAYS,
  type RetentionCounts,
  type RetentionSweepSummary,
} from '@manythreads/shared';
import { z } from 'zod';
import { retentionBatch } from './config.ts';
import { toRetentionWindows, type WorkspaceWindows } from './rows.ts';

const DAY_MS = 24 * 3_600_000;

// A sweep of one workspace, as a chain of small jobs (`retention.prune`): each step is ONE transaction that deletes at most a batch, then
// enqueues the next step with the state it reached (phase, cursor, running totals). A backlog of a million runs is thousands of short
// transactions, never one long lock; a step that fails is retried from the state it was given, and the state is only advanced in the same
// transaction that did the work, so a retried step never counts twice.
//
// The phases, in order:
//   runs   ended runs of the workspace older than its window, oldest first, keyset-paged on (ended_at, id): the feed's memo is written for
//          each (`app.memory_memoize_runs`), then the runs are deleted; run_source_log and mcp_run_tokens go with them (foreign key cascade).
//          Never: a run still running, one a pending (or approved, unfinished) approval was filed from — its resume needs the run's source
//          log (`ctx.runs.inheritSources`) — and one a legacy row of a never-gated tool points at (deleting the run UPDATEs that row through the
//          foreign key's SET NULL, which its NOT VALID check would refuse). A delete the database refuses anyway is retried run by run inside
//          savepoints, so one run cannot stall the chain.
//
// The payload is not trusted: `app.enqueue_job` is callable by the request role. Every step derives its cutoffs again from the workspace's own
// windows (never later than the window says, never later than the bound's minimum) and the delete re-asserts the whole eligibility predicate.
//   log    superseded retained/forgotten lines and attempt notes of `memory_retain_log` older than the workspace's memory-log window, a page at a
//          time through `app.memory_retain_log_prune`; never a `withheld` line, never the newest state of a source.
//   memos  the memos of bots that no longer exist (every verdict about a removed bot is `bot_removed`, the memo says nothing more).
// A dry run does all of it except the memo and the deletions, and counts what it would have done.

export const PRUNE_QUEUE = 'retention.prune';
export const SWEEP_QUEUE = 'retention.sweep';

const Counts = z.object({
  runs: z.number().int().nonnegative(),
  runsSkipped: z.number().int().nonnegative(),
  runSourceLines: z.number().int().nonnegative(),
  runTokens: z.number().int().nonnegative(),
  runMemos: z.number().int().nonnegative(),
  memoryLogLines: z.number().int().nonnegative(),
  memosRemoved: z.number().int().nonnegative(),
});

/** What a job step is given. Parsed on every step: a payload is whatever was enqueued, by anyone who could call `ctx.jobs.enqueue`. */
export const SweepState = z.object({
  workspaceId: z.uuid(),
  sweepId: z.uuid(),
  dryRun: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  /** Fixed when the sweep starts, so every step of it judges against the same instants. */
  runLogCutoff: z.iso.datetime({ offset: true }),
  memoryLogCutoff: z.iso.datetime({ offset: true }),
  phase: z.enum(['runs', 'log', 'memos']),
  /** `runs`: `<ended_at as text>|<run id>` of the last run looked at; `log`: the last log line id. */
  cursor: z.string().max(100).nullable(),
  step: z.number().int().nonnegative().max(1_000_000),
  counts: Counts,
});
export type SweepState = z.infer<typeof SweepState>;

export const emptyCounts = (): RetentionCounts => ({ runs: 0, runsSkipped: 0, runSourceLines: 0, runTokens: 0, runMemos: 0, memoryLogLines: 0, memosRemoved: 0 });

export type { WorkspaceWindows };

/** The workspace's windows (defaults when it never changed them), clamped to the bounds again so a hand-edited row cannot go below them. */
export async function loadWindows(tx: PluginTx, workspaceId: string): Promise<WorkspaceWindows> {
  const row = (
    await tx.query<{ run_log_days: number; memory_log_days: number }>('SELECT run_log_days, memory_log_days FROM app.retention_settings WHERE workspace_id = $1::uuid', [workspaceId])
  ).rows[0];
  return toRetentionWindows(row);
}

/** The first state of a sweep: its cutoffs are `now` minus the workspace's windows. */
export async function startSweep(tx: PluginTx, workspaceId: string, now: Date, dryRun: boolean): Promise<SweepState> {
  const w = await loadWindows(tx, workspaceId);
  const day = DAY_MS;
  return {
    workspaceId,
    sweepId: randomUUID(),
    dryRun,
    startedAt: now.toISOString(),
    runLogCutoff: new Date(now.getTime() - w.runLogDays * day).toISOString(),
    memoryLogCutoff: new Date(now.getTime() - w.memoryLogDays * day).toISOString(),
    phase: 'runs',
    cursor: null,
    step: 0,
    counts: emptyCounts(),
  };
}

export type StepResult = { done: false; state: SweepState } | { done: true; summary: RetentionSweepSummary; durationMs: number };

/**
 * The eligibility of a run, as one predicate for the select and the delete ($1 workspace, $2 cutoff, $3 the tools that may never wait for an
 * approval): ended, outside the window, of this workspace, with no approval that still needs it and no legacy row of a never-gated tool.
 */
const ELIGIBLE = `
  r.workspace_id = $1::uuid AND r.ended_at IS NOT NULL AND r.status <> 'running' AND r.ended_at < $2::timestamptz
  AND NOT EXISTS (
    SELECT 1 FROM app.approvals a
     WHERE a.run_id = r.id AND (a.status = 'pending' OR (a.status = 'approved' AND a.outcome IN ('none', 'queued', 'running')) OR a.tool = ANY($3::text[])))`;

/**
 * The cutoffs a step actually uses: the payload's, but never later than what the workspace's own window gives now, and never later than the
 * bound's minimum. A forged payload with a recent cutoff therefore deletes exactly what an honest one would.
 */
function effectiveCutoffs(state: SweepState, windows: WorkspaceWindows, now: number): { run: string; memory: string } {
  const run = Math.min(Date.parse(state.runLogCutoff), now - windows.runLogDays * DAY_MS, now - RETENTION_RUN_LOG_DAYS.min * DAY_MS);
  const memory = Math.min(Date.parse(state.memoryLogCutoff), now - windows.memoryLogDays * DAY_MS, now - RETENTION_MEMORY_LOG_DAYS.min * DAY_MS);
  return { run: new Date(run).toISOString(), memory: new Date(memory).toISOString() };
}

/** An integrity refusal (SQLSTATE class 23: a check, a foreign key, a unique): the only kind of refusal a run-by-run retry can get past. */
export function isIntegrityError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('23');
}

/**
 * Deletes `ids` (each re-checked against the eligibility predicate); returns the ones that went and the ones the database refused. A batch that
 * hits an integrity error is retried run by run, each in a savepoint. Anything else (a statement timeout, a deadlock, a cancel, a lost
 * connection) is not a property of one run: it is thrown, and the job's retry handles it from the state it was given.
 */
export async function deleteRuns(tx: PluginTx, state: SweepState, cutoff: string, ids: readonly string[]): Promise<{ deleted: string[]; skipped: string[] }> {
  const sql = `DELETE FROM app.bot_runs r WHERE r.id = ANY($4::uuid[]) AND ${ELIGIBLE} RETURNING r.id`;
  const gated = [...NEVER_APPROVAL_GATED];
  await tx.query('SAVEPOINT retention_batch');
  try {
    const res = await tx.query<{ id: string }>(sql, [state.workspaceId, cutoff, gated, [...ids]]);
    await tx.query('RELEASE SAVEPOINT retention_batch');
    return { deleted: res.rows.map((r) => r.id), skipped: [] };
  } catch (err) {
    if (!isIntegrityError(err)) throw err;
    await tx.query('ROLLBACK TO SAVEPOINT retention_batch');
    await tx.query('RELEASE SAVEPOINT retention_batch');
  }
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    await tx.query('SAVEPOINT retention_run');
    try {
      const res = await tx.query<{ id: string }>(sql, [state.workspaceId, cutoff, gated, [id]]);
      await tx.query('RELEASE SAVEPOINT retention_run');
      deleted.push(...res.rows.map((r) => r.id));
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT retention_run');
      await tx.query('RELEASE SAVEPOINT retention_run');
      skipped.push(id);
    }
  }
  return { deleted, skipped };
}

/** What hangs off each of these runs (source lines, endpoint tokens), taken before the delete cascades them away. */
async function weightOf(tx: PluginTx, ids: readonly string[]): Promise<Map<string, { lines: number; tokens: number }>> {
  const out = new Map<string, { lines: number; tokens: number }>();
  const of = (id: string): { lines: number; tokens: number } => {
    let w = out.get(id);
    if (!w) {
      w = { lines: 0, tokens: 0 };
      out.set(id, w);
    }
    return w;
  };
  if (ids.length === 0) return out;
  const lines = await tx.query<{ run_id: string; n: number }>('SELECT run_id, count(*)::int AS n FROM app.run_source_log WHERE run_id = ANY($1::uuid[]) GROUP BY run_id', [[...ids]]);
  for (const r of lines.rows) of(r.run_id).lines = r.n;
  const hasTokens = (await tx.query<{ ok: boolean }>("SELECT to_regclass('app.mcp_run_tokens') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (hasTokens) {
    const tokens = await tx.query<{ run_id: string; n: number }>('SELECT run_id, count(*)::int AS n FROM app.mcp_run_tokens WHERE run_id = ANY($1::uuid[]) GROUP BY run_id', [[...ids]]);
    for (const r of tokens.rows) of(r.run_id).tokens = r.n;
  }
  return out;
}

/** Runs one step of a sweep inside `tx` and says what comes next. */
export async function sweepStep(tx: PluginTx, given: SweepState): Promise<StepResult> {
  const batch = retentionBatch();
  const windows = await loadWindows(tx, given.workspaceId);
  const cut = effectiveCutoffs(given, windows, Date.now());
  const state: SweepState = { ...given, runLogCutoff: cut.run, memoryLogCutoff: cut.memory };
  const counts: RetentionCounts = { ...state.counts };
  let { phase, cursor } = state;

  if (phase === 'runs') {
    const [cursorAt = null, cursorId = null] = cursor === null ? [] : cursor.split('|');
    const rows = (
      await tx.query<{ id: string; ended_at: string }>(
        `SELECT r.id, r.ended_at::text AS ended_at
           FROM app.bot_runs r
          WHERE ${ELIGIBLE}
            AND ($4::timestamptz IS NULL OR (r.ended_at, r.id) > ($4::timestamptz, $5::uuid))
          ORDER BY r.ended_at, r.id
          LIMIT $6`,
        [state.workspaceId, state.runLogCutoff, [...NEVER_APPROVAL_GATED], cursorAt, cursorId, batch.runs],
      )
    ).rows;
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      let doomed = ids;
      let skipped: string[] = [];
      if (!state.dryRun) {
        // The memo first, in the same transaction as the delete: the verdict about what the bot wrote while the run was open must not change
        // when the run goes (docs/plugins/retention.md "The feed's verdict").
        counts.runMemos += (await tx.query<{ n: number }>('SELECT app.memory_memoize_runs($1::uuid[]) AS n', [ids])).rows[0]?.n ?? 0;
      }
      const weights = await weightOf(tx, ids);
      if (!state.dryRun) {
        const done = await deleteRuns(tx, state, state.runLogCutoff, ids);
        doomed = done.deleted;
        skipped = done.skipped;
      }
      // Counted from the runs that actually went (what the DELETE returned), never from the ids the select proposed: the delete re-asserts the
      // predicate and may decline a run, and a run that stayed still holds its lines and tokens.
      counts.runs += doomed.length;
      counts.runsSkipped += skipped.length;
      for (const id of doomed) {
        counts.runSourceLines += weights.get(id)?.lines ?? 0;
        counts.runTokens += weights.get(id)?.tokens ?? 0;
      }
      const last = rows[rows.length - 1]!;
      cursor = `${last.ended_at}|${last.id}`;
    }
    if (rows.length < batch.runs) {
      phase = 'log';
      cursor = null;
    }
  } else if (phase === 'log') {
    const res = (
      await tx.query<{ pruned: number; last_id: string | null; exhausted: boolean }>(
        'SELECT pruned, last_id, exhausted FROM app.memory_retain_log_prune($1::uuid, $2::timestamptz, $3::uuid, $4::int, $5::boolean)',
        [state.workspaceId, state.memoryLogCutoff, cursor, batch.logLines, state.dryRun],
      )
    ).rows[0];
    counts.memoryLogLines += res?.pruned ?? 0;
    if (res === undefined || res.exhausted || res.last_id === null) {
      phase = 'memos';
      cursor = null;
    } else {
      cursor = res.last_id;
    }
  } else {
    // Memos of bots that are gone. Counted, and removed in batches (a dry run counts all of them in one go).
    if (state.dryRun) {
      counts.memosRemoved += (
        await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.memory_run_memo m WHERE m.workspace_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM app.bots b WHERE b.id = m.bot_id)',
          [state.workspaceId],
        )
      ).rows[0]!.n;
      return finish(state, counts);
    }
    const removed = (
      await tx.query<{ n: number }>(
        `WITH doomed AS (
           SELECT m.run_id FROM app.memory_run_memo m
            WHERE m.workspace_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM app.bots b WHERE b.id = m.bot_id)
            LIMIT $2
         ), gone AS (DELETE FROM app.memory_run_memo WHERE run_id IN (SELECT run_id FROM doomed) RETURNING 1)
         SELECT count(*)::int AS n FROM gone`,
        [state.workspaceId, batch.runs],
      )
    ).rows[0]?.n ?? 0;
    counts.memosRemoved += removed;
    if (removed < batch.runs) return finish(state, counts);
  }
  return { done: false, state: { ...state, phase, cursor, counts, step: state.step + 1 } };
}

function finish(state: SweepState, counts: RetentionCounts): StepResult {
  const finishedAt = new Date();
  return {
    done: true,
    durationMs: Math.max(0, finishedAt.getTime() - Date.parse(state.startedAt)),
    summary: {
      sweepId: state.sweepId,
      dryRun: state.dryRun,
      startedAt: state.startedAt,
      finishedAt: finishedAt.toISOString(),
      runLogCutoff: state.runLogCutoff,
      memoryLogCutoff: state.memoryLogCutoff,
      counts,
    },
  };
}
