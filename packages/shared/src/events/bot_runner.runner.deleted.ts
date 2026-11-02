import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerKind, BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** A workspace admin deleted a runner that no bot was placed on. */
export const BotRunnerDeletedEvent = z.object({
  type: z.literal('bot_runner.runner.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  kind: BotRunnerKind,
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerDeletedEvent = z.infer<typeof BotRunnerDeletedEvent>;
