import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ConnectionId, ConnectionKind, ConnectionScope, ConnectionSlug } from '../entities/connection.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * Someone made, changed or removed a connection, or put a credential into one. Ids, the short name, the kind and what kind of change it was: never a credential,
 * a mailbox address or the connection's display name. `credential_set` also covers a replaced credential; `switched` is turning a connection on or off.
 */
export const ConnectionsConnectionChangedEvent = z.object({
  type: z.literal('connections.connection.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** The team of a team connection; null for a person's or the workspace's. */
  teamId: TeamId.nullable(),
  connectionId: ConnectionId,
  slug: ConnectionSlug,
  kind: ConnectionKind,
  scope: ConnectionScope,
  change: z.enum(['created', 'updated', 'switched', 'credential_set', 'deleted']),
  actorId: ActorId,
  at: IsoDateTime,
});
export type ConnectionsConnectionChangedEvent = z.infer<typeof ConnectionsConnectionChangedEvent>;
