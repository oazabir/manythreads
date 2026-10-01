import type { HttpRequest, HttpResponse, PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

/** A 4xx the server's error handler turns into the error envelope (403 forbidden, 404 not_found, 409 conflict, 400). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const forbidden = (message = 'You do not have permission to do that'): HttpError => new HttpError(403, message);
export const notFound = (message: string): HttpError => new HttpError(404, message);
export const conflict = (message: string): HttpError => new HttpError(409, message);

/** A response the error handler has no status mapping for (410): returned before anything is written. */
export const gone = (message: string): HttpResponse => ({
  status: 410,
  body: { error: { code: 'gone', message } },
});

export const json = (body: unknown, status = 200): HttpResponse => ({ status, body });

interface PgError {
  code?: string;
  message?: string;
}

/**
 * Wraps a handler so database refusals become the right status: a row-level-security or definer-function denial
 * is 403 (without the SQL text), a missing row raised by a teams_* function 404, a constraint 409, a bad uuid 400.
 * Anything else is a server error.
 */
export function route(
  handler: (req: HttpRequest, tx: PluginTx) => Promise<HttpResponse>,
): (req: HttpRequest, tx: PluginTx) => Promise<HttpResponse> {
  return async (req, tx) => {
    try {
      return await handler(req, tx);
    } catch (err) {
      if (err instanceof HttpError || err instanceof z.ZodError || !(err instanceof Error)) throw err;
      const { code, message } = err as PgError;
      switch (code) {
        case '42501':
          throw forbidden();
        case 'P0002':
          throw notFound(message ?? 'Not found');
        case '23505':
          throw conflict('That already exists');
        case '23514':
        case '23503':
          throw conflict(message ?? 'That change is not allowed');
        case '22P02':
          throw new HttpError(400, 'Malformed identifier');
        default:
          throw err;
      }
    }
  };
}

export const SlugParam = z.object({ slug: z.string().min(1).max(63) });
export const TeamPersonParams = z.object({ slug: z.string().min(1).max(63), personId: z.uuid() });
export const TeamTagParams = z.object({ slug: z.string().min(1).max(63), tag: z.string().min(1).max(80) });
export const TeamPersonTagParams = z.object({
  slug: z.string().min(1).max(63),
  personId: z.uuid(),
  tag: z.string().min(1).max(80),
});
export const TokenParam = z.object({ token: z.string().min(16).max(256) });
