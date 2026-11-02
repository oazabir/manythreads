import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';

// The routes of a person's own connections to outside accounts (PLAN P8-02): Google, Microsoft and Notion. A person signs in to the provider once from here; what
// comes back (the tokens) is sealed by the platform and never returned by any route. A bot uses it only for a run that this person asked, and only the tools the
// bot's definition names. docs/plugins/connections.md.

/** The providers a person can connect. A new provider is a new entry here and in the connections plugin. */
export const PersonProviderId = z.enum(['google', 'microsoft', 'notion']);
export type PersonProviderId = z.infer<typeof PersonProviderId>;

export const PersonConnectionParams = z.object({ provider: PersonProviderId });
export type PersonConnectionParams = z.infer<typeof PersonConnectionParams>;

/** One thing a provider connection can be asked for (Drive, Gmail, Calendar, ...): the person ticks the ones they want, and more can be added later. */
export const PersonConnectionService = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().max(80),
  /** Plain words: what a bot can do with it. */
  description: z.string().max(300),
  /** The tools a bot can be given through it (`google_drive.search`, ...). */
  tools: z.array(z.string().max(80)).max(16),
  /** Any of the tools changes something outside, so each call waits for a person to approve it. */
  writes: z.boolean(),
  /** The person already agreed to this one at the provider. */
  granted: z.boolean(),
});
export type PersonConnectionService = z.infer<typeof PersonConnectionService>;

/** Whether a stored sign-in still works (`connection_oauth.state`). */
export const PersonConnectionState = z.enum(['ok', 'needs_reconnect']);
export type PersonConnectionState = z.infer<typeof PersonConnectionState>;

export const PersonConnectionProvider = z.strictObject({
  id: PersonProviderId,
  label: z.string().max(80),
  /** An admin has put this server's app credentials for the provider in place; false = the start route answers 409. */
  configured: z.boolean(),
  /** The person has a connection to it that works (or did, see `state`). */
  connected: z.boolean(),
  /** `needs_reconnect`: the provider stopped honouring the stored sign-in, the person has to connect again. Null when not connected. */
  state: PersonConnectionState.nullable(),
  /** Whose account it is (an address or a workspace name), as the provider told us. */
  accountLabel: z.string().max(200).nullable(),
  /** The redirect address an admin registers at the provider for this server. */
  redirectUri: z.string().max(500),
  services: z.array(PersonConnectionService).max(16),
});
export type PersonConnectionProvider = z.infer<typeof PersonConnectionProvider>;

export const ListPersonConnectionsResponse = z.strictObject({ providers: z.array(PersonConnectionProvider) });
export type ListPersonConnectionsResponse = z.infer<typeof ListPersonConnectionsResponse>;
export const listPersonConnectionsRoute = { method: 'GET', path: '/api/me/connections/providers' } as const satisfies ApiRoute;

export const StartPersonConnectionRequest = z.strictObject({
  /** The services to ask for; leave out for the provider's read-only set. Services the person already agreed to stay agreed. */
  services: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)).min(1).max(16).optional(),
  /** A path of this site to come back to (default `/settings/connections`). */
  returnTo: z.string().max(500).optional(),
});
export type StartPersonConnectionRequest = z.infer<typeof StartPersonConnectionRequest>;
export const StartPersonConnectionResponse = z.strictObject({
  /** Where to send the browser: the provider's own consent page. */
  url: z.string().max(4000),
});
export type StartPersonConnectionResponse = z.infer<typeof StartPersonConnectionResponse>;
export const startPersonConnectionRoute = { method: 'POST', path: '/api/me/connections/:provider/start' } as const satisfies ApiRoute;

/** The provider sends the browser back here. The server answers with a redirect to `returnTo`, with `connected=<provider>` or `connect_error=<code>` added. */
export const PersonConnectionCallbackQuery = z.looseObject({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
});
export type PersonConnectionCallbackQuery = z.infer<typeof PersonConnectionCallbackQuery>;
export const personConnectionCallbackRoute = { method: 'GET', path: '/api/me/connections/:provider/callback' } as const satisfies ApiRoute;

/** Why a sign-in to a provider did not finish, as a code the screen turns into words (`connect_error=`). */
export const PERSON_CONNECT_ERRORS = ['denied', 'expired', 'failed', 'not_configured', 'wrong_person'] as const;
export type PersonConnectError = (typeof PERSON_CONNECT_ERRORS)[number];

export const DisconnectPersonConnectionResponse = z.strictObject({ disconnected: z.boolean() });
export type DisconnectPersonConnectionResponse = z.infer<typeof DisconnectPersonConnectionResponse>;
export const disconnectPersonConnectionRoute = { method: 'DELETE', path: '/api/me/connections/:provider' } as const satisfies ApiRoute;
