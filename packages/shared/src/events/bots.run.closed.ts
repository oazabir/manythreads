import { z } from 'zod';
import { BotId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A bot's run ended: the run service closed it (`done`, `failed`, or `stopped` for a run that waits for an approval or was refused before the
 * model). Emitted once per run, by the transition out of `running`; a repeated close writes nothing. Carries ids and the trigger, never what the run
 * read or said (that is `run_source_log` and the thread). The `memory` plugin feeds a run summary into the team's bank from it (PLAN P5-13).
 */
export const BotsRunClosedEvent = z.object({
  type: z.literal('bots.run.closed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  runId: RunId,
  /** The BOT.md trigger that fired the run (`BotRunTrigger`; kept a string so a new trigger never makes an old event unreadable). */
  trigger: z.string().min(1),
  status: z.enum(['done', 'failed', 'stopped']),
});
export type BotsRunClosedEvent = z.infer<typeof BotsRunClosedEvent>;
