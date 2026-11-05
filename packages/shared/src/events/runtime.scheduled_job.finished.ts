import { z } from 'zod';
import { BotId, ScheduledJobRunId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A scheduled job's firing is settled by the runtime (PLAN P6-08): `done` (a routine's page was written, a heartbeat or task run finished) or `failed`
 * with a plain reason (the bot cannot be woken, the run produced no output, the page could not be written). `runId` is null when no run was
 * opened. `outputPath` and `commitSha` are set when a page was committed. The reason never carries model output or error text.
 */
export const RuntimeScheduledJobFinishedEvent = z.object({
  type: z.literal('runtime.scheduled_job.finished'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  scheduledJobRunId: ScheduledJobRunId,
  runId: RunId.nullable(),
  status: z.enum(['done', 'failed']),
  reason: z.string().max(500),
  outputPath: z.string().nullable(),
  commitSha: z.string().nullable(),
});
export type RuntimeScheduledJobFinishedEvent = z.infer<typeof RuntimeScheduledJobFinishedEvent>;
