import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ReassessmentReason } from '../entities/replay.ts';
import { BotId, BotReassessmentId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * Something a bot depends on changed, or its eval score dropped, and a "check this again" notice was filed for it (PLAN P7-07). One event per bot and notice. No model was
 * called: the notice is a fixed list of things to look at. Names and ids only: `subject` is the name of the knowledge base or runner (configuration), never content.
 */
export const WorkshopReassessmentCreatedEvent = z.object({
  type: z.literal('workshop.reassessment.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  reassessmentId: BotReassessmentId,
  reason: ReassessmentReason,
  subject: z.string().max(100),
  at: IsoDateTime,
});
export type WorkshopReassessmentCreatedEvent = z.infer<typeof WorkshopReassessmentCreatedEvent>;
