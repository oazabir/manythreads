import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** A workspace admin changed a runner. Which settings changed, by fixed name; never the old or the new value. */
export const BotRunnerUpdatedEvent = z.object({
  type: z.literal('bot_runner.runner.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  changed: z.array(z.enum(['label', 'address', 'key', 'profile_rule', 'node', 'model_alias', 'enabled'])).min(1),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerUpdatedEvent = z.infer<typeof BotRunnerUpdatedEvent>;
