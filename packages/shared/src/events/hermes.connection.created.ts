import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { HermesConnectionKind, HermesConnectionName } from '../entities/hermes.ts';
import { ActorId, HermesConnectionId, TeamId, WorkspaceId } from '../ids.ts';

/** A team's Hermes connection was made (a lead or admin added a gateway, or the platform registered the team's own pod). Never the address's credentials or the key. */
export const HermesConnectionCreatedEvent = z.object({
  type: z.literal('hermes.connection.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  connectionId: HermesConnectionId,
  name: HermesConnectionName,
  kind: HermesConnectionKind,
  actorId: ActorId.nullable(),
  at: IsoDateTime,
});
export type HermesConnectionCreatedEvent = z.infer<typeof HermesConnectionCreatedEvent>;
