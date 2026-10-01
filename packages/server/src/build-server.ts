import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import {
  NIL_UUID,
  createRateLimiter,
  createWsHub,
  withActor,
  type Actor,
  type PluginHost,
  type RateLimiter,
} from '@manythreads/kernel';
import { type ActorId, type WorkspaceId, HealthResponse, ErrorEnvelope, ReadyResponse, healthRoute, readyRoute, WsEnvelope } from '@manythreads/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { DEV_ACTOR_HEADER, devAuthEnabled, parseDevActor } from './dev-actor.ts';
import { envelope, errorHandler, notFoundHandler } from './errors.ts';
import './types.ts';

export interface BuildServerOptions {
  /** Loaded plugins: their http routes are mounted and their names listed in /healthz. */
  host?: PluginHost;
  /** manythreads_app pool used by health checks and plugin routes (default: the shared app pool). */
  pool?: pg.Pool;
  /** manythreads_system pool, used only for a system actor (default: the shared system pool). Never for requests. */
  systemPool?: pg.Pool;
  /** Honour the x-manythreads-dev-actor header. Default: NODE_ENV=test or MANYTHREADS_DEV_AUTH=1. Phase 2 removes it. */
  devAuth?: boolean;
  /** Fastify logger setting (default false). */
  logger?: boolean | object;
  /** Replace the in-memory limiter (tests). Each server builds its own by default: limits are per replica. */
  limiter?: RateLimiter;
  /** Migration files the kernel and loaded plugins ship; /readyz fails while fewer are applied. */
  expectedMigrations?: number;
  /** Register more routes (they get the same validator, error handler and hooks). */
  routes?: (app: FastifyInstance) => void | Promise<void>;
}

/** The nil person: no workspace, no memberships. */
const ANONYMOUS: Actor = { kind: 'person', id: NIL_UUID as ActorId, workspaceId: NIL_UUID as WorkspaceId };

const clientKey = (req: FastifyRequest): string => (req.actor ? `actor:${req.actor.id}` : `ip:${req.ip}`);

/**
 * Fastify host: Zod validator and serializer on every route, one error envelope, in-memory rate limits per replica,
 * OpenAPI generated from the same schemas, health endpoints, plugin routes and the WebSocket hub.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  const limiter = options.limiter ?? createRateLimiter();
  const hub = createWsHub();
  app.decorate('rateLimiter', limiter);
  app.decorate('wsHub', hub);
  app.decorateRequest('actor', null);

  const devAuth = options.devAuth ?? devAuthEnabled();
  const poolOpt = options.pool ? { pool: options.pool } : {};

  await app.register(swagger, {
    openapi: { info: { title: 'manythreads', version: '0.0.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    if (req.is404) return;
    if (devAuth) req.actor = parseDevActor(req.headers[DEV_ACTOR_HEADER]);
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
  typed.get('/ws', { websocket: true, config: { public: true } }, (socket) => {
    socket.on('message', (data: Buffer) => {
      void hub.receive({ send: (d) => socket.send(d) }, data.toString());
    });
  });

  mountPluginRoutes(app, options.host, poolOpt, options.systemPool);
  await options.routes?.(app);
  return app;
}

function mountPluginRoutes(
  app: FastifyInstance,
  host: PluginHost | undefined,
  poolOpt: { pool?: pg.Pool },
  systemPool: pg.Pool | undefined,
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
      config: { ...(def.rateLimit ? { rateLimit: def.rateLimit } : {}), ...(def.public ? { public: true } : {}) },
      handler: async (req, reply) => {
        // A public route without a caller runs as the anonymous actor: RLS applies, it sees and writes nothing.
        const actor = req.actor ?? ANONYMOUS;
        const pool = actor.kind === 'system' ? systemPool : poolOpt.pool;
        const res = await withActor(
          actor,
          (tx) =>
            Promise.resolve(
              def.handler(
                {
                  params: req.params as Record<string, string>,
                  query: req.query as Record<string, string | undefined>,
                  body: req.body,
                },
                tx,
              ),
            ),
          pool ? { pool } : {},
        ).catch((err: unknown) => {
          if (err instanceof Error && !(err instanceof z.ZodError)) req.log.error({ err, plugin }, 'plugin route failed');
          throw err;
        });
        return reply.status(res.status ?? 200).send(res.body ?? null);
      },
    });
  }
}
