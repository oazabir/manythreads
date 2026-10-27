import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { BotsRunClosedEvent, RhythmsRhythmRanEvent, RuntimeRhythmFinishedEvent, RuntimeRhythmStartedEvent } from '@manythreads/shared';
import type { RhythmRunRow } from './rows.ts';

// The run ledger after a firing is queued (PLAN P6-08). The runtime tells this plugin what became of the bot's run through events, and this
// plugin alone writes its own `rhythm_runs` rows (an event subscriber runs as the system role, the only role the table lets write):
//
//   queued  --runtime.rhythm.started-->  running  --runtime.rhythm.finished-->  done | failed
//
// `bots.run.closed` is the safety net: a run that ended `failed` or `stopped` (held for an approval, stopped by the stale-run reaper) without the
// runtime getting to say so settles the firing as failed. A `done` close is never trusted on its own, because only the runtime knows whether the
// routine's page was written. Every update names the states it may leave, so a repeated or late event changes nothing.

interface Settled extends RhythmRunRow {
  workspace_id: string;
  bot_id: string;
  kind: string;
  task_id: string | null;
}

/** Move one firing along and announce the new state with `rhythms.rhythm.ran`. Answers false when the firing was already past `from`. */
async function advance(
  ctx: PluginContext,
  tx: PluginTx,
  match: { id?: string; runId?: string },
  from: readonly string[],
  to: { status: 'running' | 'done' | 'failed'; runId?: string | null; reason?: string; outputPath?: string | null },
  /** Skip a firing the runtime has already settled in an event that is still on its way here (see the `bots.run.closed` handler). */
  unlessRuntimeSettled = false,
): Promise<boolean> {
  const row = (
    await tx.query<Settled>(
      `UPDATE app.rhythm_runs r
          SET status = $3,
              run_id = coalesce($4::uuid, r.run_id),
              reason = CASE WHEN $3 = 'running' THEN r.reason ELSE left($5, 500) END,
              output_path = coalesce($6, r.output_path),
              ended_at = CASE WHEN $3 = 'running' THEN NULL ELSE now() END
         FROM app.rhythms h
        WHERE h.id = r.rhythm_id AND r.status = ANY ($7::text[])
          AND ($1::uuid IS NULL OR r.id = $1::uuid)
          -- by run id; or, for a firing whose started event has not been handled yet (run_id still null), by the job that opened the run
          AND ($2::uuid IS NULL OR r.run_id = $2::uuid
               OR (r.run_id IS NULL AND EXISTS (SELECT 1 FROM app.bot_runs br JOIN app.jobs j ON j.id = br.job_id
                                                 WHERE br.id = $2::uuid AND j.dedupe_key LIKE '%:rhythm:' || r.id::text)))
          -- bounded to this workspace, this type and the firing's own lifetime, so it reads a handful of recent events, not the table
          AND NOT ($8::boolean AND EXISTS (SELECT 1 FROM app.events ev WHERE ev.workspace_id = h.workspace_id AND ev.type = 'runtime.rhythm.finished'
                                              AND ev.occurred_at >= r.started_at AND ev.payload ->> 'rhythmRunId' = r.id::text))
      RETURNING r.id, r.rhythm_id, r.team_id, r.run_id, r.task_id, r.status, r.output_path, r.reason, r.started_at, r.ended_at,
                h.workspace_id, h.bot_id, h.kind, h.name`,
      [match.id ?? null, match.runId ?? null, to.status, to.runId ?? null, to.reason ?? '', to.outputPath ?? null, [...from], unlessRuntimeSettled],
    )
  ).rows[0];
  if (!row) return false;
  await ctx.audit.emit(
    tx,
    RhythmsRhythmRanEvent.parse({
      type: 'rhythms.rhythm.ran',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      rhythmId: row.rhythm_id,
      rhythmRunId: row.id,
      botId: row.bot_id,
      kind: row.kind,
      status: row.status,
      outputPath: row.output_path,
      taskId: row.task_id,
      reason: row.reason,
      rhythmName: String(row['name'] ?? ''),
    }),
  );
  return true;
}

export function registerLedger(ctx: PluginContext): void {
  ctx.events.subscribe('runtime.rhythm.started', async (raw: PluginEvent, tx: PluginTx) => {
    const e = RuntimeRhythmStartedEvent.parse(raw);
    await advance(ctx, tx, { id: e.rhythmRunId }, ['queued'], { status: 'running', runId: e.runId });
    // The run may already be over (its close was handled first, or on another replica): a firing must not wait for an end that has passed.
    const closed = (await tx.query<{ status: string }>(`SELECT status FROM app.bot_runs WHERE id = $1::uuid AND status <> 'running'`, [e.runId])).rows[0];
    if (closed && closed.status !== 'done') await settleClosed(ctx, tx, e.runId, closed.status);
  });

  ctx.events.subscribe('runtime.rhythm.finished', async (raw: PluginEvent, tx: PluginTx) => {
    const e = RuntimeRhythmFinishedEvent.parse(raw);
    await advance(ctx, tx, { id: e.rhythmRunId }, ['queued', 'running'], {
      status: e.status,
      runId: e.runId,
      reason: e.status === 'failed' ? e.reason : '',
      outputPath: e.outputPath,
    });
  });

  ctx.events.subscribe('bots.run.closed', async (raw: PluginEvent, tx: PluginTx) => {
    const e = BotsRunClosedEvent.parse(raw);
    if (e.trigger !== 'routine' || e.status === 'done') return;
    await settleClosed(ctx, tx, e.runId, e.status);
  });
}

/** A run ended without a `finished` report: settle its firing failed. */
async function settleClosed(ctx: PluginContext, tx: PluginTx, runId: string, status: string): Promise<void> {
    // The runtime says why a run failed in `runtime.rhythm.finished`, written before it closes the run; the two events can be delivered in either
    // order, so a close only settles a firing the runtime never reported on (a gate hold, a stale-run reaper, a crashed worker).
    await advance(
      ctx,
      tx,
      { runId },
      ['queued', 'running'],
      {
        status: 'failed',
        runId,
        reason: status === 'stopped' ? 'The run stopped before it finished (it was held for a person to approve, or a guard refused it).' : 'The run failed before it finished.',
      },
      true,
    );
}

/** A firing the runtime never picked up (the job died before the run opened, an old row) is failed after this long queued. */
export const QUEUED_TIMEOUT_MINUTES = 15;
/** A run is stopped by its own time limit long before this; a firing still `running` after it lost its end. */
export const RUNNING_TIMEOUT_MINUTES = 120;

/**
 * The watchdog (part of the tick job): no firing stays `queued` or `running` for ever. Each one past its time limit becomes `failed` with a plain
 * reason, through the same step as every other change, so it is announced like them. Also clears rows left queued before the runtime started them.
 */
export async function failStuckFirings(ctx: PluginContext, tx: PluginTx, now: Date = new Date()): Promise<number> {
  const stuck = (
    await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM app.rhythm_runs
        WHERE (status = 'queued' AND started_at < $1::timestamptz - make_interval(mins => $2))
           OR (status = 'running' AND started_at < $1::timestamptz - make_interval(mins => $3))
        ORDER BY started_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [now, QUEUED_TIMEOUT_MINUTES, RUNNING_TIMEOUT_MINUTES],
    )
  ).rows;
  let n = 0;
  for (const row of stuck) {
    const reason =
      row.status === 'queued'
        ? 'The bot was never started for this firing (nothing picked it up in time).'
        : 'The run did not report an end in time, so the firing was closed.';
    if (await advance(ctx, tx, { id: row.id }, [row.status], { status: 'failed', reason })) n += 1;
  }
  return n;
}
