import type { PluginContext } from '@manythreads/sdk';
import { ConceptPathParams, ConfirmConceptResponse, DeprecateConceptResponse, ListMemoryConceptsPathParams, ListMemoryConceptsResponse, ListMemoryRetainLogPathParams, ListMemoryRetainLogQuery, ListMemoryRetainLogResponse, RebuildConceptsPathParams, RebuildConceptsResponse, confirmConceptRoute, deprecateConceptRoute, listMemoryConceptsRoute, listMemoryRetainLogRoute, rebuildConceptsRoute } from '@manythreads/shared';
import { json, requireManage, requireTeam, route } from '@manythreads/sdk';
import { RETAIN_LOG_COLUMNS, toMemoryRetainLogEntry, type RetainLogRow } from './rows.ts';
import { listMemoryConcepts, rebuildConcepts } from './concepts.ts';

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

  ctx.http.route({
    ...rebuildConceptsRoute,
    schema: { response: RebuildConceptsResponse },
    handler: route(async (req, tx) => {
      const { slug } = RebuildConceptsPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const concepts = await rebuildConcepts(tx, team.id);
      return json({ concepts });
    }),
  });

  ctx.http.route({
    ...confirmConceptRoute,
    schema: { response: ConfirmConceptResponse },
    handler: route(async (req, tx) => {
      const { slug } = ConceptPathParams.parse(req.params);
      await requireTeam(tx, slug);
      // Confirm appends `verified: human:<actor>` to the concept through the repo writer (P5-28). Stubbed here; full commit lands in a follow-up.
      return json({ ok: true });
    }),
  });

  ctx.http.route({
    ...deprecateConceptRoute,
    schema: { response: DeprecateConceptResponse },
    handler: route(async (req, tx) => {
      const { slug } = ConceptPathParams.parse(req.params);
      await requireTeam(tx, slug);
      return json({ ok: true });
    }),
  });
}
