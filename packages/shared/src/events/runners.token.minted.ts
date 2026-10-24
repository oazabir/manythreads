import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, RunnerId, TeamId, WorkspaceId } from '../ids.ts';

/** A runner token was minted (PLAN P6-06): who did it and for which runner. Never the token or its hash. */
export const RunnersTokenMintedEvent = z.object({
  type: z.literal('runners.token.minted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  runnerId: RunnerId,
  actorId: ActorId,
  at: IsoDateTime,
});
export type RunnersTokenMintedEvent = z.infer<typeof RunnersTokenMintedEvent>;
