import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ProviderRefusalReason, WebhookProvider } from '../entities/provider-endpoint.ts';
import { ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** A delivery was refused or a bot was too busy (Bundle D, P16-10). At most one per minute per endpoint and reason; `count` is how many that minute. The endpoint is null when the address named none. */
export const WebhooksProviderEventRefusedEvent = z.object({
  type: z.literal('webhooks.provider_event.refused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  webhookId: WebhookId.nullable(),
  provider: WebhookProvider.nullable(),
  reason: ProviderRefusalReason,
  count: z.number().int().min(1),
  at: IsoDateTime,
});
export type WebhooksProviderEventRefusedEvent = z.infer<typeof WebhooksProviderEventRefusedEvent>;
