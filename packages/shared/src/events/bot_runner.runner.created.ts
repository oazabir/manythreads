import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerKind, BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** A workspace admin made a runner (or adopted a team's old connection into one). Ids, the name and the kind only: never an address, a key or a sign-in. */
export const BotRunnerCreatedEvent = z.object({
  type: z.literal('bot_runner.runner.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  kind: BotRunnerKind,
  /** True when the runner came from a team's old connection. */
  adopted: z.boolean(),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerCreatedEvent = z.infer<typeof BotRunnerCreatedEvent>;
