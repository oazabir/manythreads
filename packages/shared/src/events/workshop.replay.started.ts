import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, RunId, TeamId, WorkspaceId, WorkshopSessionId } from '../ids.ts';

/**
 * A lead or an admin confirmed a FULL replay of one earlier run (the bot answering the same message again, in the Rehearse sandbox where every write is held back) after seeing its
 * cost (PLAN P7-07). `tokens` is the estimate they confirmed. Ids and a number only: the message is read by the server and is not in the event.
 */
export const WorkshopReplayStartedEvent = z.object({
  type: z.literal('workshop.replay.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  runId: RunId,
  sessionId: WorkshopSessionId,
  tokens: z.number().int().min(0),
  at: IsoDateTime,
});
export type WorkshopReplayStartedEvent = z.infer<typeof WorkshopReplayStartedEvent>;
