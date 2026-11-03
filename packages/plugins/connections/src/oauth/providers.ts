import { availableServices, connectorEntry, type ConnectorEntry, type PersonProviderId } from '@manythreads/shared';

// What differs between the providers a person can connect (PLAN P8-02): their addresses, how they want the app to prove itself, and the services a person can
// agree to one at a time. Everything else — the PKCE proof, the state, the code exchange, the refresh and the sealing of the tokens — is written once, in flow.ts and
// store.ts, and reads only this. A new provider is one more entry here (and its tools in person-tools.ts); no flow code changes.
//
// The addresses are constants. The only way to point a provider somewhere else is `MANYTHREADS_OAUTH_<PROVIDER>_FAKE_BASE`, which is read only outside production
// (the tests' fake provider, the e2e fixtures); in production an operator cannot aim the server at an address of their choice through this door.

/** One thing a person can agree to separately (Google Drive, Gmail drafts, ...): the provider's own scope names, and what the word means in plain terms. */
export interface ServiceDef {
  id: string;
  label: string;
  description: string;
  scopes: readonly string[];
}

export interface OAuthProviderDef {
  id: PersonProviderId;
  label: string;
  /** The provider supports the PKCE proof (a one-time secret that ties the code to the browser that asked). Notion does not. */
  pkce: boolean;
  /** How the app's own secret travels to the token address: in the form body, or as HTTP Basic credentials. */
  clientAuth: 'body' | 'basic';
  /** The token address wants JSON (Notion) rather than a form. */
  tokenBody: 'form' | 'json';
  /** Scopes asked for on every sign-in, whatever the person ticked (identity, and the offline grant a refresh token needs). */
  baseScopes: readonly string[];
  /** The provider takes a `scope` parameter at all (Notion's permissions are set on the integration itself). */
  scopeParam: boolean;
  /** Extra parameters on the consent address (Google: offline access and the earlier grants). */
  authorizeExtra: Readonly<Record<string, string>>;
  /** The services in the order a screen shows them. */
  services: readonly ServiceDef[];
  /** The read-only set a sign-in asks for when the caller names none. */
  defaultServices: readonly string[];
  /** The access token expires and a refresh token renews it. Notion's does not expire. */
  refreshes: boolean;
}

/**
 * The services a person can tick, from the connector catalog (shared/connectors/catalog.ts): the catalog is the one list of them, so the gallery, the docs and this
 * sign-in cannot disagree. A service whose tools are not built yet is not in it.
 */
function catalogServices(id: PersonProviderId): readonly ServiceDef[] {
  const entry: ConnectorEntry | undefined = connectorEntry(id);
  if (!entry) throw new Error(`the connector catalog has no entry for ${id}`);
  return availableServices(entry).map((s) => ({ id: s.id, label: s.label, description: s.description, scopes: s.scopes }));
}

export const PROVIDERS: Readonly<Record<PersonProviderId, OAuthProviderDef>> = {
  google: {
    id: 'google',
    label: 'Google',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: ['openid', 'email'],
    scopeParam: true,
    // offline: a refresh token; include_granted_scopes: a later sign-in for Calendar keeps what Drive was already allowed (incremental scopes); consent: Google hands
    // out a refresh token only when the person is asked again
    authorizeExtra: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' },
    refreshes: true,
    defaultServices: ['drive', 'calendar'],
    services: catalogServices('google'),
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft 365',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: ['openid', 'email', 'offline_access', 'User.Read'],
    scopeParam: true,
    authorizeExtra: { prompt: 'select_account' },
    refreshes: true,
    defaultServices: ['onedrive', 'calendar'],
    services: catalogServices('microsoft'),
  },
  notion: {
    id: 'notion',
    label: 'Notion',
    pkce: false,
    clientAuth: 'basic',
    tokenBody: 'json',
    baseScopes: [],
    scopeParam: false,
    authorizeExtra: { owner: 'user' },
    refreshes: false,
    defaultServices: ['notion'],
    services: catalogServices('notion'),
  },
};

export const providerIds = (): PersonProviderId[] => Object.keys(PROVIDERS) as PersonProviderId[];

export const providerDef = (id: string): OAuthProviderDef | undefined => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as PersonProviderId] : undefined);

export const serviceDef = (provider: OAuthProviderDef, id: string): ServiceDef | undefined => provider.services.find((s) => s.id === id);

/** The scopes to ask for: the provider's base scopes and those of each service named. Unknown service names are the caller's to refuse. */
export function scopesFor(provider: OAuthProviderDef, services: readonly string[]): string[] {
  const out = new Set<string>(provider.baseScopes);
  for (const id of services) for (const scope of serviceDef(provider, id)?.scopes ?? []) out.add(scope);
  return [...out];
}

/** The services whose every scope is in `granted`. */
export const servicesGranted = (provider: OAuthProviderDef, granted: readonly string[]): string[] => {
  const have = new Set(granted);
  return provider.services.filter((s) => s.scopes.every((scope) => have.has(scope))).map((s) => s.id);
};

export type Env = Readonly<Record<string, string | undefined>>;

export interface Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Null when the provider has no revoke address (Microsoft: signing out of Graph is a wider act than this). */
  revokeUrl: string | null;
  /** The base of the provider's API; the tools add their own paths. */
  apiBase: string;
}

const TENANT = /^(?:common|organizations|consumers|[0-9a-fA-F-]{36}|[A-Za-z0-9][A-Za-z0-9.-]{0,62})$/;

/** The fake provider of tests and fixtures, only outside production, only for an `http(s)` address. */
function fakeBase(id: PersonProviderId, env: Env): string | null {
  if (env['NODE_ENV'] === 'production') return null;
  const raw = env[`MANYTHREADS_OAUTH_${id.toUpperCase()}_FAKE_BASE`]?.trim().replace(/\/+$/, '');
  if (!raw) return null;
  return /^https?:\/\/[^\s/]+$/.test(raw) ? raw : null;
}

/** `tenant` is the Microsoft directory a workspace admin chose for the workspace's app; without one the server's setting (or `common`) is used. */
export function endpointsFor(id: PersonProviderId, env: Env = process.env, tenant?: string | null): Endpoints {
  const fake = fakeBase(id, env);
  switch (id) {
    case 'google':
      return fake
        ? { authorizeUrl: `${fake}/o/oauth2/v2/auth`, tokenUrl: `${fake}/token`, revokeUrl: `${fake}/revoke`, apiBase: fake }
        : {
            authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            revokeUrl: 'https://oauth2.googleapis.com/revoke',
            apiBase: 'https://www.googleapis.com',
          };
    case 'microsoft': {
      if (fake) return { authorizeUrl: `${fake}/oauth2/v2.0/authorize`, tokenUrl: `${fake}/oauth2/v2.0/token`, revokeUrl: null, apiBase: `${fake}/v1.0` };
      const tenantRaw = (tenant ?? env['MANYTHREADS_OAUTH_MICROSOFT_TENANT'])?.trim();
      const directory = tenantRaw && TENANT.test(tenantRaw) ? tenantRaw : 'common';
      return {
        authorizeUrl: `https://login.microsoftonline.com/${directory}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${directory}/oauth2/v2.0/token`,
        revokeUrl: null,
        apiBase: 'https://graph.microsoft.com/v1.0',
      };
    }
    case 'notion':
      return fake
        ? { authorizeUrl: `${fake}/v1/oauth/authorize`, tokenUrl: `${fake}/v1/oauth/token`, revokeUrl: `${fake}/v1/oauth/revoke`, apiBase: `${fake}/v1` }
        : {
            authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
            tokenUrl: 'https://api.notion.com/v1/oauth/token',
            revokeUrl: 'https://api.notion.com/v1/oauth/revoke',
            apiBase: 'https://api.notion.com/v1',
          };
  }
}

/** The app credentials an admin put in the server's environment for a provider (names only in the repository; the values never are). Null when either is missing. */
export function oauthApp(id: PersonProviderId, env: Env = process.env): { clientId: string; clientSecret: string } | null {
  const upper = id.toUpperCase();
  const clientId = env[`MANYTHREADS_OAUTH_${upper}_CLIENT_ID`]?.trim();
  const clientSecret = env[`MANYTHREADS_OAUTH_${upper}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The address a provider sends the browser back to: the same for every person, registered once at the provider by an admin. */
export const redirectUriFor = (publicUrl: string, id: PersonProviderId): string => `${publicUrl.replace(/\/+$/, '')}/api/me/connections/${id}/callback`;
