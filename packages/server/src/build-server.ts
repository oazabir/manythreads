import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import {
  NIL_UUID,
  createRateLimiter,
  createRealtime,
  createWsHub,
  withActor,
  type Actor,
  type PluginHost,
  type RateLimiter,
  type Realtime,
} from '@manythreads/kernel';
import { type ActorId, type WorkspaceId, HealthResponse, ErrorEnvelope, ReadyResponse, healthRoute, readyRoute, WsEnvelope } from '@manythreads/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { HttpError, type HttpRequest } from '@manythreads/sdk';
import type pg from 'pg';
import { z } from 'zod';
import { DEV_ACTOR_HEADER, devAuthEnabled, parseDevActor } from './dev-actor.ts';
import { envelope, errorHandler, notFoundHandler } from './errors.ts';
import {
  authenticateCookie,
  clearSessionCookies,
  csrfAllows,
  finishSessionCookies,
  mountTestAuth,
  setSessionCookies,
  type SessionService,
} from './session/index.ts';
import './types.ts';

export interface BuildServerOptions {
  /** Loaded plugins: their http routes are mounted and their names listed in /healthz. */
  host?: PluginHost;
  /** manythreads_app pool used by health checks and plugin routes (default: the shared app pool). */
  pool?: pg.Pool;
  /**
   * manythreads_system pool, used for a system actor and by the session lookup (a cookie resolves to a person before
   * any person transaction exists). Request handlers never run on it unless a route asks for the system actor.
   */
  systemPool?: pg.Pool;
  /** Cookie sessions. Without it only the test-only dev header can authenticate (unit tests of the host). */
  sessions?: SessionService;
  /**
   * TEST ONLY: mounts `POST /api/test/session` guarded by `x-test-auth: <this value>` (needs `sessions` and
   * `systemPool`). Leave unset anywhere real people sign in.
   */
  testAuthToken?: string | null;
  /**
   * Honour the x-manythreads-dev-actor header. It can only ever be on when NODE_ENV=test: this option cannot turn it
   * on elsewhere, only off. Real requests authenticate with a session cookie.
   */
  devAuth?: boolean;
  /** Fastify logger setting (default false). */
  logger?: boolean | object;
  /**
   * Believe `x-forwarded-for` (the server sits behind a reverse proxy or ingress that appends to it). Off by default:
   * with it on and no proxy, anybody could claim any client address and sidestep the sign-in lockout. `true` means ONE
   * proxy hop (the client address is the entry the nearest proxy appended, never what the client wrote at the front of
   * the header); a number is that many hops; a string or list is the proxy addresses / CIDRs to trust.
   */
  trustProxy?: boolean | number | string | string[];
  /**
   * Live pushes (`ctx.realtime`, read-state changes): sockets of signed-in people register here. The caller starts it
   * (`realtime.start(pool)`) so pushes from every replica arrive; default: a registry nobody feeds.
   */
  realtime?: Realtime;
  /** Replace the in-memory limiter (tests). Each server builds its own by default: limits are per replica. */
  limiter?: RateLimiter;
  /** Migration files the kernel and loaded plugins ship; /readyz fails while fewer are applied. */
  expectedMigrations?: number;
  /** Register more routes (they get the same validator, error handler and hooks). */
  routes?: (app: FastifyInstance) => void | Promise<void>;
}

/** The nil person: no workspace, no memberships. */
const ANONYMOUS: Actor = { kind: 'person', id: NIL_UUID as ActorId, workspaceId: NIL_UUID as WorkspaceId };

/**
 * Fastify's own `true` takes the LEFTMOST x-forwarded-for entry (client-written), and its numeric form does not count
 * hops the way proxy-addr does, so hop counts become an explicit function: trust the first N addresses starting at the
 * socket peer, and the client is the first address that is not trusted (what the Nth proxy appended).
 */
function trustProxySetting(value: BuildServerOptions['trustProxy']): boolean | string | string[] | ((address: string, hop: number) => boolean) {
  if (value === undefined || value === false || value === 0) return false;
  const hops = value === true ? 1 : value;
  return typeof hops === 'number' ? (_address: string, hop: number): boolean => hop < hops : hops;
}

const clientKey = (req: FastifyRequest): string => (req.actor ? `actor:${req.actor.id}` : `ip:${req.ip}`);

/**
 * Fastify host: Zod validator and serializer on every route, one error envelope, in-memory rate limits per replica,
 * OpenAPI generated from the same schemas, health endpoints, plugin routes and the WebSocket hub.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: trustProxySetting(options.trustProxy) });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  const limiter = options.limiter ?? createRateLimiter();
  const hub = createWsHub();
  app.decorate('rateLimiter', limiter);
  app.decorate('wsHub', hub);
  const realtime = options.realtime ?? createRealtime();
  app.decorate('realtime', realtime);
  app.decorateRequest('actor', null);
  app.decorateRequest('authSession', null);
  app.decorateRequest('staleSessionCookie', false);

  const devAuth = options.devAuth !== false && devAuthEnabled();
  const sessions = options.sessions;
  const poolOpt = options.pool ? { pool: options.pool } : {};

  await app.register(swagger, {
    openapi: { info: { title: 'manythreads', version: '0.0.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(websocket);
  await app.register(cookie);

  app.addHook('onRequest', async (req, reply) => {
    if (req.is404) return;
    if (devAuth) req.actor = parseDevActor(req.headers[DEV_ACTOR_HEADER]);
    if (!req.actor && sessions) await authenticateCookie(req, reply, sessions);
    if (!csrfAllows(req)) {
      return reply.status(403).send(envelope('forbidden', 'CSRF token missing or invalid'));
    }
    const config = req.routeOptions.config;
    if (config.public !== true && !req.actor) {
      return reply.status(401).send(envelope('unauthenticated', 'Sign in required'));
    }
    const rule = config.rateLimit;
    if (rule) {
      const res = limiter.hit(clientKey(req), `${req.method} ${req.routeOptions.url ?? req.url}`, rule);
      void reply.header('x-ratelimit-limit', String(res.limit)).header('x-ratelimit-remaining', String(res.remaining));
      if (!res.allowed) {
        void reply.header('retry-after', String(Math.ceil(res.retryAfterMs / 1000)));
        return reply
          .status(429)
          .send(envelope('rate_limited', `Rate limit of ${rule.limit} per ${Math.round(rule.windowMs / 1000)}s exceeded`));
      }
    }
    return undefined;
  });

  if (sessions) {
    app.addHook('onSend', (req, reply, payload, done) => {
      finishSessionCookies(req, reply, sessions);
      done(null, payload);
    });
  }

  const typed = app.withTypeProvider<ZodTypeProvider>();

  // schema_migrations has no RLS, so an anonymous app-role transaction can count it.
  const appliedMigrations = (): Promise<number> =>
    withActor(ANONYMOUS, async (tx) => {
      const res = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.schema_migrations');
      return res.rows[0]?.n ?? 0;
    }, poolOpt);

  typed.get(
    healthRoute.path,
    {
      config: { public: true },
      schema: { response: { 200: HealthResponse, 503: ErrorEnvelope } },
    },
    async (_req, reply) => {
      let migrations = 0;
      try {
        migrations = await appliedMigrations();
      } catch {
        return reply.status(503).send(envelope('internal', 'Database unreachable'));
      }
      return { status: 'ok' as const, migrations, plugins: (options.host?.plugins ?? []).map((p) => p.manifest.name) };
    },
  );

  typed.get(
    readyRoute.path,
    { config: { public: true }, schema: { response: { 200: ReadyResponse, 503: ErrorEnvelope } } },
    async (_req, reply) => {
      try {
        const migrations = await appliedMigrations();
        const expected = options.expectedMigrations ?? 1;
        if (migrations < expected) {
          return reply.status(503).send(envelope('internal', `Migrations pending: ${migrations} of ${expected} applied`));
        }
        return { status: 'ready' as const, migrations };
      } catch {
        return reply.status(503).send(envelope('internal', 'Database unreachable'));
      }
    },
  );

  typed.get(
    '/openapi.json',
    { config: { public: true }, schema: { hide: true } },
    () => app.swagger(),
  );

  // WebSocket: every frame is a validated { type, id, payload } envelope, in both directions.
  hub.on('ping', (msg) => WsEnvelope.parse({ type: 'pong', id: msg.id, payload: msg.payload }));
  typed.get('/ws', { websocket: true, config: { public: true } }, (socket, req) => {
    const peer = { send: (d: string) => socket.send(d) };
    // A browser always sends Origin on an upgrade. The session cookie is SameSite=Lax (a cross-site page cannot send it); this also
    // refuses a same-site page of another origin (a sibling subdomain): its socket would carry the cookie and read the person's pushes.
    const origin = req.headers.origin;
    if (origin !== undefined && !sameHost(origin, req.host)) {
      socket.close(1008, 'origin not allowed');
      return;
    }
    // A signed-in person's sockets receive live pushes (read state, notifications). The upgrade request carried the cookie.
    let detach: (() => void) | undefined;
    let closed = false;
    if (req.actor && req.actor.kind === 'person') {
      const actor = req.actor;
      const known = req.authSession?.personId ?? null;
      const person = known
        ? Promise.resolve(known)
        : withActor(actor, async (tx) => (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null, poolOpt).catch(() => null);
      void person.then((personId) => {
        if (personId && !closed) detach = realtime.attach(personId, peer);
      });
    }
    socket.on('close', () => {
      closed = true;
      detach?.();
    });
    socket.on('message', (data: Buffer) => {
      void hub.receive(peer, data.toString());
    });
  });

  if (options.testAuthToken && sessions && options.systemPool) {
    mountTestAuth(app, { token: options.testAuthToken, sessions, pool: options.systemPool });
  }
  mountPluginRoutes(app, options.host, poolOpt, options.systemPool, sessions);
  await options.routes?.(app);
  return app;
}

/** The `host[:port]` of an Origin header equals the host the request was addressed to. */
function sameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function mountPluginRoutes(
  app: FastifyInstance,
  host: PluginHost | undefined,
  poolOpt: { pool?: pg.Pool },
  systemPool: pg.Pool | undefined,
  sessions: SessionService | undefined,
): void {
  if (!host) return;
  for (const { plugin, value: def } of host.registries.httpRoutes.list()) {
    const schema: Record<string, unknown> = {};
    if (def.schema?.body) schema['body'] = def.schema.body;
    if (def.schema?.query) schema['querystring'] = def.schema.query;
    if (def.schema?.response) schema['response'] = { 200: def.schema.response };
    app.route({
      method: def.method,
      url: def.fullPath,
      schema: schema as never,
      config: {
        ...(def.rateLimit ? { rateLimit: def.rateLimit } : {}),
        ...(def.public ? { public: true } : {}),
        ...(def.csrfExempt ? { csrfExempt: true } : {}),
      },
      handler: async (req, reply) => {
        // A public route without a caller runs as the anonymous actor: RLS applies, it sees and writes nothing.
        const actor = req.actor ?? ANONYMOUS;
        const pool = actor.kind === 'system' ? systemPool : poolOpt.pool;
        const request: HttpRequest = {
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string | undefined>,
          body: req.body,
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
          ),
          ip: req.ip,
          caller: req.actor
            ? {
                actorId: req.actor.id,
                kind: req.actor.kind === 'bot' ? 'bot' : 'person',
                workspaceId: req.actor.workspaceId,
                personId: req.authSession?.personId ?? null,
                sessionId: req.authSession?.sessionId ?? null,
              }
            : null,
        };
        const res = await withActor(actor, (tx) => Promise.resolve(def.handler(request, tx)), pool ? { pool } : {}).catch(
          (err: unknown) => {
            if (err instanceof Error && !(err instanceof z.ZodError) && !(err instanceof HttpError)) {
              req.log.error({ err, plugin }, 'plugin route failed');
            }
            throw err;
          },
        );
        if (res.headers) for (const [k, v] of Object.entries(res.headers)) void reply.header(k, v);
        if (sessions) {
          if (res.setSession) setSessionCookies(reply, res.setSession, sessions.config);
          else if (res.clearSession) clearSessionCookies(reply, sessions.config);
        }
        return reply.status(res.status ?? 200).send(res.body ?? null);
      },
    });
  }
}
