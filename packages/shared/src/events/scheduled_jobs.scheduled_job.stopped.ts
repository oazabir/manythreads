import { z } from 'zod';
import { PersonalRoutineStopReason } from '../entities/scheduled-job.ts';
import { BotId, PersonId, ScheduledJobId, WorkspaceId } from '../ids.ts';

/**
 * The platform switched a personal routine off (its bot is off, the person's consent or connection is gone, they were deactivated, or it used up the month's
 * spending allowance) and sent its owner one plain message. The owner turns it on again from the routine. Carries the reason code only, never the routine's words.
 */
export const ScheduledJobsScheduledJobStoppedEvent = z.object({
  type: z.literal('scheduled_jobs.scheduled_job.stopped'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  scheduledJobId: ScheduledJobId,
  ownerPersonId: PersonId,
  botId: BotId,
  reason: PersonalRoutineStopReason,
});
export type ScheduledJobsScheduledJobStoppedEvent = z.infer<typeof ScheduledJobsScheduledJobStoppedEvent>;
