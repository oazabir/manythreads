import { HttpError, type HttpRequest, type HttpResponse, type PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

/** 403 for a file or channel that does not exist or that the caller cannot see: nobody learns which. */
export const forbidden = (message = 'You cannot see this file'): HttpError => new HttpError(403, 'forbidden', message);
export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);
export const invalid = (message: string): HttpError => new HttpError(400, 'validation_failed', message);
/** 413 uses the `validation_failed` code of the error envelope (there is no separate code for it). */
export const tooLarge = (message: string): HttpError => new HttpError(413, 'validation_failed', message);

export const json = (body: unknown, status = 200): HttpResponse => ({ status, body });

/** Database refusals become the right status: a row-level-security denial is 403 (no SQL text), a check violation 409, a bad uuid 400. */
export function route(
  handler: (req: HttpRequest, tx: PluginTx) => Promise<HttpResponse>,
): (req: HttpRequest, tx: PluginTx) => Promise<HttpResponse> {
  return async (req, tx) => {
    try {
      return await handler(req, tx);
    } catch (err) {
      if (err instanceof HttpError || err instanceof z.ZodError || !(err instanceof Error)) throw err;
      const { code, message } = err as { code?: string; message?: string };
      switch (code) {
        case '42501':
          throw forbidden('You do not have permission to do that');
        case '23505':
          throw conflict('That already exists');
        case '23514':
        case '23503':
          throw conflict(message ?? 'That change is not allowed');
        case '22P02':
          throw invalid('Malformed identifier');
        default:
          throw err;
      }
    }
  };
}
