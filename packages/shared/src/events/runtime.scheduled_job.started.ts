import { z } from 'zod';
import { BotId, ScheduledJobRunId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The bot's run for a scheduled job's firing opened (PLAN P6-08). Emitted by the runtime in the transaction that opens the run; the scheduled jobs plugin
 * moves the firing from `queued` to `running` and records the run's id. Ids only.
 */
export const RuntimeScheduledJobStartedEvent = z.object({
  type: z.literal('runtime.scheduled_job.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  scheduledJobRunId: ScheduledJobRunId,
  runId: RunId,
});
export type RuntimeScheduledJobStartedEvent = z.infer<typeof RuntimeScheduledJobStartedEvent>;
