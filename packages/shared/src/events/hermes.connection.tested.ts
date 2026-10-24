import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { HermesConnectionName } from '../entities/hermes.ts';
import { ActorId, HermesConnectionId, TeamId, WorkspaceId } from '../ids.ts';

/** A connection was checked: whether the gateway answered. The error text is a fixed sentence, not the gateway's own output. */
export const HermesConnectionTestedEvent = z.object({
  type: z.literal('hermes.connection.tested'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  connectionId: HermesConnectionId,
  name: HermesConnectionName,
  ok: z.boolean(),
  actorId: ActorId,
  at: IsoDateTime,
});
export type HermesConnectionTestedEvent = z.infer<typeof HermesConnectionTestedEvent>;
