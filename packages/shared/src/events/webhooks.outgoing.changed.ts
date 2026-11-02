import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** An outgoing webhook (a channel's message sent to an address on a trigger word) was made, changed, switched off, or its signing secret changed (PLAN P14-14). Never the address, the words or the secret. */
export const WebhooksOutgoingChangedEvent = z.object({
  type: z.literal('webhooks.outgoing.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  actorId: ActorId,
  change: z.enum(['created', 'updated', 'revoked', 'signing_set', 'signing_cleared']),
  at: IsoDateTime,
});
export type WebhooksOutgoingChangedEvent = z.infer<typeof WebhooksOutgoingChangedEvent>;
