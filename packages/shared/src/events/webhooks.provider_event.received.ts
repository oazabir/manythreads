import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ProviderEventKind, WebhookProvider } from '../entities/provider-endpoint.ts';
import { ChannelId, ProviderEventId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/**
 * A work app's delivery passed its signature check and was read (Bundle D, P16-10, decision D19). Ids, the app's name and the kind of event; the text stays in a table
 * only the platform reads. The tasks plugin will consume this to mirror issues (P16-06); today the runtime-hermes router consumes it to start bots.
 */
export const WebhooksProviderEventReceivedEvent = z.object({
  type: z.literal('webhooks.provider_event.received'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  eventId: ProviderEventId,
  provider: WebhookProvider,
  kind: ProviderEventKind,
  at: IsoDateTime,
});
export type WebhooksProviderEventReceivedEvent = z.infer<typeof WebhooksProviderEventReceivedEvent>;
