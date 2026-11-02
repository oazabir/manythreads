import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ReassessmentAnswer } from '../entities/replay.ts';
import { BotId, BotReassessmentId, TeamId, WorkspaceId } from '../ids.ts';

/** A lead or an admin closed a "check this again" notice: they checked it (`done`) or said it does not matter (`dismissed`) (PLAN P7-07). */
export const WorkshopReassessmentClosedEvent = z.object({
  type: z.literal('workshop.reassessment.closed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  reassessmentId: BotReassessmentId,
  answer: ReassessmentAnswer,
  at: IsoDateTime,
});
export type WorkshopReassessmentClosedEvent = z.infer<typeof WorkshopReassessmentClosedEvent>;
