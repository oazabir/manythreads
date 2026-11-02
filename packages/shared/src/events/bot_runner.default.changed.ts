import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** The workspace's default runner (what a bot with no placement runs on) changed. Null on either side means none. */
export const BotRunnerDefaultChangedEvent = z.object({
  type: z.literal('bot_runner.default.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId.nullable(),
  previousRunnerId: BotRunnerId.nullable(),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerDefaultChangedEvent = z.infer<typeof BotRunnerDefaultChangedEvent>;
