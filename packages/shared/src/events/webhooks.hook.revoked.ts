import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/** An incoming webhook was revoked (PLAN P14-14): who did it. Its address answers "not found" from now on. */
export const WebhooksHookRevokedEvent = z.object({
  type: z.literal('webhooks.hook.revoked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  actorId: ActorId,
  at: IsoDateTime,
});
export type WebhooksHookRevokedEvent = z.infer<typeof WebhooksHookRevokedEvent>;
