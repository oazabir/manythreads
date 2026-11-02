import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MessageId, TeamId, WebhookId, WorkspaceId } from '../ids.ts';

/**
 * One call of the Slack-shaped API with a valid integration token (PLAN P14-14): which method, how it ended and which message it touched. `outcome` is
 * `ok` or the Slack-style error word the caller was given (`channel_not_found`, `rate_limited`, ...). A call with an unknown token names no integration and
 * is not recorded here. Never the text of a message, the token, or the address of the caller.
 */
export const WebhooksTokenUsedEvent = z.object({
  type: z.literal('webhooks.token.used'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  /** The channel the call named when it is one of the token's; otherwise the token's own first channel. */
  channelId: ChannelId,
  webhookId: WebhookId,
  method: z.enum(['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove', 'auth.test']),
  outcome: z.string().regex(/^[a-z_]{2,40}$/),
  messageId: MessageId.nullable(),
  at: IsoDateTime,
});
export type WebhooksTokenUsedEvent = z.infer<typeof WebhooksTokenUsedEvent>;
