import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** A runner was checked. Whether it answered; the sentence the page shows is fixed, never the remote side's own words. */
export const BotRunnerTestedEvent = z.object({
  type: z.literal('bot_runner.runner.tested'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  ok: z.boolean(),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerTestedEvent = z.infer<typeof BotRunnerTestedEvent>;
