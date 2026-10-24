import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, RunnerId, TeamId, WorkspaceId } from '../ids.ts';

/** Every live token of a runner was revoked (PLAN P6-06): who did it, and how many tokens that turned off. */
export const RunnersTokenRevokedEvent = z.object({
  type: z.literal('runners.token.revoked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  runnerId: RunnerId,
  actorId: ActorId,
  revoked: z.number().int().min(0),
  at: IsoDateTime,
});
export type RunnersTokenRevokedEvent = z.infer<typeof RunnersTokenRevokedEvent>;
