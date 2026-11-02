import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/**
 * An API token of an integration was made, replaced or switched off (PLAN P14-14). `webhookId` is the integration's id (an integration is a row of the
 * webhooks table whose kind is `api`). Never the token or its hash.
 */
export const WebhooksTokenChangedEvent = z.object({
  type: z.literal('webhooks.token.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  actorId: ActorId,
  change: z.enum(['created', 'rotated', 'revoked']),
  at: IsoDateTime,
});
export type WebhooksTokenChangedEvent = z.infer<typeof WebhooksTokenChangedEvent>;
