import type { ProviderEndpoint, RunOrigin, WebhookProvider } from '@manythreads/shared';
import { ago } from './model';

/** The apps an address can be made for, in the words a person knows them by. */
export const PROVIDER_LABELS: Record<WebhookProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  jira: 'Jira',
  linear: 'Linear',
  zendesk: 'Zendesk',
  intercom: 'Intercom',
  hubspot: 'HubSpot',
  asana: 'Asana',
  generic: 'Any other app (signed with our own header)',
};
export const PROVIDER_ORDER: readonly WebhookProvider[] = ['github', 'gitlab', 'jira', 'linear', 'zendesk', 'intercom', 'hubspot', 'asana', 'generic'];

/** The apps whose own secret you paste in (they make it; we cannot). The others get one from us, shown once. Asana makes its own when you connect the address. */
export const PASTED_PROVIDERS: ReadonlySet<WebhookProvider> = new Set(['zendesk', 'intercom', 'hubspot']);

/** One line on where to put the address in the app. */
export const PROVIDER_HINTS: Record<WebhookProvider, string> = {
  github: 'In the repository: Settings, Webhooks, Add webhook. Paste the address, set the content type to application/json and paste the signing secret into Secret.',
  gitlab: 'In the project: Settings, Webhooks. Paste the address and put the signing secret into Secret token.',
  jira: 'In Jira: System, Webhooks, Create a webhook. Paste the address and the signing secret into Secret.',
  linear: 'In Linear: Settings, API, Webhooks, New webhook. Paste the address and the signing secret into Signing secret.',
  zendesk: 'In Zendesk: Admin Center, Apps and integrations, Webhooks. Make a webhook with this address, then copy its signing secret from Zendesk and paste it here.',
  intercom: 'In Intercom: Developer Hub, your app, Webhooks. Paste the address, then paste the app’s client secret here as the signing secret.',
  hubspot: 'In HubSpot: Development, your app, Webhooks. Paste the address, then paste the app’s client secret here as the signing secret.',
  asana: 'Asana makes the secret itself when you connect the address (its handshake). Create the webhook with this address and nothing else is needed.',
  generic: 'Sign each call with the secret: header X-Manythreads-Request-Timestamp (seconds) and X-Manythreads-Signature: v0=HMAC-SHA256 of "v0:<timestamp>:<body>".',
};

/** A short name proposed for a new address: the app's own name. */
export const proposedSlug = (provider: WebhookProvider): string => provider;

/** The kinds typed as "ticket.created, issue.*" become the list the server takes. */
export function parseKinds(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((k) => k.trim().toLowerCase()).filter((k) => k !== ''))];
}

/** The address to give the app, with this site's own origin. */
export const addressOf = (endpoint: Pick<ProviderEndpoint, 'path'>, origin: string = typeof window === 'undefined' ? '' : window.location.origin): string => `${origin.replace(/\/+$/, '')}${endpoint.path}`;

/** What the list says about the last delivery. */
export function receivedLine(endpoint: Pick<ProviderEndpoint, 'lastReceivedAt' | 'hasSecret'>, now: number = Date.now()): string {
  if (!endpoint.hasSecret) return 'No signing secret yet, so every call is refused';
  if (endpoint.lastReceivedAt === null) return 'Nothing received yet';
  return `Last event ${ago(endpoint.lastReceivedAt, now)}`;
}

/** A link from an app, only if it is a plain web address. Anything else (javascript:, data:, a malformed text) is not a link. */
export function safeHref(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** "14:05" in the reader's own clock. */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The collapsed line of the card under a bot's post: "What started this run · Zendesk · Printer on fire". */
export function originSummary(origin: Pick<RunOrigin, 'provider' | 'title' | 'kind'>): string {
  const app = PROVIDER_LABELS[origin.provider].replace(/ \(.*\)$/, '');
  const what = origin.title && origin.title.trim() !== '' ? origin.title.trim() : origin.kind;
  return `What started this run · ${app} · ${what}`;
}
