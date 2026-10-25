import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';

/** How the install serves HTTPS. Chosen when the cluster is deployed (Helm values); the server only reports it. */
export const HttpsMode = z.enum(['none', 'cloudflare', 'letsencrypt']);
export type HttpsMode = z.infer<typeof HttpsMode>;

/** Cloudflare only: `strict` = the cluster holds a Cloudflare origin certificate; `flexible` = Cloudflare talks plain HTTP to the cluster. */
export const HttpsOrigin = z.enum(['strict', 'flexible']);
export type HttpsOrigin = z.infer<typeof HttpsOrigin>;

export const HttpsCheckId = z.enum(['public-url', 'wildcard', 'client-ip', 'proxy-match']);
export type HttpsCheckId = z.infer<typeof HttpsCheckId>;

export const HttpsCheck = z.object({
  id: HttpsCheckId,
  status: z.enum(['ok', 'warn', 'fail', 'skipped']),
  /** One or two plain sentences: what was tried and what happened. */
  detail: z.string(),
});
export type HttpsCheck = z.infer<typeof HttpsCheck>;

/**
 * Domain & HTTPS status (Settings, Domain & HTTPS; onboarding step 4). Workspace admins and owners only; everyone else gets 404.
 * The checks run live against the install's own public address, each with a five second limit.
 */
export const GetWorkspaceHttpsResponse = z.object({
  mode: HttpsMode,
  /** Set only in Cloudflare mode. */
  origin: HttpsOrigin.nullable(),
  /** Whether one certificate covers every app host (`<app>--<team>.<apps domain>`). */
  wildcard: z.boolean(),
  /** Let's Encrypt only: `staging` certificates are not trusted by browsers. */
  acmeServer: z.enum(['production', 'staging']).nullable(),
  /** Host of the public URL, or null when it is not a valid URL. */
  domain: z.string().nullable(),
  /** The domain app hosts live under, or null when apps have no domain of their own. */
  appsDomain: z.string().nullable(),
  checks: z.array(HttpsCheck),
  /** What the server derived for this very request. */
  seenAs: z.object({ clientIp: z.string(), viaCloudflare: z.boolean() }),
});
export type GetWorkspaceHttpsResponse = z.infer<typeof GetWorkspaceHttpsResponse>;
export const getWorkspaceHttpsRoute = { method: 'GET', path: '/api/workspace/https' } as const satisfies ApiRoute;
