import {
  IssueAppTokenRequest,
  IssueAppTokenResponse,
  REPO_APP_PATH_RE,
  REPO_APP_ROUTE_PREFIX,
  issueAppTokenRoute,
  repoAppTokenPath,
  splitRepoAppRest,
} from '@manythreads/shared';
import { withActor, type Actor } from '@manythreads/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { envelope } from './errors.ts';
import type { AppTokens } from './app-token.ts';

/** What the person hears for every refused token: expired, tampered, for another app or team all read the same. */
const REFUSED = 'This app link has expired or is not valid. Reopen the app.';

/** True when Fastify matched this request to the app content route (decoded, routed: never the raw URL, which can spell the same route differently). */
export const isAppRoute = (req: FastifyRequest): boolean => req.routeOptions.url?.startsWith(REPO_APP_ROUTE_PREFIX) === true;

/**
 * The app content route's request as `{ slug, rest }` from the router's own decoded params (the very strings the handler reads), or null when
 * the request did not match that route. `rest` is what follows `/repo/app/`; the query string is not part of it.
 */
export function matchedAppRequest(req: FastifyRequest): { slug: string; rest: string } | null {
  if (!isAppRoute(req)) return null;
  const params = req.params as Record<string, string | undefined> | undefined;
  return { slug: params?.['slug'] ?? '', rest: params?.['*'] ?? '' };
}

/**
 * The app route is only reachable by its canonical spelling: the raw path must start with `/api/teams/<slug>/repo/app/` (no `%61pp`, no
 * `ap%70`, no doubled slashes). The router decodes before it matches, so a non-canonical spelling would reach the handler by a path every
 * raw-URL check misses; refusing it here keeps one spelling per resource.
 */
export const isCanonicalAppRequest = (req: FastifyRequest): boolean => REPO_APP_PATH_RE.test(req.url);

/**
 * The part of the server's `onRequest` hook that lets a token stand in for the session cookie on the app content route. Called after the
 * cookie was looked at: when the path carries a token it is the only way in (a person with a cookie and a bad token is refused, so a stale
 * link is never half-working); a valid one makes the request that person's, for this GET or HEAD only. Returns a reply to stop with, or
 * undefined to go on.
 */
export function authenticateAppToken(req: FastifyRequest, reply: FastifyReply, tokens: AppTokens): FastifyReply | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined;
  const parsed = matchedAppRequest(req);
  if (!parsed) return undefined;
  const { token, path } = splitRepoAppRest(parsed.rest);
  if (token === null) return undefined;
  const checked = tokens.verify(token, { slug: parsed.slug, path });
  if (!checked.ok) {
    req.log.info({ reason: checked.reason }, 'app token refused');
    return reply.status(403).send(envelope('forbidden', REFUSED));
  }
  const actor: Actor = { kind: 'person', id: checked.claim.a as Actor['id'], workspaceId: checked.claim.w as Actor['workspaceId'] };
  req.actor = actor;
  // Not a session: nothing to refresh, revalidate or sign out.
  req.authSession = null;
  return undefined;
}

/**
 * `POST /api/teams/:slug/repo/app-token`: a signed-in person who can read the team gets a token for one app folder. Cookie session and CSRF
 * are checked by the server's hook like for any unsafe request; a bot gets none (apps open in a person's browser). The folder is not looked
 * up here: the content route answers 404 for a folder without files, and the token opens nothing else.
 */
export function mountAppTokenRoute(app: FastifyInstance, deps: { tokens: AppTokens; pool?: pg.Pool }): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: issueAppTokenRoute.method,
    url: issueAppTokenRoute.path,
    schema: { body: IssueAppTokenRequest },
    config: { rateLimit: { limit: 120, windowMs: 60_000 } },
    handler: async (req, reply) => {
      const actor = req.actor;
      if (!actor || actor.kind !== 'person') return reply.status(403).send(envelope('forbidden', 'Only a person can open an app'));
      const slug = (req.params as { slug?: string }).slug ?? '';
      // The team is visible to the caller only if they can read it (row level security); an admin sees every team, so for them a missing slug is 404.
      const found = await withActor(
        actor,
        async (tx) => {
          const team = await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug]);
          if (team.rows[0]) return 'ok' as const;
          const admin = await tx.query<{ admin: boolean }>('SELECT app.is_workspace_admin() AS admin');
          return admin.rows[0]?.admin === true ? ('missing' as const) : ('hidden' as const);
        },
        deps.pool ? { pool: deps.pool } : {},
      );
      if (found === 'missing') return reply.status(404).send(envelope('not_found', 'Team not found'));
      if (found === 'hidden') return reply.status(403).send(envelope('forbidden', 'You are not a member of this team'));
      const { token, expiresAt } = deps.tokens.issue({ actorId: actor.id, workspaceId: actor.workspaceId, slug, folder: req.body.path });
      void reply.header('cache-control', 'no-store');
      return reply.status(200).send(
        IssueAppTokenResponse.parse({ token, expiresAt: expiresAt.toISOString(), path: req.body.path, url: repoAppTokenPath(slug, token, req.body.path) }),
      );
    },
  });
}
