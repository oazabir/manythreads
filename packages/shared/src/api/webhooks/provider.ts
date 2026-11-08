import { z } from 'zod';
import { RunOrigin, ProviderEndpoint, ProviderEndpointSlug, ProviderEventFilter, WebhookProvider } from '../../entities/provider-endpoint.ts';
import { ChannelId, WebhookId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Provider endpoints (PLAN Bundle D, P16-10, plugin `webhooks`): an address a work app sends its events to, made per channel by a lead or admin at the channel's
// Integrations screen, tab "From an app". The address is `/hooks/apps/<id>` and carries no secret: the app's signature is the proof. A bot with a `webhook` trigger naming the
// endpoint's short name starts a run for each event. docs/plugins/webhooks.md.

/** The most provider endpoints one channel has (they count toward the 20 integrations of a channel). */
export const PROVIDER_ENDPOINTS_PER_CHANNEL_MAX = 20;
/** The most a delivery's body may be (bytes), and how long the dedupe key of a delivery is kept (days). */
export const PROVIDER_BODY_MAX_BYTES = 1024 * 1024;
export const PROVIDER_DEDUPE_DAYS = 7;
/** Bot cap: webhook runs per bot per hour; more are dropped with a `bot_busy` refusal. */
export const PROVIDER_BOT_RUNS_PER_HOUR = 30;

export const ProviderHookPathParams = z.object({ endpointId: WebhookId });
export type ProviderHookPathParams = z.infer<typeof ProviderHookPathParams>;
export const ProviderHookChannelParams = z.object({ channelId: ChannelId });
export type ProviderHookChannelParams = z.infer<typeof ProviderHookChannelParams>;

export const ListProviderHooksResponse = z.object({ endpoints: z.array(ProviderEndpoint) });
export type ListProviderHooksResponse = z.infer<typeof ListProviderHooksResponse>;
export const listProviderHooksRoute = { method: 'GET', path: '/api/channels/:channelId/provider-hooks' } as const satisfies ApiRoute;

/**
 * Make an endpoint. For github, gitlab, jira, linear, asana and generic the signing secret is made by us and shown once in the answer. For zendesk, intercom and hubspot the
 * lead pastes the app's own secret in `signingSecret`; it may also come later through the signing-secret route.
 */
export const CreateProviderHookRequest = z.strictObject({
  provider: WebhookProvider,
  slug: ProviderEndpointSlug,
  name: z.string().trim().min(1).max(80).optional(),
  eventFilter: z.array(ProviderEventFilter).max(20).default([]),
  signingSecret: z.string().min(8).max(500).optional(),
});
export type CreateProviderHookRequest = z.infer<typeof CreateProviderHookRequest>;
export const CreateProviderHookResponse = z.object({
  endpoint: ProviderEndpoint,
  /** Shown once and never again; null when the lead pasted one or none is needed yet. */
  signingSecret: z.string().nullable(),
});
export type CreateProviderHookResponse = z.infer<typeof CreateProviderHookResponse>;
export const createProviderHookRoute = { method: 'POST', path: '/api/channels/:channelId/provider-hooks' } as const satisfies ApiRoute;

export const UpdateProviderHookRequest = z
  .strictObject({ name: z.string().trim().min(1).max(80).optional(), eventFilter: z.array(ProviderEventFilter).max(20).optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one thing' });
export type UpdateProviderHookRequest = z.infer<typeof UpdateProviderHookRequest>;
export const UpdateProviderHookResponse = z.object({ endpoint: ProviderEndpoint });
export type UpdateProviderHookResponse = z.infer<typeof UpdateProviderHookResponse>;
export const updateProviderHookRoute = { method: 'PATCH', path: '/api/provider-hooks/:endpointId' } as const satisfies ApiRoute;

export const DeleteProviderHookResponse = z.object({ revoked: z.literal(true) });
export type DeleteProviderHookResponse = z.infer<typeof DeleteProviderHookResponse>;
export const deleteProviderHookRoute = { method: 'DELETE', path: '/api/provider-hooks/:endpointId' } as const satisfies ApiRoute;

/** Paste (or replace) the app's own signing secret. */
export const PutProviderSigningSecretRequest = z.strictObject({ signingSecret: z.string().min(8).max(500) });
export type PutProviderSigningSecretRequest = z.infer<typeof PutProviderSigningSecretRequest>;
export const PutProviderSigningSecretResponse = z.object({ endpoint: ProviderEndpoint });
export type PutProviderSigningSecretResponse = z.infer<typeof PutProviderSigningSecretResponse>;
export const putProviderSigningSecretRoute = { method: 'PUT', path: '/api/provider-hooks/:endpointId/signing-secret' } as const satisfies ApiRoute;

/** Make a new signing secret (generated providers only); the old one stops working at once. Shown once. */
export const RotateProviderHookResponse = z.object({ endpoint: ProviderEndpoint, signingSecret: z.string() });
export type RotateProviderHookResponse = z.infer<typeof RotateProviderHookResponse>;
export const rotateProviderHookRoute = { method: 'POST', path: '/api/provider-hooks/:endpointId/rotate' } as const satisfies ApiRoute;

/**
 * The public door. The body is the app's own JSON; the signature header is the credential. Unknown, revoked and switched-off endpoints answer the same 404. 200: taken
 * (`{ duplicate: true }` for a repeat), 202: understood and ignored, 401: bad or stale signature, 413: too large, 429: too many.
 */
export const providerHookDoorRoute = { method: 'POST', path: '/hooks/apps/:endpointId' } as const satisfies ApiRoute;
export const ProviderHookDoorResponse = z.object({ ok: z.literal(true), duplicate: z.boolean().optional(), ignored: z.boolean().optional() });
export type ProviderHookDoorResponse = z.infer<typeof ProviderHookDoorResponse>;

/** What started a run. Answers 404 unless the caller can read the run's channel and the run was started by a provider event. */
export const RunOriginPathParams = z.object({ runId: z.uuid() });
export type RunOriginPathParams = z.infer<typeof RunOriginPathParams>;
export const GetRunOriginResponse = z.object({ origin: RunOrigin });
export type GetRunOriginResponse = z.infer<typeof GetRunOriginResponse>;
export const getRunOriginRoute = { method: 'GET', path: '/api/runs/:runId/origin' } as const satisfies ApiRoute;
