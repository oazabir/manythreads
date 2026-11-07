import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { ScheduledJobsScheduledJobRanEvent, RoutineContract, nextCronRun } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { toScheduledJobRun, type ScheduledJobRow, type ScheduledJobRunRow } from './rows.ts';

// The contract schema lives in @manythreads/shared (entities/routine.ts) so the recipe gallery checks its routines with the same rules; re-exported here for this plugin's callers.
export { RoutineContract };

export const TICK_QUEUE = 'scheduled-jobs.tick';

interface StartResult {
  run: ScheduledJobRunRow;
  outPath: string | null;
}

/** Read and check a routine's contract; throws with the reason the run should fail with. */
async function routineContract(ctx: PluginContext, tx: PluginTx, scheduledJob: ScheduledJobRow): Promise<RoutineContract> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the team repo is not available, so the routine contract cannot be read');
  if (!scheduledJob.contract_path) throw new Error('a routine needs a contract path');
  let text: string;
  try {
    const blob = await repo.blob(tx, scheduledJob.team_id, scheduledJob.contract_path, 'main');
    text = Buffer.from(blob.content).toString('utf8');
  } catch {
    throw new Error(`the contract ${scheduledJob.contract_path} is missing or unreadable`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new Error(`the contract ${scheduledJob.contract_path} is not valid YAML`);
  }
  const parsed = RoutineContract.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`the contract ${scheduledJob.contract_path} is invalid: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
  }
  return parsed.data;
}

/**
 * File one run of `scheduled job`. A routine is checked against its contract first: a bad one is a `failed` run with the reason (the screen says
 * why) and nothing is queued for a runtime. A `task` scheduled job creates its card; a heartbeat just queues. A queued run carries what the runtime
 * needs to start the bot (see `ScheduledJobsScheduledJobRanEvent`); `runtime-hermes` picks it up from the event. The run row and its event are written
 * in the caller's transaction, so a crash cannot leave a queued run unrecorded.
 */
export async function startScheduledJobRun(ctx: PluginContext, tx: PluginTx, scheduledJob: ScheduledJobRow, now: Date = new Date()): Promise<StartResult> {
  let status: 'queued' | 'failed' = 'queued';
  let reason = '';
  let outputPath: string | null = scheduledJob.output_path ?? null;
  let taskId: string | null = null;
  let contract: RoutineContract | null = null;

  if (scheduledJob.kind === 'routine') {
    try {
      contract = await routineContract(ctx, tx, scheduledJob);
      outputPath = scheduledJob.output_path ?? contract.output.page;
    } catch (err) {
      status = 'failed';
      reason = err instanceof Error ? err.message.slice(0, 500) : 'the contract could not be read';
    }
  }
  // One system-owned door files the run (and a task scheduled job's card), so the tick job and a lead's “run now” write the ledger the same way and a
  // card's `created_by` is the scheduled job's creator, never the caller.
  const row = (
    await tx.query<ScheduledJobRunRow>('SELECT * FROM app.scheduled_jobs_fire($1::uuid, $2, $3, $4)', [
      scheduledJob.id,
      now,
      status === 'failed' ? null : outputPath,
      status === 'failed' ? reason : null,
    ])
  ).rows[0];
  if (!row) throw new Error('the scheduled job run was not recorded');
  taskId = row.task_id;
  outputPath = row.output_path;

  await ctx.audit.emit(
    tx,
    ScheduledJobsScheduledJobRanEvent.parse({
      type: 'scheduled_jobs.scheduled_job.ran',
      schemaVersion: 1,
      workspaceId: scheduledJob.workspace_id,
      teamId: scheduledJob.team_id,
      scheduledJobId: scheduledJob.id,
      scheduledJobRunId: row.id,
      botId: scheduledJob.bot_id,
      kind: scheduledJob.kind,
      status,
      outputPath,
      taskId,
      reason,
      scheduledJobName: scheduledJob.name,
      // What the runtime needs to start the bot: the contract's own words and output mode (a failed contract never starts one).
      prompt: status === 'queued' ? (contract?.prompt ?? '') : '',
      outputMode: status === 'queued' && contract ? contract.output.mode : null,
      modelAlias: scheduledJob.model_alias,
      effort: scheduledJob.effort,
    }),
  );
  return { run: row, outPath: outputPath };
}

/** The first whole minute after `from` that the schedule fires, or null for a schedule that never fires. */
export function nextRunFor(schedule: string, from: Date): Date | null {
  try {
    return nextCronRun(schedule, from);
  } catch {
    return null;
  }
}

/**
 * One tick (the `scheduled-jobs.tick` job): every enabled scheduled job whose `next_run_at` has passed fires once, and its next slot is advanced in the
 * same transaction. `FOR UPDATE SKIP LOCKED` keeps two replicas from firing the same scheduled job in one tick; a slot that passed while the server
 * was down is not replayed twenty times — the schedule advances to the next future slot.
 */
export async function tickScheduledJobs(ctx: PluginContext, tx: PluginTx, now: Date = new Date()): Promise<number> {
  const due = (
    await tx.query<ScheduledJobRow>('SELECT * FROM app.scheduled_jobs WHERE enabled AND team_id IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= $1 FOR UPDATE SKIP LOCKED', [now])
  ).rows;
  for (const scheduledJob of due) {
    await startScheduledJobRun(ctx, tx, scheduledJob, now);
    const next = nextRunFor(scheduledJob.schedule, now);
    await tx.query('UPDATE app.scheduled_jobs SET next_run_at = $2, updated_at = now() WHERE id = $1::uuid', [scheduledJob.id, next]);
  }
  return due.length;
}

export { toScheduledJobRun };
