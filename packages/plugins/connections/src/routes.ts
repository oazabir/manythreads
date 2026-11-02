import { json, requireTeam, route, type PluginContext } from '@manythreads/sdk';
import { ConnectionsTeamParams, ListConnectionsResponse, listConnectionsRoute } from '@manythreads/shared';
import { CONNECTION_COLUMNS, toConnection, type ConnectionRow } from './rows.ts';

// The routes of a team's connections (PLAN P8-28). One read: the connections of a team, as the caller's row-level security lets them see them. The answer is the strict
// `Connection` shape, which has no field for a credential; there is no route that takes one in or gives one back. Creating and changing connections arrive with the
// screens that need them (P8-03, P8-06).

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listConnectionsRoute,
    schema: { response: ListConnectionsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = ConnectionsTeamParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const rows = await tx.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM app.connections c WHERE c.scope = 'team' AND c.team_id = $1 ORDER BY lower(c.name), c.id`,
        [team.id],
      );
      return json({ connections: rows.rows.map(toConnection) });
    }),
  });
}
