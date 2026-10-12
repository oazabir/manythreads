import { HttpError, type HttpRequest, type HttpResponse, type PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

// The plugins' local HTTP kit (the same few lines channels, teams and bots each keep): errors as HttpError, a PgError →
// status mapping, and the one lookup these routes need. Plugins never import each other, so each holds its own copy.

export const forbidden = (message = 'You do not have permission to do that'): HttpError => new HttpError(403, 'forbidden', message);
export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);
export const invalid = (message: string): HttpError => new HttpError(400, 'validation_failed', message);

export const json = (body: unknown, status = 200): HttpResponse => ({ status, body });

interface PgError {
  code?: string;
  message?: string;
}

/**
 * Wraps a handler so database refusals become the right status: a row-level-security denial is 403 (no SQL text), a check
 * or foreign key violation 409 with the message the guard raised, a duplicate 409, a bad uuid 400.
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
          throw conflict('That already exists');
        case '23514':
        case '23503':
          throw conflict(message ?? 'That change is not allowed');
        case '40P01':
          throw conflict('Another change was in progress. Try again.');
        case '22P02':
          throw invalid('Malformed identifier');
        default:
          throw err;
      }
    }
  };
}

/**
 * Workspace owner or admin; anyone else is 403 (the same rule the sign-in provider admin API uses). The LLM config
 * carries provider credentials, so it is not a team lead's to change.
 */
export async function requireWorkspaceAdmin(tx: PluginTx): Promise<{ personId: string | null }> {
  const res = await tx.query<{ role: string | null; person_id: string | null }>(
    'SELECT app.workspace_role() AS role, app.person_id() AS person_id',
  );
  const role = res.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can manage the LLM gateway.');
  return { personId: res.rows[0]?.person_id ?? null };
}
