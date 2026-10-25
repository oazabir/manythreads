import type { PluginContext } from '@manythreads/sdk';
import { GetWorkspaceHttpsResponse, getWorkspaceHttpsRoute, type HttpsCheck } from '@manythreads/shared';
import { randomBytes } from 'node:crypto';
import { checkClientIp, checkProxyMatch, checkPublicUrl, checkWildcard, hostOf, readHttpsConfig } from './https-checks.ts';
import { json, notFound, route } from './http.ts';
import { isWorkspaceAdmin } from './teams.ts';

const CACHE_MS = 15_000;

/**
 * The SDK gives a route handler its request transaction and no way to release it, so the outbound checks (up to 5 s) hold
 * one connection. To keep repeated clicks from stacking connections, the outbound results (public-url, wildcard) are cached in
 * process memory for 15 s and shared by concurrent callers (the cache holds the promise). They do not depend on the caller;
 * client-ip and proxy-match are recomputed for every request. The route also has a per-key rate limit.
 */
let cached: { at: number; run: Promise<[HttpsCheck, HttpsCheck]> } | null = null;

/** `GET /api/workspace/https`: how the install serves HTTPS and live checks of it. Read-only: the mode is set at deploy time. */
export function registerHttpsRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...getWorkspaceHttpsRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: GetWorkspaceHttpsResponse },
    handler: route(async (req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      // When MANYTHREADS_TLS_ORIGIN is missing in Cloudflare mode this reports "strict"; the Helm chart always sets it.
      const cfg = readHttpsConfig(process.env, ctx.runtime.publicUrl);
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        const rand = (): string => randomBytes(4).toString('hex');
        const entry = { at: Date.now(), run: Promise.all([checkPublicUrl(cfg, fetch), checkWildcard(cfg, fetch, rand)]) };
        cached = entry;
        entry.run.catch(() => {
          if (cached === entry) cached = null;
        });
      }
      const [publicUrl, wildcard] = await cached.run;
      const { check: clientIp, seenAs } = checkClientIp(req.ip, req.headers);
      return json(
        GetWorkspaceHttpsResponse.parse({
          mode: cfg.mode,
          origin: cfg.origin,
          wildcard: cfg.wildcard,
          acmeServer: cfg.acmeServer,
          domain: hostOf(cfg.publicUrl),
          appsDomain: cfg.appsDomain,
          checks: [publicUrl, wildcard, clientIp, checkProxyMatch(cfg.mode, req.headers)],
          seenAs,
        }),
      );
    }),
  });
}
