import type { FastifyRequest } from 'fastify';

/** The token segment of an embedded-app address: `~mta.<token>`, up to the next `/`, `?` or `#` (one pass, no nested quantifier). */
const APP_TOKEN_SEGMENT = /~mta\.[^/?#]*/g;

/** The segment after `/api/mcp/runs/`. A run is named by its uuid in the path (its token travels in a header); anything else there is treated as a credential. */
const MCP_RUN_SEGMENT = /(\/api\/mcp\/runs\/)([^/?#]*)/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The secret segment of an incoming webhook's address, `/hooks/<webhook id>/<secret>`: whoever reads it can post into the channel. The id stays (it names the webhook in a log).
 * `/hooks/apps/<endpoint id>` (a work app's endpoint) and `/hooks/bridges/<provider>/<account id>` (a chat app) carry no secret in the address, the credential is a header, so
 * those two are left as they are: the ids name the endpoint or account in a log.
 */
const WEBHOOK_SECRET_SEGMENT = /^(\/hooks\/(?!apps\/|bridges\/)[^/?#]*\/)[^/?#]*/;

/**
 * A `token=` value in the query string (a client that puts a credential there lands it in the access log) and any integration token (`mtat_...`) wherever it sits. One pass each, no
 * nested quantifier. `hub.verify_token=` is WhatsApp's check of a chat bridge address (`GET /hooks/bridges/whatsapp/<account>`): the verify word the admin chose is in that query.
 */
const QUERY_TOKEN = /([?&](?:hub\.verify_)?token=)[^&#]*/gi;
const API_TOKEN_TEXT = /mtat_[A-Za-z0-9_-]+/g;

/**
 * A URL as it may be logged: the per-open app token (a five-minute bearer capability for one team folder) is replaced, wherever it sits in the
 * address (L4 of the Phase 4 review: `logger: true` logged every `req.url`, `/repo/app/~mta.<token>/...` included).
 */
export const redactUrl = (url: string): string =>
  url
    .replace(APP_TOKEN_SEGMENT, '~mta.[redacted]')
    .replace(WEBHOOK_SECRET_SEGMENT, '$1[redacted]')
    .replace(QUERY_TOKEN, '$1[redacted]')
    .replace(API_TOKEN_TEXT, '[redacted]')
    // Defensive: the MCP gateway no longer puts a run token in its path, but a client holding an older URL (or a typo that pastes a
    // token there) must not land one in the access log.
    .replace(MCP_RUN_SEGMENT, (_m, prefix: string, segment: string) => `${prefix}${UUID.test(segment) ? segment : '[redacted]'}`);

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
