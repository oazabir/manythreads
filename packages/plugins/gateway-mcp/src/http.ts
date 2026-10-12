import { HttpError, type HttpRequest, type HttpResponse, type PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

// The plugins' local HTTP kit (the same few lines every plugin keeps, because plugins never import each other).

export const unauthenticated = (message = 'A valid token is required'): HttpError => new HttpError(401, 'unauthenticated', message);
export const forbidden = (message = 'You do not have permission to do that'): HttpError => new HttpError(403, 'forbidden', message);
export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);

export const json = (body: unknown, status = 200): HttpResponse => ({ status, body });

interface PgError {
  code?: string;
  message?: string;
}

/**
 * Wraps a handler so database refusals become the right status: a row-level-security or definer-function denial is 403, a check
 * or foreign key violation 409, a duplicate 409, a bad uuid 400. A JSON-RPC answer never throws for a tool-level refusal — it
 * carries `isError` — so this only ever maps transport-shaped failures.
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
          throw forbidden('You do not have permission to do that');
        case '23505':
          throw new HttpError(409, 'conflict', 'That already exists');
        case '23503':
        case '23514':
          throw new HttpError(409, 'conflict', message ?? 'That change is not allowed');
        case '22P02':
          throw new HttpError(400, 'validation_failed', 'Malformed identifier');
        default:
          throw err;
      }
    }
  };
}
