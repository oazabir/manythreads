import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** An incoming webhook got a new secret address (PLAN P14-14): who rotated it. The old address stopped working at once. Never a secret or a hash. */
export const WebhooksHookRotatedEvent = z.object({
  type: z.literal('webhooks.hook.rotated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  actorId: ActorId,
  at: IsoDateTime,
});
export type WebhooksHookRotatedEvent = z.infer<typeof WebhooksHookRotatedEvent>;
