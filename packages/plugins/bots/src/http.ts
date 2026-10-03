import { HttpError, type HttpRequest, type HttpResponse, type PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

// The plugins' local HTTP kit (the same shape as channels' and teams'): errors as HttpError, a PgError → status mapping, and the two
// lookups every team route needs. Plugins never import each other, so each keeps its own copy of these few lines.

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
 * Wraps a handler so database refusals become the right status: a row-level-security or definer-function denial is 403 (no SQL text),
 * a check or foreign key violation 409 with the message the guard raised, a duplicate 409, a bad uuid 400.
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

/** A `type`, not an `interface`: only an object type alias satisfies `Record<string, unknown>` (the `query` constraint). */
export type TeamRow = {
  id: string;
  workspace_id: string;
  archived_at: Date | null;
};

/** The team of a slug as the caller may see it; 403 for a team they cannot see (404 only for a workspace admin, as in the teams plugin). */
export async function requireTeam(tx: PluginTx, slug: string): Promise<TeamRow> {
  const res = await tx.query<TeamRow>('SELECT id, workspace_id, archived_at FROM app.teams WHERE slug = $1', [slug]);
  const team = res.rows[0];
  if (team) return team;
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role === 'owner' || role === 'admin') throw notFound(`No team "${slug}"`);
  throw forbidden('You cannot see this team');
}

/** Lead or workspace admin (`manage`); anyone else on the team is 403. */
export async function requireManage(tx: PluginTx, team: TeamRow): Promise<void> {
  const res = await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'manage') AS ok", [team.id]);
  if (res.rows[0]?.ok !== true) throw forbidden('Only a team lead or workspace admin can do that');
}
