import { HttpError, type HttpRequest, type HttpResponse, type PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

// The plugin's local HTTP kit (the few lines every plugin keeps; plugins never import each other): errors as HttpError, a Postgres error → status
// mapping, and the workspace-admin check.

export const forbidden = (message = 'You do not have permission to do that'): HttpError => new HttpError(403, 'forbidden', message);
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);
export const json = (body: unknown, status = 200): HttpResponse => ({ status, body });

interface PgError {
  code?: string;
  message?: string;
}

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
        case '23514':
        case '23503':
          throw conflict(message ?? 'That change is not allowed');
        case '22P02':
          throw new HttpError(400, 'validation_failed', 'Malformed identifier');
        default:
          throw err;
      }
    }
  };
}

/** Workspace owner or admin; anyone else is 403. Setup is the admins' page. */
export async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can use the setup checklist.');
}
