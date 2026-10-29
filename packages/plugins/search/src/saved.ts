import { HttpError, type PluginContext } from '@manythreads/sdk';
import {
  DeleteSavedSearchResponse,
  ListSavedSearchesResponse,
  MAX_SAVED_SEARCHES,
  SavedSearch,
  SavedSearchPathParams,
  SaveSearchRequest,
  SaveSearchResponse,
  deleteSavedSearchRoute,
  listSavedSearchesRoute,
  saveSearchRoute,
} from '@manythreads/shared';

type Row = { id: string; name: string; query: string; created_at: Date };
const toSaved = (r: Row): SavedSearch => SavedSearch.parse({ id: r.id, name: r.name, query: r.query, createdAt: r.created_at.toISOString() });
const COLUMNS = 'id, name, query, created_at';

/**
 * Saved searches (PLAN P14-11): a person's own list of named search boxes. The table's policies say the same as the routes
 * (the owner reads, adds and removes; nobody else, not an admin), and the stored text is run later as whoever opens it.
 */
export function registerSavedSearchRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listSavedSearchesRoute,
    schema: { response: ListSavedSearchesResponse },
    handler: async (_req, tx) => {
      const res = await tx.query<Row>(`SELECT ${COLUMNS} FROM app.saved_searches WHERE owner_id = app.actor() ORDER BY lower(name), id`);
      return { body: ListSavedSearchesResponse.parse({ items: res.rows.map(toSaved) }) };
    },
  });

  ctx.http.route({
    ...saveSearchRoute,
    schema: { body: SaveSearchRequest, response: SaveSearchResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: async (req, tx) => {
      const body = SaveSearchRequest.parse(req.body);
      // a text value in the database cannot hold a NUL character; refuse it here instead of failing with a 500
      if (body.name.includes('\u0000') || body.query.includes('\u0000')) throw new HttpError(400, 'validation_failed', 'The name and the search cannot hold control characters.');
      let row: Row | undefined;
      try {
        row = (
          await tx.query<Row>(
            `INSERT INTO app.saved_searches (workspace_id, owner_id, name, query) VALUES (app.workspace_id(), app.actor(), $1, $2) RETURNING ${COLUMNS}`,
            [body.name, body.query],
          )
        ).rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'conflict', 'You already have a saved search with that name. Pick another name.');
        if ((err as { code?: string }).code === '42501') throw new HttpError(403, 'forbidden', 'You cannot save searches');
        throw err;
      }
      // checked after the insert, so two saves at once cannot both slip under the cap (the refusal rolls this insert back)
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.saved_searches WHERE owner_id = app.actor()')).rows[0]?.n ?? 0;
      if (n > MAX_SAVED_SEARCHES) throw new HttpError(409, 'conflict', `You can keep ${MAX_SAVED_SEARCHES} saved searches. Remove one first.`);
      return { status: 201, body: SaveSearchResponse.parse(toSaved(row!)) };
    },
  });

  ctx.http.route({
    ...deleteSavedSearchRoute,
    schema: { response: DeleteSavedSearchResponse },
    handler: async (req, tx) => {
      const { savedSearchId } = SavedSearchPathParams.parse(req.params);
      const res = await tx.query('DELETE FROM app.saved_searches WHERE id = $1 AND owner_id = app.actor() RETURNING id', [savedSearchId]);
      return { body: DeleteSavedSearchResponse.parse({ removed: res.rows.length > 0 }) };
    },
  });
}
