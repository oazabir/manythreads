import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, WebhookId } from '../../ids.ts';

// Incoming webhooks (PLAN P14-14): a lead or a workspace admin makes a secret address for a channel; a program that calls it (a CI job, GitHub, an alert
// manager, a script) posts a message into that channel, written as the webhook and never as a person. The address is shown once, only a hash of its
// secret part is kept, and rotating or revoking turns the old address off at once.

/** The public path a program calls: `POST <site>/hooks/<webhook id>/<secret>`. */
export const WEBHOOK_PATH_PREFIX = '/hooks';
/** What the secret part of an address starts with, so a leaked address is recognisable by a secret scanner. */
export const WEBHOOK_SECRET_PREFIX = 'mtwh_';
/** What a signing secret (the value a sender such as GitHub signs its calls with) starts with. */
export const WEBHOOK_SIGNING_PREFIX = 'mtws_';
/** The most active webhooks one channel may have. */
export const MAX_WEBHOOKS_PER_CHANNEL = 20;
/** The largest body a call may carry, in bytes. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export const WebhookName = z.string().trim().min(1).max(60);
/** An emoji shown before the webhook's name on its messages (optional). */
export const WebhookEmoji = z.string().trim().min(1).max(16);

/** A webhook as a lead sees it. The secret is never part of it. */
export const Webhook = z.object({
  id: WebhookId,
  channelId: ChannelId,
  name: WebhookName,
  emoji: WebhookEmoji.nullable(),
  createdAt: IsoDateTime,
  /** Whose hand made it (the person's display name), or null when that person is gone. */
  createdByName: z.string().nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  /** What the last call came to: it posted, it was ignored (an event the webhook does not show), or it failed. */
  lastStatus: z.enum(['posted', 'ignored', 'failed']).nullable(),
  /** How many messages this webhook has posted. */
  postedCount: z.number().int().min(0),
  /** Whether a signing secret is set: then a call without a valid signature is refused. */
  signed: z.boolean(),
});
export type Webhook = z.infer<typeof Webhook>;

export const ChannelWebhookParams = z.object({ channelId: ChannelId });
export type ChannelWebhookParams = z.infer<typeof ChannelWebhookParams>;
export const WebhookParams = z.object({ webhookId: WebhookId });
export type WebhookParams = z.infer<typeof WebhookParams>;

export const ListWebhooksResponse = z.object({
  webhooks: z.array(Webhook),
  /** The address a program calls, without the secret: `<site>/hooks/<id>/…`. Tells the help text where it lives. */
  base: z.string(),
});
export type ListWebhooksResponse = z.infer<typeof ListWebhooksResponse>;
export const listWebhooksRoute = { method: 'GET', path: '/api/channels/:channelId/webhooks' } as const;

export const CreateWebhookRequest = z.strictObject({ name: WebhookName, emoji: WebhookEmoji.optional() });
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;
/** The webhook and its address, with the secret in it. Shown once: the server keeps only a hash. */
export const WebhookWithUrl = z.object({ webhook: Webhook, url: z.string() });
export type WebhookWithUrl = z.infer<typeof WebhookWithUrl>;
export const createWebhookRoute = { method: 'POST', path: '/api/channels/:channelId/webhooks' } as const;

export const rotateWebhookRoute = { method: 'POST', path: '/api/webhooks/:webhookId/rotate' } as const;

export const RevokeWebhookResponse = z.object({ revoked: z.literal(true) });
export type RevokeWebhookResponse = z.infer<typeof RevokeWebhookResponse>;
export const revokeWebhookRoute = { method: 'DELETE', path: '/api/webhooks/:webhookId' } as const;

export const SigningSecretResponse = z.object({ webhook: Webhook, signingSecret: z.string().startsWith(WEBHOOK_SIGNING_PREFIX) });
export type SigningSecretResponse = z.infer<typeof SigningSecretResponse>;
export const setWebhookSigningRoute = { method: 'POST', path: '/api/webhooks/:webhookId/signing-secret' } as const;
export const clearWebhookSigningRoute = { method: 'DELETE', path: '/api/webhooks/:webhookId/signing-secret' } as const;
export const ClearSigningResponse = z.object({ webhook: Webhook });
export type ClearSigningResponse = z.infer<typeof ClearSigningResponse>;

export const TestWebhookResponse = z.object({ messageId: z.string(), webhook: Webhook });
export type TestWebhookResponse = z.infer<typeof TestWebhookResponse>;
export const testWebhookRoute = { method: 'POST', path: '/api/webhooks/:webhookId/test' } as const;

/** The answer a program gets from its call. `ignored` says why nothing was posted (for example an event the webhook does not show). */
export const WebhookCallResponse = z.object({ ok: z.literal(true), messageId: z.string().optional(), ignored: z.string().optional() });
export type WebhookCallResponse = z.infer<typeof WebhookCallResponse>;
/** The public route. Not part of `/api`: a program calls it with no session. */
export const webhookCallRoute = { method: 'POST', path: '/hooks/:webhookId/:secret' } as const;
