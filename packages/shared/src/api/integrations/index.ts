import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, WebhookId } from '../../ids.ts';
import { WebhookEmoji, WebhookName } from '../webhooks/index.ts';

// Integrations of a channel beyond the incoming webhook (PLAN P14-14), all managed by the channel's lead or a workspace admin at the channel's
// **Integrations** screen:
//
//  - an **API token**: a secret that lets a script use the small Slack-shaped web API (`chat.postMessage`, `chat.update`, `reactions.add`,
//    `reactions.remove`, `auth.test`) for one channel, or for a short list of the team's channels the lead picked. Shown once, kept only as a hash.
//  - an **outgoing webhook**: when a message in the channel starts with, or contains, one of the trigger words, the server sends it to an address
//    and posts the receiver's reply back as the integration.
//
// An integration is a row of the webhooks table (its `kind` says which sort), so it has the same author name and the same Webhook mark on its
// messages as an incoming webhook.

/** What a token starts with, so a leaked one is recognisable by a secret scanner. */
export const API_TOKEN_PREFIX = 'mtat_';
/** What an outgoing webhook's signing secret starts with. */
export const OUTGOING_SIGNING_PREFIX = 'mtos_';
/** The most channels one token may reach. */
export const MAX_TOKEN_CHANNELS = 10;
/** The most trigger words one outgoing webhook may have. */
export const MAX_TRIGGER_WORDS = 10;
/** The methods a token may be limited to. `auth.test` is always allowed: it only says who the token is. */
export const SLACK_METHODS = ['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove'] as const;
export const SlackMethod = z.enum(SLACK_METHODS);
export type SlackMethod = z.infer<typeof SlackMethod>;
/** Calls per minute one token may make (all methods together). */
export const API_TOKEN_RATE_PER_MINUTE = 60;
/** How long the server waits for an outgoing webhook's receiver, in milliseconds. */
export const OUTGOING_TIMEOUT_MS = 5_000;
/** The most of a message sent to a receiver, in characters; a longer text is cut and marked `truncated`. */
export const OUTGOING_MAX_TEXT = 16_000;
/** The most a receiver's answer is read, in bytes. */
export const OUTGOING_MAX_REPLY_BYTES = 65_536;

// API tokens ---------------------------------------------------------------------------------------------------------------------------------------

export const ApiToken = z.object({
  id: WebhookId,
  /** The channel the token was made in; always the first of `channelIds`. */
  channelId: ChannelId,
  name: WebhookName,
  emoji: WebhookEmoji.nullable(),
  /** Every channel the token reaches. */
  channelIds: z.array(ChannelId).min(1).max(MAX_TOKEN_CHANNELS),
  methods: z.array(SlackMethod).min(1),
  createdAt: IsoDateTime,
  createdByName: z.string().nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  lastStatus: z.enum(['posted', 'ignored', 'failed']).nullable(),
  /** Calls made with it so far. */
  callCount: z.number().int().min(0),
});
export type ApiToken = z.infer<typeof ApiToken>;

export const ChannelIntegrationParams = z.object({ channelId: ChannelId });
export type ChannelIntegrationParams = z.infer<typeof ChannelIntegrationParams>;
export const ApiTokenParams = z.object({ tokenId: WebhookId });
export type ApiTokenParams = z.infer<typeof ApiTokenParams>;

export const ListApiTokensResponse = z.object({
  tokens: z.array(ApiToken),
  /** Where a script calls the API: `<site>/api/slack/`. */
  apiBase: z.string(),
});
export type ListApiTokensResponse = z.infer<typeof ListApiTokensResponse>;
export const listApiTokensRoute = { method: 'GET', path: '/api/channels/:channelId/api-tokens' } as const;

export const CreateApiTokenRequest = z.strictObject({
  name: WebhookName,
  emoji: WebhookEmoji.optional(),
  /** Other channels of the same team the token may also reach (the channel in the path is always included). */
  moreChannelIds: z.array(ChannelId).max(MAX_TOKEN_CHANNELS - 1).optional(),
  /** Default: all four methods. */
  methods: z.array(SlackMethod).min(1).max(SLACK_METHODS.length).optional(),
});
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequest>;
/** A token and its secret. The secret is shown once; the server keeps only a hash. */
export const ApiTokenWithSecret = z.object({ token: ApiToken, secret: z.string().startsWith(API_TOKEN_PREFIX) });
export type ApiTokenWithSecret = z.infer<typeof ApiTokenWithSecret>;
export const createApiTokenRoute = { method: 'POST', path: '/api/channels/:channelId/api-tokens' } as const;
export const rotateApiTokenRoute = { method: 'POST', path: '/api/api-tokens/:tokenId/rotate' } as const;
export const RevokeApiTokenResponse = z.object({ revoked: z.literal(true) });
export type RevokeApiTokenResponse = z.infer<typeof RevokeApiTokenResponse>;
export const revokeApiTokenRoute = { method: 'DELETE', path: '/api/api-tokens/:tokenId' } as const;
export const TestApiTokenResponse = z.object({ messageId: z.string(), ts: z.string(), token: ApiToken });
export type TestApiTokenResponse = z.infer<typeof TestApiTokenResponse>;
export const testApiTokenRoute = { method: 'POST', path: '/api/api-tokens/:tokenId/test' } as const;

// Outgoing webhooks --------------------------------------------------------------------------------------------------------------------------------

/** One trigger word or phrase: one line, up to 40 characters. Matched without regard to capital letters. */
export const TriggerWord = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((w) => ![...w].some((c) => c.charCodeAt(0) < 32), 'a trigger word is one line');
/** Where a message is sent: an http or https address, no user name or password in it. */
export const OutgoingUrl = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .refine((u) => {
    try {
      const url = new URL(u);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'an http or https address with no user name or password');
export const OutgoingMatch = z.enum(['starts', 'contains']);
export type OutgoingMatch = z.infer<typeof OutgoingMatch>;

export const OutgoingHook = z.object({
  id: WebhookId,
  channelId: ChannelId,
  name: WebhookName,
  emoji: WebhookEmoji.nullable(),
  url: z.string(),
  triggerWords: z.array(TriggerWord).min(1).max(MAX_TRIGGER_WORDS),
  match: OutgoingMatch,
  enabled: z.boolean(),
  /** Whether a signing secret is set: each call then carries a signature the receiver can check. */
  signed: z.boolean(),
  /** The `token` field each call carries, so the receiver can tell it is for this hook. Not a secret; the signature is the proof. */
  verificationToken: z.string(),
  createdAt: IsoDateTime,
  createdByName: z.string().nullable(),
  lastDeliveryAt: IsoDateTime.nullable(),
  lastDeliveryStatus: z.enum(['delivered', 'retrying', 'dead']).nullable(),
  /** A short category for the last failure (`timeout`, `blocked_address`, `status_500`), or null. */
  lastError: z.string().nullable(),
  deliveredCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
});
export type OutgoingHook = z.infer<typeof OutgoingHook>;

export const OutgoingHookParams = z.object({ hookId: WebhookId });
export type OutgoingHookParams = z.infer<typeof OutgoingHookParams>;

export const ListOutgoingHooksResponse = z.object({ hooks: z.array(OutgoingHook) });
export type ListOutgoingHooksResponse = z.infer<typeof ListOutgoingHooksResponse>;
export const listOutgoingHooksRoute = { method: 'GET', path: '/api/channels/:channelId/outgoing-hooks' } as const;

export const CreateOutgoingHookRequest = z.strictObject({
  name: WebhookName,
  emoji: WebhookEmoji.optional(),
  url: OutgoingUrl,
  triggerWords: z.array(TriggerWord).min(1).max(MAX_TRIGGER_WORDS),
  match: OutgoingMatch.default('starts'),
});
export type CreateOutgoingHookRequest = z.infer<typeof CreateOutgoingHookRequest>;
export const createOutgoingHookRoute = { method: 'POST', path: '/api/channels/:channelId/outgoing-hooks' } as const;

export const UpdateOutgoingHookRequest = z.strictObject({
  url: OutgoingUrl.optional(),
  triggerWords: z.array(TriggerWord).min(1).max(MAX_TRIGGER_WORDS).optional(),
  match: OutgoingMatch.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateOutgoingHookRequest = z.infer<typeof UpdateOutgoingHookRequest>;
export const updateOutgoingHookRoute = { method: 'PATCH', path: '/api/outgoing-hooks/:hookId' } as const;

export const RevokeOutgoingHookResponse = z.object({ revoked: z.literal(true) });
export type RevokeOutgoingHookResponse = z.infer<typeof RevokeOutgoingHookResponse>;
export const revokeOutgoingHookRoute = { method: 'DELETE', path: '/api/outgoing-hooks/:hookId' } as const;

export const OutgoingSigningResponse = z.object({ hook: OutgoingHook, signingSecret: z.string().startsWith(OUTGOING_SIGNING_PREFIX) });
export type OutgoingSigningResponse = z.infer<typeof OutgoingSigningResponse>;
export const setOutgoingSigningRoute = { method: 'POST', path: '/api/outgoing-hooks/:hookId/signing-secret' } as const;
export const clearOutgoingSigningRoute = { method: 'DELETE', path: '/api/outgoing-hooks/:hookId/signing-secret' } as const;
export const ClearOutgoingSigningResponse = z.object({ hook: OutgoingHook });
export type ClearOutgoingSigningResponse = z.infer<typeof ClearOutgoingSigningResponse>;

/** What a test call came to: it sends a sample message to the address once, now, and says what the receiver answered. Nothing is posted in the channel. */
export const TestOutgoingHookResponse = z.object({
  delivered: z.boolean(),
  statusCode: z.number().int().nullable(),
  /** A category when it failed (`timeout`, `blocked_address`, `status_404`), else null. */
  reason: z.string().nullable(),
  /** Whether the receiver's answer carried a reply that would be posted in the channel. */
  wouldReply: z.boolean(),
});
export type TestOutgoingHookResponse = z.infer<typeof TestOutgoingHookResponse>;
export const testOutgoingHookRoute = { method: 'POST', path: '/api/outgoing-hooks/:hookId/test' } as const;

// The body an outgoing webhook's receiver gets (Slack's outgoing webhook shape, as JSON) -------------------------------------------------------------

export const OutgoingPayload = z.object({
  token: z.string(),
  team_id: z.string(),
  team_domain: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  timestamp: z.string(),
  user_id: z.string(),
  user_name: z.string(),
  text: z.string(),
  trigger_word: z.string(),
  message_id: z.string(),
  thread_ts: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type OutgoingPayload = z.infer<typeof OutgoingPayload>;

// The answer an incoming webhook gives (adds what was left out) -----------------------------------------------------------------------------------

/**
 * The answer a program gets from a call to an incoming webhook's address. `ignored` says why nothing was posted. `skippedBlocks` counts the Block Kit
 * blocks that were left out because this server shows only a subset (a skipped block is never an error).
 */
export const IncomingWebhookResult = z.object({
  ok: z.literal(true),
  messageId: z.string().optional(),
  ignored: z.string().optional(),
  skippedBlocks: z.number().int().min(0).optional(),
});
export type IncomingWebhookResult = z.infer<typeof IncomingWebhookResult>;
