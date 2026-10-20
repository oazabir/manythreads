import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, RhythmId, RhythmRunId, RunId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

// Rhythms (SPEC §6.5, PLAN P6-08): a prompt on a timer (heartbeat), a contract with a page output (routine), or a recurring task.
// The scheduler runs on the kernel's job queue; `nextRunAt` is what the screen shows and what each tick advances.

export const RhythmKind = z.enum(['heartbeat', 'routine', 'task']);
export type RhythmKind = z.infer<typeof RhythmKind>;

/** `queued` until a worker starts it; then `running`, and `done` or `failed` with a reason. */
export const RhythmRunStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type RhythmRunStatus = z.infer<typeof RhythmRunStatus>;

/** A 5-field cron expression in UTC (`0 9 * * mon-fri`), validated by the shared parser when the rhythm is created. */
export const CronExpression = z
  .string()
  .trim()
  .regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'a 5-field cron expression in UTC, e.g. "0 9 * * mon-fri"');
export type CronExpression = z.infer<typeof CronExpression>;

export const RhythmEffort = z.enum(['low', 'medium', 'high']);
export type RhythmEffort = z.infer<typeof RhythmEffort>;

export const Rhythm = z.object({
  id: RhythmId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  /** The bot that runs it. A rhythm always runs as a bot, never as the person who created it. */
  botId: BotId,
  name: z.string().min(1).max(80),
  kind: RhythmKind,
  schedule: CronExpression,
  /** Overrides the bot's alias for this rhythm (`fast` for an hourly heartbeat); null uses the bot's own. */
  modelAlias: z.string().min(1).max(40).nullable(),
  /** `thinking` effort passed to the runtime; null leaves the runtime's default. */
  effort: RhythmEffort.nullable(),
  /** For a routine: the repo path of its contract (`routines/<slug>.yaml`). Null for a heartbeat or a task. */
  contractPath: z.string().min(1).max(300).nullable(),
  /** For a routine: the page the output is written to. */
  outputPath: z.string().min(1).max(300).nullable(),
  enabled: z.boolean(),
  nextRunAt: IsoDateTime.nullable(),
  createdBy: ActorId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Rhythm = z.infer<typeof Rhythm>;

export const RhythmRun = z.object({
  id: RhythmRunId,
  rhythmId: RhythmId,
  teamId: TeamId,
  /** The bot run the rhythm opened, once a runtime opened one. */
  runId: RunId.nullable(),
  /** The task a `task` rhythm created. */
  taskId: TaskId.nullable(),
  status: RhythmRunStatus,
  /** The page a routine wrote (or was asked to write). */
  outputPath: z.string().nullable(),
  /** Why it failed, or what it did, in one line; empty while it runs. */
  reason: z.string().max(500),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
});
export type RhythmRun = z.infer<typeof RhythmRun>;
