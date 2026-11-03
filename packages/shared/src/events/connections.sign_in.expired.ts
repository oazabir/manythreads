import { z } from 'zod';
import { ConnectionId } from '../entities/connection.ts';
import { ChannelId, MessageId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person's sign-in to an outside account (Google, Microsoft, Notion) stopped working for good: the provider no longer honours it, so the person has to connect
 * again. The connections plugin wrote one notice for it in the person's own Reminders conversation, in the same transaction, and this event announces that message
 * so the notifications plugin raises the bell notification (the way a due reminder does). `provider` is the short id of the provider (`google`).
 * Ids and the provider's short id only: never a token, an account address or the provider's own error text. No `teamId`: a person's connection belongs to no team.
 */
export const ConnectionsSignInExpiredEvent = z.object({
  type: z.literal('connections.sign_in.expired'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  connectionId: ConnectionId,
  provider: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  messageId: MessageId,
  channelId: ChannelId,
});
export type ConnectionsSignInExpiredEvent = z.infer<typeof ConnectionsSignInExpiredEvent>;
