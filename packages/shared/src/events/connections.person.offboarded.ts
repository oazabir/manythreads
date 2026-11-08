import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, PersonId, WorkspaceId } from '../ids.ts';

/** A leaving person's connections were removed (Bundle D, P16-11, decision D33): how many, how many the providers confirmed forgetting, how many team connections moved and to whom. Counts and ids; never a token or an address. */
export const ConnectionsPersonOffboardedEvent = z.object({
  type: z.literal('connections.person.offboarded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  revoked: z.number().int().min(0),
  providerRevoked: z.number().int().min(0),
  providerFailed: z.number().int().min(0),
  moved: z.number().int().min(0),
  newOwnerIds: z.array(ActorId).max(50),
  /** The admin who pressed the button; null when it happened because the person was suspended. */
  actorId: ActorId.nullable(),
  at: IsoDateTime,
});
export type ConnectionsPersonOffboardedEvent = z.infer<typeof ConnectionsPersonOffboardedEvent>;
