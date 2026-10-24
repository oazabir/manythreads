import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A bot's run was placed on a runner and could not be sent: the runner is unknown, not connected to this server, full, or the connection
 * dropped before the job was accepted. `reason` is the sentence the run reports (no message text, no token). The run itself closes `failed`.
 */
export const RunnersJobRefusedEvent = z.object({
  type: z.literal('runners.job.refused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  runId: RunId,
  runner: z.string().min(1).max(80),
  reason: z.string().min(1).max(500),
  at: IsoDateTime,
});
export type RunnersJobRefusedEvent = z.infer<typeof RunnersJobRefusedEvent>;
