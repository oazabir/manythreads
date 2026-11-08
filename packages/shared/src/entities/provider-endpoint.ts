import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, TeamId, WebhookId } from '../ids.ts';

// Provider endpoints (PLAN Bundle D, P16-10, plugin `webhooks`, docs/plugins/webhooks.md): an address a work app (GitHub, Zendesk, Jira ...) sends its events to, made per
// channel by a lead or admin. The address is `/hooks/apps/<endpointId>`; the app's signature is the proof, so the address holds no secret. Enums match the SQL CHECKs in
// plugins/webhooks/migrations/0004 exactly.

/** The apps a provider endpoint understands. `generic` is our own signed shape (`X-Manythreads-Signature`). */
export const WebhookProvider = z.enum(['github', 'gitlab', 'jira', 'linear', 'zendesk', 'intercom', 'hubspot', 'asana', 'generic']);
export type WebhookProvider = z.infer<typeof WebhookProvider>;

/** Where the signing secret comes from: made by us and shown once, or pasted by the lead (the app's own client secret). */
export const ProviderSecretSource = z.enum(['generated', 'pasted']);
export type ProviderSecretSource = z.infer<typeof ProviderSecretSource>;

/** The short name a bot's `webhook` trigger uses in `connection:`. */
export const ProviderEndpointSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes, starting with a letter or digit');
export type ProviderEndpointSlug = z.infer<typeof ProviderEndpointSlug>;

/** A kind of event as the endpoint names it: `ticket.created`, `issue.updated`, `push`. At most four dotted words. */
export const ProviderEventKind = z.string().max(64).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/);
export type ProviderEventKind = z.infer<typeof ProviderEventKind>;
/** A filter entry: an exact kind or `ticket.*`. */
export const ProviderEventFilter = z.string().max(64).regex(/^[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*)){0,3}$/);

/** Why a delivery was not turned into an event. */
export const ProviderRefusalReason = z.enum(['bad_signature', 'stale', 'replayed', 'too_large', 'unknown_endpoint', 'bot_busy', 'no_channel']);
export type ProviderRefusalReason = z.infer<typeof ProviderRefusalReason>;

/** A provider endpoint as a lead sees it. The signing secret is never part of it. */
export const ProviderEndpoint = z.object({
  id: WebhookId,
  teamId: TeamId,
  channelId: ChannelId,
  provider: WebhookProvider,
  slug: ProviderEndpointSlug,
  name: z.string().min(1).max(80),
  eventFilter: z.array(ProviderEventFilter).max(20),
  secretSource: ProviderSecretSource,
  /** False until a signing secret is set (a pasted secret may come after the address). */
  hasSecret: z.boolean(),
  /** The address to give the app: `/hooks/apps/<id>`; the page shows it with the site's own origin. */
  path: z.string().max(100),
  lastReceivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  rotatedAt: IsoDateTime.nullable(),
});
export type ProviderEndpoint = z.infer<typeof ProviderEndpoint>;

/** What started a run: shown on the bot's post as "What started this run". Titles and labels are the provider's words, cut short, and shown as plain text. */
export const RunOrigin = z.object({
  provider: WebhookProvider,
  endpointName: z.string().max(80),
  kind: ProviderEventKind,
  title: z.string().max(200).nullable(),
  url: z.string().max(2000).nullable(),
  actorLabel: z.string().max(80).nullable(),
  receivedAt: IsoDateTime,
  /** True: the delivery passed its signature check. Always true for a stored event. */
  verified: z.literal(true),
  /** The first eight characters of the delivery id, so a person can match it with the app's own log. */
  deliveryKey: z.string().max(8),
});
export type RunOrigin = z.infer<typeof RunOrigin>;
