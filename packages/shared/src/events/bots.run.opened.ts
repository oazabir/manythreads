import { z } from 'zod';
import { BotId, RunId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A bot's run on a card began (the run service wrote the run row with a `taskId`). Emitted only for runs that name a card, once per run, so a
 * board can show that a bot is working on it; the matching end is `bots.run.closed`. Carries ids and the trigger, never what the run reads or says.
 */
export const BotsRunOpenedEvent = z.object({
  type: z.literal('bots.run.opened'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  runId: RunId,
  trigger: z.string().min(1),
  taskId: TaskId,
});
export type BotsRunOpenedEvent = z.infer<typeof BotsRunOpenedEvent>;
