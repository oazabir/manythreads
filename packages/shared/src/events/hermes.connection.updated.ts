import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { HermesConnectionAgent, HermesConnectionName } from '../entities/hermes.ts';
import { ActorId, HermesConnectionId, TeamId, WorkspaceId } from '../ids.ts';

/** A connection's address or key changed. `keyChanged` says whether the key was replaced (the key itself is never in an event). */
export const HermesConnectionUpdatedEvent = z.object({
  type: z.literal('hermes.connection.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  connectionId: HermesConnectionId,
  name: HermesConnectionName,
  baseUrlChanged: z.boolean(),
  keyChanged: z.boolean(),
  agent: HermesConnectionAgent.optional(),
  actorId: ActorId.nullable(),
  at: IsoDateTime,
});
export type HermesConnectionUpdatedEvent = z.infer<typeof HermesConnectionUpdatedEvent>;
