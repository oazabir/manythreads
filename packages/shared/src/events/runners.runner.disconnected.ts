import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { RunnerId, TeamId, WorkspaceId } from '../ids.ts';

/** A runner's connection ended: it closed it, it fell silent past the heartbeat limit, its token was revoked, or a newer connection replaced it. */
export const RunnersRunnerDisconnectedEvent = z.object({
  type: z.literal('runners.runner.disconnected'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  runnerId: RunnerId,
  name: z.string().min(1).max(80),
  reason: z.enum(['closed', 'silent', 'revoked', 'replaced', 'protocol']),
  at: IsoDateTime,
});
export type RunnersRunnerDisconnectedEvent = z.infer<typeof RunnersRunnerDisconnectedEvent>;
