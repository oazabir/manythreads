import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** Who may use a runner changed: it was switched on or off, or its team list changed. Counts only, never team names. */
export const BotRunnerAvailabilityChangedEvent = z.object({
  type: z.literal('bot_runner.availability.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  enabled: z.boolean(),
  allTeams: z.boolean(),
  /** Teams on the list (0 when every team may use it). */
  teamCount: z.number().int().min(0),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerAvailabilityChangedEvent = z.infer<typeof BotRunnerAvailabilityChangedEvent>;
