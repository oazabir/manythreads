import { z } from 'zod';
import { BotId, RhythmRunId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The bot's run for a rhythm's firing opened (PLAN P6-08). Emitted by the runtime in the transaction that opens the run; the rhythms plugin
 * moves the firing from `queued` to `running` and records the run's id. Ids only.
 */
export const RuntimeRhythmStartedEvent = z.object({
  type: z.literal('runtime.rhythm.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  rhythmRunId: RhythmRunId,
  runId: RunId,
});
export type RuntimeRhythmStartedEvent = z.infer<typeof RuntimeRhythmStartedEvent>;
