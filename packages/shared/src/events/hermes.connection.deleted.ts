import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { HermesConnectionName } from '../entities/hermes.ts';
import { ActorId, HermesConnectionId, TeamId, WorkspaceId } from '../ids.ts';

/** A connection was removed; bots placed on it have nowhere to run until they are placed again. */
export const HermesConnectionDeletedEvent = z.object({
  type: z.literal('hermes.connection.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  connectionId: HermesConnectionId,
  name: HermesConnectionName,
  actorId: ActorId,
  at: IsoDateTime,
});
export type HermesConnectionDeletedEvent = z.infer<typeof HermesConnectionDeletedEvent>;
