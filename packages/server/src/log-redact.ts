import type { FastifyRequest } from 'fastify';

/** The token segment of an embedded-app address: `~mta.<token>`, up to the next `/`, `?` or `#` (one pass, no nested quantifier). */
const APP_TOKEN_SEGMENT = /~mta\.[^/?#]*/g;

/**
 * A URL as it may be logged: the per-open app token (a five-minute bearer capability for one team folder) is replaced, wherever it sits in the
 * address (L4 of the Phase 4 review: `logger: true` logged every `req.url`, `/repo/app/~mta.<token>/...` included).
 */
export const redactUrl = (url: string): string => url.replace(APP_TOKEN_SEGMENT, '~mta.[redacted]');

/** Fastify's default request serializer with the URL redacted. */
export const serializeRequest = (req: FastifyRequest): Record<string, unknown> => ({
  method: req.method,
  url: redactUrl(req.url),
  version: req.headers['accept-version'],
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});

/** `logger` option of the server with the request serializer in front: `true` and any options object are covered; a ready-made logger is left alone. */
export function withRedactedLogs(logger: boolean | object | undefined): boolean | object {
  if (logger === undefined || logger === false) return false;
  if (logger === true) return { serializers: { req: serializeRequest } };
  if (typeof (logger as { info?: unknown }).info === 'function') return logger;
  const base = logger as { serializers?: Record<string, unknown> };
  return { ...base, serializers: { ...base.serializers, req: serializeRequest } };
}
