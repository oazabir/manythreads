import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** A webhook's signing secret (the one a sender such as GitHub signs its calls with) was set, replaced (`enabled`) or removed (not `enabled`). Never the secret. */
export const WebhooksHookSigningChangedEvent = z.object({
  type: z.literal('webhooks.hook.signing_changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  actorId: ActorId,
  enabled: z.boolean(),
  at: IsoDateTime,
});
export type WebhooksHookSigningChangedEvent = z.infer<typeof WebhooksHookSigningChangedEvent>;
