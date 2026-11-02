import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { BotId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A run on a Hermes pod finished and the model gateway has no spend line for it, so the run did not go through the platform's model gateway (or the gateway did not count it).
 * The platform wants every pod run metered. Ids and the runner's name only: no text, key or address.
 */
export const BotRunnerRunUnmeteredEvent = z.object({
  type: z.literal('bot_runner.run.unmetered'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  runId: RunId,
  runner: BotRunnerName,
  at: IsoDateTime,
});
export type BotRunnerRunUnmeteredEvent = z.infer<typeof BotRunnerRunUnmeteredEvent>;
