import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/**
 * A call to a webhook's address was refused (PLAN P14-14). Only calls that name a webhook that exists are recorded, and at most one line per
 * webhook and reason per minute, so a flood of bad calls cannot flood the audit trail. `reason` is a category, never the payload, the secret
 * that was presented or the address of the caller.
 */
export const WebhooksHookUseFailedEvent = z.object({
  type: z.literal('webhooks.hook.use_failed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  reason: z.enum(['bad_secret', 'revoked', 'bad_signature', 'too_large', 'rate_limited', 'bad_payload', 'channel_unavailable']),
  at: IsoDateTime,
});
export type WebhooksHookUseFailedEvent = z.infer<typeof WebhooksHookUseFailedEvent>;
