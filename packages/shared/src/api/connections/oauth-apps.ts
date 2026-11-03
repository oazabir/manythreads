import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import type { ApiRoute } from '../client/route.ts';
import { PersonProviderId } from './person.ts';

// The OAuth apps a workspace admin enters (PLAN P16-02). A self-hosted company signs its people in to Google and Microsoft with its own apps: the admin registers an
// app at the provider, copies the redirect address shown here into it, and enters the app's client id and secret. The secret is sealed on the way in and no route
// returns it, or a hint of it. The server's environment can still supply an app (a single-workspace install); an app entered here wins over it.

export const OAuthAppParams = z.object({ provider: PersonProviderId });
export type OAuthAppParams = z.infer<typeof OAuthAppParams>;

/** Where an app comes from: entered by an admin for this workspace, or set in the server's environment. Null: there is none. */
export const OAuthAppSource = z.enum(['workspace', 'server']);
export type OAuthAppSource = z.infer<typeof OAuthAppSource>;

export const OAuthAppStatus = z.strictObject({
  provider: PersonProviderId,
  label: z.string().max(80),
  /** The address to register at the provider, the same for every person. */
  redirectUri: z.string().max(500),
  source: OAuthAppSource.nullable(),
  /** The client id of the app an admin entered (it is not a secret: every consent address carries it). Null for the server's environment, which is not shown, and for none. */
  clientId: z.string().max(500).nullable(),
  /** Microsoft only: which directory people sign in to. */
  tenant: z.string().max(64).nullable(),
  /** The provider has a tenant setting (Microsoft). */
  supportsTenant: z.boolean(),
  /** A client secret is stored. It cannot be shown. */
  hasSecret: z.boolean(),
  updatedAt: IsoDateTime.nullable(),
});
export type OAuthAppStatus = z.infer<typeof OAuthAppStatus>;

export const ListOAuthAppsResponse = z.strictObject({ apps: z.array(OAuthAppStatus) });
export type ListOAuthAppsResponse = z.infer<typeof ListOAuthAppsResponse>;
export const listOAuthAppsRoute = { method: 'GET', path: '/api/admin/connections/oauth-apps' } as const satisfies ApiRoute;

/** Both are required every time: a new secret goes with its client id, so one app's id is never paired with another's secret. A blank tenant means the server's default. */
export const PutOAuthAppRequest = z.strictObject({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(2000),
  tenant: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/, 'a directory id, a domain, or common, organizations or consumers')
    .nullish(),
});
export type PutOAuthAppRequest = z.infer<typeof PutOAuthAppRequest>;
export const PutOAuthAppResponse = z.strictObject({ app: OAuthAppStatus });
export type PutOAuthAppResponse = z.infer<typeof PutOAuthAppResponse>;
export const putOAuthAppRoute = { method: 'PUT', path: '/api/admin/connections/oauth-apps/:provider' } as const satisfies ApiRoute;

export const ClearOAuthAppResponse = z.strictObject({ cleared: z.boolean() });
export type ClearOAuthAppResponse = z.infer<typeof ClearOAuthAppResponse>;
export const clearOAuthAppRoute = { method: 'DELETE', path: '/api/admin/connections/oauth-apps/:provider' } as const satisfies ApiRoute;
