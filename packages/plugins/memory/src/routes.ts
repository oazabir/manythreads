import type { PluginContext } from '@manythreads/sdk';
import { ListMemoryConceptsPathParams, ListMemoryConceptsResponse, ListMemoryRetainLogPathParams, ListMemoryRetainLogQuery, ListMemoryRetainLogResponse, listMemoryConceptsRoute, listMemoryRetainLogRoute } from '@manythreads/shared';
import { json, requireManage, requireTeam, route } from '@manythreads/sdk';
import { RETAIN_LOG_COLUMNS, toMemoryRetainLogEntry, type RetainLogRow } from './rows.ts';
import { listMemoryConcepts } from './concepts.ts';

/**
 * `GET /api/teams/:slug/memory/retain-log`: what the platform retained into the team's bank, replaced, forgot or withheld, newest first. The
 * team's leads and workspace admins (the table's own policy says the same); everyone else is 403 before a row is read.
 */
export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listMemoryRetainLogRoute,
    schema: { query: ListMemoryRetainLogQuery, response: ListMemoryRetainLogResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListMemoryRetainLogPathParams.parse(req.params);
      const q = ListMemoryRetainLogQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const rows = (
        await tx.query<RetainLogRow>(
          `SELECT ${RETAIN_LOG_COLUMNS} FROM app.memory_retain_log
            WHERE team_id = $1::uuid
              AND ($2::text IS NULL OR outcome = $2)
              AND ($3::text IS NULL OR source_kind = $3)
              AND ($4::uuid IS NULL OR id < $4::uuid)
            ORDER BY id DESC LIMIT $5`,
          [team.id, q.outcome ?? null, q.source ?? null, q.before ?? null, q.limit + 1],
        )
      ).rows;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return json({ items: page.map(toMemoryRetainLogEntry), next: rows.length > q.limit && last ? last.id : null });
    }),
  });

  ctx.http.route({
    ...listMemoryConceptsRoute,
    schema: { response: ListMemoryConceptsResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListMemoryConceptsPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const items = await listMemoryConcepts(tx, team.id);
      return json({ items });
    }),
  });
}
