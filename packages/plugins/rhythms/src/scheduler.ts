import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { RhythmsRhythmRanEvent, nextCronRun } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { toRhythmRun, type RhythmRow, type RhythmRunRow } from './rows.ts';

/** The routine contract at `routines/<slug>.yaml` (SPEC §6.5): a name, a prompt and where its output goes. */
export const RoutineContract = z.object({
  name: z.string().min(1).max(80),
  prompt: z.string().min(1).max(20_000).optional(),
  output: z.object({
    page: z
      .string()
      .max(300, 'the output page path is at most 300 characters')
      .regex(/^pages\//, 'the output page lives under pages/')
      .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'the output page path must not contain empty, . or .. parts'),
    mode: z.enum(['create', 'replace', 'append']).default('replace'),
  }),
});
export type RoutineContract = z.infer<typeof RoutineContract>;

export const TICK_QUEUE = 'rhythms.tick';

interface StartResult {
  run: RhythmRunRow;
  outPath: string | null;
}

/** Read and check a routine's contract; throws with the reason the run should fail with. */
async function routineContract(ctx: PluginContext, tx: PluginTx, rhythm: RhythmRow): Promise<RoutineContract> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the team repo is not available, so the routine contract cannot be read');
  if (!rhythm.contract_path) throw new Error('a routine needs a contract path');
  let text: string;
  try {
    const blob = await repo.blob(tx, rhythm.team_id, rhythm.contract_path, 'main');
    text = Buffer.from(blob.content).toString('utf8');
  } catch {
    throw new Error(`the contract ${rhythm.contract_path} is missing or unreadable`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new Error(`the contract ${rhythm.contract_path} is not valid YAML`);
  }
  const parsed = RoutineContract.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`the contract ${rhythm.contract_path} is invalid: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
  }
  return parsed.data;
}

/**
 * File one run of `rhythm`. A routine is checked against its contract first: a bad one is a `failed` run with the reason (the screen says
 * why) and nothing is queued for a runtime. A `task` rhythm creates its card; a heartbeat just queues. A queued run carries what the runtime
 * needs to start the bot (see `RhythmsRhythmRanEvent`); `runtime-hermes` picks it up from the event. The run row and its event are written
 * in the caller's transaction, so a crash cannot leave a queued run unrecorded.
 */
export async function startRhythmRun(ctx: PluginContext, tx: PluginTx, rhythm: RhythmRow, now: Date = new Date()): Promise<StartResult> {
  let status: 'queued' | 'failed' = 'queued';
  let reason = '';
  let outputPath: string | null = rhythm.output_path ?? null;
  let taskId: string | null = null;
  let contract: RoutineContract | null = null;

  if (rhythm.kind === 'routine') {
    try {
      contract = await routineContract(ctx, tx, rhythm);
      outputPath = rhythm.output_path ?? contract.output.page;
    } catch (err) {
      status = 'failed';
      reason = err instanceof Error ? err.message.slice(0, 500) : 'the contract could not be read';
    }
  }
  // One system-owned door files the run (and a task rhythm's card), so the tick job and a lead's “run now” write the ledger the same way and a
  // card's `created_by` is the rhythm's creator, never the caller.
  const row = (
    await tx.query<RhythmRunRow>('SELECT * FROM app.rhythms_fire($1::uuid, $2, $3, $4)', [
      rhythm.id,
      now,
      status === 'failed' ? null : outputPath,
      status === 'failed' ? reason : null,
    ])
  ).rows[0];
  if (!row) throw new Error('the rhythm run was not recorded');
  taskId = row.task_id;
  outputPath = row.output_path;

  await ctx.audit.emit(
    tx,
    RhythmsRhythmRanEvent.parse({
      type: 'rhythms.rhythm.ran',
      schemaVersion: 1,
      workspaceId: rhythm.workspace_id,
      teamId: rhythm.team_id,
      rhythmId: rhythm.id,
      rhythmRunId: row.id,
      botId: rhythm.bot_id,
      kind: rhythm.kind,
      status,
      outputPath,
      taskId,
      reason,
      rhythmName: rhythm.name,
      // What the runtime needs to start the bot: the contract's own words and output mode (a failed contract never starts one).
      prompt: status === 'queued' ? (contract?.prompt ?? '') : '',
      outputMode: status === 'queued' && contract ? contract.output.mode : null,
      modelAlias: rhythm.model_alias,
      effort: rhythm.effort,
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
 * One tick (the `rhythms.tick` job): every enabled rhythm whose `next_run_at` has passed fires once, and its next slot is advanced in the
 * same transaction. `FOR UPDATE SKIP LOCKED` keeps two replicas from firing the same rhythm in one tick; a slot that passed while the server
 * was down is not replayed twenty times — the schedule advances to the next future slot.
 */
export async function tickRhythms(ctx: PluginContext, tx: PluginTx, now: Date = new Date()): Promise<number> {
  const due = (
    await tx.query<RhythmRow>('SELECT * FROM app.rhythms WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 FOR UPDATE SKIP LOCKED', [now])
  ).rows;
  for (const rhythm of due) {
    await startRhythmRun(ctx, tx, rhythm, now);
    const next = nextRunFor(rhythm.schedule, now);
    await tx.query('UPDATE app.rhythms SET next_run_at = $2, updated_at = now() WHERE id = $1::uuid', [rhythm.id, next]);
  }
  return due.length;
}

export { toRhythmRun };
