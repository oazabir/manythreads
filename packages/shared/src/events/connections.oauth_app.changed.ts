import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin put in, replaced or removed the OAuth app (client id and secret) the workspace signs people in to a provider with (PLAN P16-02). The provider's
 * short id, what kind of change it was and who did it: never the client id or the secret.
 */
export const ConnectionsOauthAppChangedEvent = z.object({
  type: z.literal('connections.oauth_app.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  provider: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  change: z.enum(['set', 'cleared']),
  actorId: ActorId,
  at: IsoDateTime,
});
export type ConnectionsOauthAppChangedEvent = z.infer<typeof ConnectionsOauthAppChangedEvent>;
