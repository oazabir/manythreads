import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MessageId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/**
 * A message of a channel was sent to the address of one of its outgoing webhooks (PLAN P14-14) and how that went: `delivered` the receiver answered 2xx,
 * `retry` this try failed and another is queued, `dead` the delivery was given up (a refused address, a 4xx answer, or the last try failed). `reason` is a
 * category (`timeout`, `blocked_address`, `status_500`), never the address, the text sent or the receiver's answer.
 */
export const WebhooksOutgoingDeliveredEvent = z.object({
  type: z.literal('webhooks.outgoing.delivered'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  webhookId: WebhookId,
  messageId: MessageId,
  outcome: z.enum(['delivered', 'retry', 'dead']),
  statusCode: z.number().int().min(100).max(599).nullable(),
  reason: z.string().regex(/^[a-z0-9_]{2,40}$/).nullable(),
  /** Whether the receiver's answer was posted back into the channel. */
  replied: z.boolean(),
  attempt: z.number().int().min(1).max(20),
  at: IsoDateTime,
});
export type WebhooksOutgoingDeliveredEvent = z.infer<typeof WebhooksOutgoingDeliveredEvent>;
