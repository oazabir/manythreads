import { z } from 'zod';
import { ScheduledJobKind, ScheduledJobRunStatus } from '../entities/scheduled-job.ts';
import { BotId, ScheduledJobId, ScheduledJobRunId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A scheduled job's run changed state (PLAN P6-08): filed as `queued` (the runtime then starts the bot), `running` when the bot's run opened, and
 * `done` or `failed` with the reason (a bad contract, a bot that cannot be woken, a run that wrote no output).
 */
export const ScheduledJobsScheduledJobRanEvent = z.object({
  type: z.literal('scheduled_jobs.scheduled_job.ran'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  scheduledJobId: ScheduledJobId,
  scheduledJobRunId: ScheduledJobRunId,
  botId: BotId,
  kind: ScheduledJobKind,
  status: ScheduledJobRunStatus,
  outputPath: z.string().nullable(),
  taskId: TaskId.nullable(),
  reason: z.string().max(500),
  /**
   * What the runtime needs to start a queued run, so it never reads the scheduled job's tables or contract file itself (added after the first
   * release of this event; an older event without them reads as empty): the scheduled job's name, the routine contract's prompt and output
   * mode, and the scheduled job's own model alias and effort overrides.
   */
  scheduledJobName: z.string().max(80).default(''),
  prompt: z.string().max(20_000).default(''),
  outputMode: z.enum(['create', 'replace', 'append']).nullable().default(null),
  modelAlias: z.string().max(40).nullable().default(null),
  effort: z.enum(['low', 'medium', 'high']).nullable().default(null),
});
export type ScheduledJobsScheduledJobRanEvent = z.infer<typeof ScheduledJobsScheduledJobRanEvent>;
