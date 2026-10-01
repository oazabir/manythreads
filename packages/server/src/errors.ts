import type { ErrorCode, ErrorEnvelope } from '@manythreads/shared';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

type PathSegment = string | number;

const toPath = (instancePath: string): PathSegment[] =>
  instancePath
    .split('/')
    .slice(1)
    .filter((s) => s !== '')
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));

const fromIssuePath = (path: readonly PropertyKey[]): PathSegment[] =>
  path.map((p) => (typeof p === 'number' || typeof p === 'string' ? p : String(p)));

const describe = (path: PathSegment[], message: string): string =>
  path.length > 0 ? `${path.join('.')}: ${message}` : message;

export const envelope = (
  code: ErrorCode,
  message: string,
  extra: Partial<ErrorEnvelope['error']> = {},
): ErrorEnvelope => ({ error: { code, message, ...extra } });

function validationEnvelope(issues: { code: string; message: string; path: PathSegment[] }[]): ErrorEnvelope {
  const first = issues[0];
  const path = first?.path ?? [];
  return envelope('validation_failed', describe(path, first?.message ?? 'Invalid request'), {
    path,
    details: issues,
  });
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'validation_failed',
  415: 'validation_failed',
  422: 'validation_failed',
  429: 'rate_limited',
};

/**
 * One error handler for the whole server. Zod validation failures (request side) and ZodErrors thrown by handlers
 * become 400 with the field path; a response that fails its own schema is a bug: 500, logged, never sent through.
 */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (hasZodFastifySchemaValidationErrors(err)) {
    const issues = err.validation.map((v) => ({
      code: v.keyword,
      message: v.message ?? 'Invalid value',
      path: toPath(v.instancePath),
    }));
    void reply.status(400).send(validationEnvelope(issues));
    return;
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ code: i.code, message: i.message, path: fromIssuePath(i.path) }));
    void reply.status(400).send(validationEnvelope(issues));
    return;
  }
  if (isResponseSerializationError(err)) {
    req.log.error({ err, method: err.method, url: err.url }, 'response failed its schema: server bug');
    void reply.status(500).send(envelope('internal', 'Internal server error'));
    return;
  }
  const status = (err as FastifyError).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = STATUS_CODES[status] ?? 'validation_failed';
    void reply.status(status).send(envelope(code, err.message));
    return;
  }
  req.log.error({ err }, 'unhandled error');
  void reply.status(500).send(envelope('internal', 'Internal server error'));
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send(envelope('not_found', `Route ${req.method} ${req.url.split('?')[0]} not found`));
}
