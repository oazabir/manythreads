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
  /** What joins the scopes in the consent address: a space (the default) or, for Linear, a comma. */
  scopeSeparator?: string;
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
  /**
   * The provider lives at an address of the customer's own account (Zendesk `acme.zendesk.com`, Salesforce `acme.my.salesforce.com`). The workspace's app holds the account's
   * subdomain (the `tenant` setting); the address is built here from that one label and the provider's own domain, never taken whole from anyone (no SSRF).
   */
  instance: { suffix: string; label: string } | null;
  /**
   * A later sign-in for one more service keeps what was agreed before (Google's `include_granted_scopes`, a Microsoft token that carries every permission, Notion's
   * settings on the integration). A provider without that (Zendesk, Intercom, HubSpot, Salesforce) gives the new token only the scopes asked for, so every sign-in asks
   * for the services agreed before as well as the new one.
   */
  incremental: boolean;
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
    instance: null,
    incremental: true,
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
    instance: null,
    incremental: true,
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
    instance: null,
    incremental: true,
    defaultServices: ['notion'],
    services: catalogServices('notion'),
  },
  // ---- the work trackers (P16-06) ----
  jira: {
    id: 'jira',
    label: 'Jira',
    pkce: false,
    clientAuth: 'body',
    tokenBody: 'json',
    // read:me is the identity the screen shows; offline_access is the refresh token (Atlassian rotates it on every renewal)
    baseScopes: ['offline_access', 'read:me'],
    scopeParam: true,
    authorizeExtra: { audience: 'api.atlassian.com', prompt: 'consent' },
    refreshes: true,
    instance: null,
    incremental: true,
    defaultServices: ['issues'],
    services: catalogServices('jira'),
  },
  linear: {
    id: 'linear',
    label: 'Linear',
    pkce: false,
    clientAuth: 'body',
    tokenBody: 'form',
    scopeSeparator: ',',
    baseScopes: [],
    scopeParam: true,
    authorizeExtra: { prompt: 'consent' },
    refreshes: true,
    instance: null,
    incremental: true,
    defaultServices: ['issues'],
    services: catalogServices('linear'),
  },
  // the id has no underscore: a connection's slug is its provider id, and a slug is lower-case letters, digits and hyphens (a hyphen would not be a valid variable name in MANYTHREADS_OAUTH_<ID>_*)
  githubissues: {
    id: 'githubissues',
    label: 'GitHub Issues',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: [],
    scopeParam: true,
    authorizeExtra: {},
    // an OAuth app's token does not expire; one made by a GitHub App with expiring tokens would send a refresh token, which this treats as none (the person connects again)
    refreshes: false,
    instance: null,
    incremental: true,
    defaultServices: ['issues'],
    services: catalogServices('githubissues'),
  },
  asana: {
    id: 'asana',
    label: 'Asana',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: [],
    scopeParam: true,
    authorizeExtra: {},
    refreshes: true,
    instance: null,
    incremental: true,
    defaultServices: ['tasks'],
    services: catalogServices('asana'),
  },
  // Support and CRM (PLAN P16-07). Zendesk and Salesforce are at an address of the customer's own account; Intercom and HubSpot are one address for everyone.
  zendesk: {
    id: 'zendesk',
    label: 'Zendesk',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'json',
    baseScopes: [],
    scopeParam: true,
    authorizeExtra: {},
    // Zendesk hands out a refresh token only when the app opted in to expiring tokens; without one a token that is refused ends the sign-in, which the store already handles
    refreshes: true,
    instance: { suffix: '.zendesk.com', label: 'Zendesk' },
    incremental: false,
    defaultServices: ['tickets'],
    services: catalogServices('zendesk'),
  },
  intercom: {
    id: 'intercom',
    label: 'Intercom',
    pkce: false,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: [],
    // what the app may do is set on the app at Intercom (like Notion), and what the person agrees to is the workspace they pick
    scopeParam: false,
    authorizeExtra: {},
    refreshes: false,
    instance: null,
    incremental: false,
    defaultServices: ['conversations'],
    services: catalogServices('intercom'),
  },
  hubspot: {
    id: 'hubspot',
    label: 'HubSpot',
    pkce: false,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: [],
    scopeParam: true,
    authorizeExtra: {},
    refreshes: true,
    instance: null,
    incremental: false,
    defaultServices: ['contacts'],
    services: catalogServices('hubspot'),
  },
  salesforce: {
    id: 'salesforce',
    label: 'Salesforce',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'form',
    // refresh_token is the offline grant Salesforce wants named
    baseScopes: ['refresh_token'],
    scopeParam: true,
    authorizeExtra: {},
    refreshes: true,
    instance: { suffix: '.my.salesforce.com', label: 'Salesforce' },
    incremental: false,
    defaultServices: ['records'],
    services: catalogServices('salesforce'),
  },
  // ---- the document sources (P16-08): read only, used by the knowledge sync through documents-provider.ts ----
  // Atlassian 3LO like Jira: the same consent address and token address, an app of its own for Confluence. The site is found from the accessible-resources list.
  confluence: {
    id: 'confluence',
    label: 'Confluence',
    pkce: false,
    clientAuth: 'body',
    tokenBody: 'json',
    baseScopes: ['offline_access', 'read:me'],
    scopeParam: true,
    authorizeExtra: { audience: 'api.atlassian.com', prompt: 'consent' },
    refreshes: true,
    instance: null,
    incremental: true,
    defaultServices: ['pages'],
    services: catalogServices('confluence'),
  },
  dropbox: {
    id: 'dropbox',
    label: 'Dropbox',
    pkce: true,
    clientAuth: 'body',
    tokenBody: 'form',
    // account_info.read is the identity the screen shows
    baseScopes: ['account_info.read'],
    scopeParam: true,
    // offline: a refresh token (Dropbox's access tokens last four hours)
    authorizeExtra: { token_access_type: 'offline' },
    refreshes: true,
    instance: null,
    incremental: true,
    defaultServices: ['files'],
    services: catalogServices('dropbox'),
  },
  box: {
    id: 'box',
    label: 'Box',
    pkce: false,
    clientAuth: 'body',
    tokenBody: 'form',
    baseScopes: [],
    // what the app may do (here: read and write nothing but `root_readonly`) is set on the app at Box, like Notion
    scopeParam: false,
    authorizeExtra: {},
    // Box rotates the refresh token on every renewal (flow.ts keeps the new one)
    refreshes: true,
    instance: null,
    incremental: false,
    defaultServices: ['files'],
    services: catalogServices('box'),
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

// ---- the account address of Zendesk and Salesforce ---------------------------------------------------------------------------------------------------------

/** One DNS label: lower-case letters, digits and single hyphens, not at either end, at most 63 characters. No dot, so it can never name another host or a path; no double hyphen, so it can never be a sandbox or an `xn--` name. */
const INSTANCE_LABEL = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,61}[a-z0-9]$|^[a-z0-9]$/;

/** The subdomain as it will be used (trimmed, lower-cased), or null when it is not a single plain label. */
export function instanceLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim().toLowerCase();
  return label.length <= 63 && INSTANCE_LABEL.test(label) ? label : null;
}

/** Thrown when a provider that lives at the customer's own address has no usable subdomain. The message is ours. */
export class InstanceError extends Error {
  constructor(label: string) {
    super(`${label} needs the subdomain of your account first. A workspace admin enters it with the app.`);
    this.name = 'InstanceError';
  }
}

/** The subdomain a provider's sign-in and calls go to: the workspace app's setting, else the server's `MANYTHREADS_OAUTH_<PROVIDER>_INSTANCE`. Null when the provider has none or it is not valid. */
export function instanceOf(id: PersonProviderId, env: Env, tenant?: string | null): string | null {
  if (!PROVIDERS[id].instance) return null;
  return instanceLabel(tenant ?? env[`MANYTHREADS_OAUTH_${id.toUpperCase()}_INSTANCE`]);
}

/** True when the provider is reachable now: it has no account address, or the tests' fake stands in for it, or a valid subdomain is known. */
export function instanceReady(id: PersonProviderId, env: Env, tenant?: string | null): boolean {
  return PROVIDERS[id].instance === null || fakeBase(id, env) !== null || instanceOf(id, env, tenant) !== null;
}

/** `https://acme.zendesk.com`: the one label and the provider's own suffix. */
function instanceHost(id: PersonProviderId, env: Env, tenant: string | null | undefined): string {
  const rule = PROVIDERS[id].instance;
  const label = instanceOf(id, env, tenant);
  if (!rule || label === null) throw new InstanceError(PROVIDERS[id].label);
  return `https://${label}${rule.suffix}`;
}

export interface Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Null when the provider has no revoke address (Microsoft: signing out of Graph is a wider act than this), or when its revoke call does not fit the shared one (Linear wants the token in a header; Asana wants the app's id and secret as well; GitHub revokes at a per-app address): the sealed tokens are deleted here either way, and the person can remove the grant at the provider. */
  revokeUrl: string | null;
  /** The base of the provider's API; the tools add their own paths. */
  apiBase: string;
  /** Dropbox serves file downloads from a second host; the address of it (the fake's own address in tests). Absent for every other provider. */
  contentBase?: string;
}

/** The version of the Salesforce REST API every call names. */
export const SALESFORCE_API = 'v62.0';

const TENANT = /^(?:common|organizations|consumers|[0-9a-fA-F-]{36}|[A-Za-z0-9][A-Za-z0-9.-]{0,62})$/;

/** The fake provider of tests and fixtures, only outside production, only for an `http(s)` address. */
function fakeBase(id: PersonProviderId, env: Env): string | null {
  if (env['NODE_ENV'] === 'production') return null;
  const raw = env[`MANYTHREADS_OAUTH_${id.toUpperCase()}_FAKE_BASE`]?.trim().replace(/\/+$/, '');
  if (!raw) return null;
  return /^https?:\/\/[^\s/]+$/.test(raw) ? raw : null;
}

/**
 * `tenant` is the Microsoft directory a workspace admin chose for the workspace's app (without one the server's setting, or `common`, is used), or for Zendesk and Salesforce
 * the subdomain of the account (without one the server's setting; none at all throws an `InstanceError`).
 */
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
    case 'jira':
      return fake
        ? { authorizeUrl: `${fake}/jira/authorize`, tokenUrl: `${fake}/jira/oauth/token`, revokeUrl: null, apiBase: `${fake}/jira-api` }
        : { authorizeUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token', revokeUrl: null, apiBase: 'https://api.atlassian.com' };
    case 'linear':
      return fake
        ? { authorizeUrl: `${fake}/linear/oauth/authorize`, tokenUrl: `${fake}/linear/oauth/token`, revokeUrl: null, apiBase: `${fake}/linear-api` }
        : { authorizeUrl: 'https://linear.app/oauth/authorize', tokenUrl: 'https://api.linear.app/oauth/token', revokeUrl: null, apiBase: 'https://api.linear.app' };
    case 'githubissues':
      return fake
        ? { authorizeUrl: `${fake}/github/login/oauth/authorize`, tokenUrl: `${fake}/github/login/oauth/access_token`, revokeUrl: null, apiBase: `${fake}/github-api` }
        : { authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', revokeUrl: null, apiBase: 'https://api.github.com' };
    case 'asana':
      return fake
        ? { authorizeUrl: `${fake}/asana/-/oauth_authorize`, tokenUrl: `${fake}/asana/-/oauth_token`, revokeUrl: null, apiBase: `${fake}/asana-api/api/1.0` }
        : { authorizeUrl: 'https://app.asana.com/-/oauth_authorize', tokenUrl: 'https://app.asana.com/-/oauth_token', revokeUrl: null, apiBase: 'https://app.asana.com/api/1.0' };
    case 'zendesk': {
      // Zendesk has no address to revoke a token at that this helper can call (it is a DELETE by token id)
      if (fake) return { authorizeUrl: `${fake}/oauth/authorizations/new`, tokenUrl: `${fake}/oauth/tokens`, revokeUrl: null, apiBase: `${fake}/api/v2` };
      const host = instanceHost(id, env, tenant);
      return { authorizeUrl: `${host}/oauth/authorizations/new`, tokenUrl: `${host}/oauth/tokens`, revokeUrl: null, apiBase: `${host}/api/v2` };
    }
    case 'intercom':
      return fake
        ? { authorizeUrl: `${fake}/oauth`, tokenUrl: `${fake}/auth/eagle/token`, revokeUrl: null, apiBase: fake }
        : { authorizeUrl: 'https://app.intercom.com/oauth', tokenUrl: 'https://api.intercom.io/auth/eagle/token', revokeUrl: null, apiBase: 'https://api.intercom.io' };
    case 'hubspot':
      return fake
        ? { authorizeUrl: `${fake}/oauth/authorize`, tokenUrl: `${fake}/oauth/v1/token`, revokeUrl: null, apiBase: fake }
        : { authorizeUrl: 'https://app.hubspot.com/oauth/authorize', tokenUrl: 'https://api.hubapi.com/oauth/v1/token', revokeUrl: null, apiBase: 'https://api.hubapi.com' };
    case 'salesforce': {
      if (fake) return { authorizeUrl: `${fake}/services/oauth2/authorize`, tokenUrl: `${fake}/services/oauth2/token`, revokeUrl: `${fake}/services/oauth2/revoke`, apiBase: `${fake}/services/data/${SALESFORCE_API}` };
      // the account's My Domain serves the sign-in and the API alike, so the instance address Salesforce answers with is never used
      const host = instanceHost(id, env, tenant);
      return { authorizeUrl: `${host}/services/oauth2/authorize`, tokenUrl: `${host}/services/oauth2/token`, revokeUrl: `${host}/services/oauth2/revoke`, apiBase: `${host}/services/data/${SALESFORCE_API}` };
    }
    case 'confluence':
      return fake
        ? { authorizeUrl: `${fake}/authorize`, tokenUrl: `${fake}/oauth/token`, revokeUrl: null, apiBase: fake }
        : { authorizeUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token', revokeUrl: null, apiBase: 'https://api.atlassian.com' };
    case 'dropbox':
      // Dropbox's revoke call wants the access token as a bearer header, which the shared revoke does not send: the sealed tokens are deleted here either way
      return fake
        ? { authorizeUrl: `${fake}/oauth2/authorize`, tokenUrl: `${fake}/oauth2/token`, revokeUrl: null, apiBase: fake, contentBase: fake }
        : {
            authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
            tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
            revokeUrl: null,
            apiBase: 'https://api.dropboxapi.com',
            contentBase: 'https://content.dropboxapi.com',
          };
    case 'box':
      // Box's revoke call wants the app's id and secret as well as the token, which the shared revoke does not send
      return fake
        ? { authorizeUrl: `${fake}/api/oauth2/authorize`, tokenUrl: `${fake}/oauth2/token`, revokeUrl: null, apiBase: fake }
        : { authorizeUrl: 'https://account.box.com/api/oauth2/authorize', tokenUrl: 'https://api.box.com/oauth2/token', revokeUrl: null, apiBase: 'https://api.box.com' };
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
