import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { BotId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/** Why a run was refused before anything started. A fixed list of words, so the event holds no address, key, node or text. */
export const BotRunnerRunRefusedReason = z.enum(['unknown', 'disabled', 'not_available_to_team', 'not_runnable', 'not_set_up', 'not_ready']);
export type BotRunnerRunRefusedReason = z.infer<typeof BotRunnerRunRefusedReason>;

/**
 * A bot's run was turned away at the start because the runner it is placed on cannot take it (switched off, not open to the team, not set up, not ready, or gone). No process was
 * started and no gateway was called. Ids and the runner's name and a reason from a fixed list only.
 */
export const BotRunnerRunRefusedEvent = z.object({
  type: z.literal('bot_runner.run.refused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  runId: RunId,
  runner: BotRunnerName,
  reason: BotRunnerRunRefusedReason,
  at: IsoDateTime,
});
export type BotRunnerRunRefusedEvent = z.infer<typeof BotRunnerRunRefusedEvent>;
