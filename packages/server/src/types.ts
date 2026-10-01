import type { Actor, CapabilityBroker, RateLimit, RateLimiter, WsHub } from '@manythreads/kernel';

/** Per-route settings read from `config` by the server's hooks. */
export interface ManythreadsRouteConfig {
  /** Sliding-window limit per key (actor id, else client IP) on this route; in process memory, per replica. */
  rateLimit?: RateLimit;
  /** Callable without an actor. Everything else answers 401 until a request carries an actor. */
  public?: boolean;
}

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging: adds ManythreadsRouteConfig
  interface FastifyContextConfig extends ManythreadsRouteConfig {}
  interface FastifyRequest {
    /** Who is calling; null for anonymous requests (only `public` routes get through). */
    actor: Actor | null;
  }
  interface FastifyInstance {
    readonly wsHub: WsHub;
    readonly rateLimiter: RateLimiter;
    /** Set by startServer; undefined on servers built directly with buildServer. */
    readonly broker: CapabilityBroker;
  }
}
