import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** An incoming webhook was made for a channel (PLAN P14-14): who made it and where it posts. Never the secret or its hash. */
export const WebhooksHookCreatedEvent = z.object({
  type: z.literal('webhooks.hook.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  actorId: ActorId,
  at: IsoDateTime,
});
export type WebhooksHookCreatedEvent = z.infer<typeof WebhooksHookCreatedEvent>;
