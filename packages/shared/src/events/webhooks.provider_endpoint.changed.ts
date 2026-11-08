import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { WebhookProvider } from '../entities/provider-endpoint.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** A provider endpoint was made, got a new signing secret, had its secret set, or was revoked (Bundle D, P16-10). Ids and the app's name; never a secret or the short name's text beyond the slug in the endpoint row. */
export const WebhooksProviderEndpointChangedEvent = z.object({
  type: z.literal('webhooks.provider_endpoint.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  provider: WebhookProvider,
  change: z.enum(['created', 'rotated', 'secret_set', 'revoked']),
  actorId: ActorId,
  at: IsoDateTime,
});
export type WebhooksProviderEndpointChangedEvent = z.infer<typeof WebhooksProviderEndpointChangedEvent>;
