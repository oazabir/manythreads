import { z } from 'zod';
import { Connection } from '../../entities/connection.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// The routes of a team's connections (PLAN P8-01, P8-28). Everyone who can read the team lists them; the answer never carries a credential, and no route
// takes one back out. Creating and changing connections arrives with the screens that need it (P8-03, P8-06). docs/plugins/connections.md.

export const ConnectionsTeamParams = z.object({ slug: TeamSlug });
export type ConnectionsTeamParams = z.infer<typeof ConnectionsTeamParams>;

export const ListConnectionsResponse = z.strictObject({
  connections: z.array(Connection),
});
export type ListConnectionsResponse = z.infer<typeof ListConnectionsResponse>;
export const listConnectionsRoute = { method: 'GET', path: '/api/teams/:slug/connections' } as const satisfies ApiRoute;
