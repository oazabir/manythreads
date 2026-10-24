import { json, notFound, requireManage, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  MintRunnerTokenResponse,
  RevokeRunnerTokensResponse,
  mintRunnerTokenRoute,
  revokeRunnerTokensRoute,
  runnerConnectRoute,
} from '@manythreads/shared';
import { ConnectionRegistry, serveRunnerSocket } from './connections.ts';
import { mintRunnerToken, revokeRunnerTokens } from './tokens.ts';

/** The runner of this team with this id, or 404 (another team's runner answers like an unknown one). */
async function requireRunner(tx: PluginTx, teamId: string, runnerId: string): Promise<void> {
  const found = await tx.query('SELECT 1 FROM app.runners WHERE id = $1::uuid AND team_id = $2::uuid', [runnerId, teamId]);
  if (found.rows.length === 0) throw notFound('No such runner');
}

export function registerRunnerRoutes(ctx: PluginContext, registry: ConnectionRegistry): void {
  ctx.http.route({
    method: mintRunnerTokenRoute.method,
    path: mintRunnerTokenRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: MintRunnerTokenResponse },
    handler: route(async (req, tx) => {
      const { slug, runnerId } = req.params as { slug: string; runnerId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      await requireRunner(tx, team.id, runnerId);
      const minted = await mintRunnerToken(tx, runnerId);
      await ctx.audit.emit(tx, { type: 'runners.token.minted', workspaceId: team.workspace_id, teamId: team.id, runnerId, actorId: tx.actor.id, at: ctx.runtime.now().toISOString() });
      return json(MintRunnerTokenResponse.parse({ runnerId, token: minted.token, createdAt: minted.createdAt.toISOString() }), 201);
    }),
  });

  ctx.http.route({
    method: revokeRunnerTokensRoute.method,
    path: revokeRunnerTokensRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: RevokeRunnerTokensResponse },
    handler: route(async (req, tx) => {
      const { slug, runnerId } = req.params as { slug: string; runnerId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      await requireRunner(tx, team.id, runnerId);
      const revoked = await revokeRunnerTokens(tx, runnerId);
      await ctx.audit.emit(tx, { type: 'runners.token.revoked', workspaceId: team.workspace_id, teamId: team.id, runnerId, actorId: tx.actor.id, revoked, at: ctx.runtime.now().toISOString() });
      // A connection open on this replica ends now; one on another replica ends at its next heartbeat (the token is checked every beat).
      for (const conn of registry.byId(runnerId)) conn.close(1008, 'token revoked', 'revoked');
      return json(RevokeRunnerTokensResponse.parse({ revoked }));
    }),
  });

  // The runner's one outbound connection. `public`: the bearer runner token is the credential, checked by the handler (a socket has no
  // session). A missing or revoked token closes the socket at once with 1008.
  ctx.http.route({
    method: runnerConnectRoute.method,
    path: runnerConnectRoute.path,
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    ws: (socket, request) => serveRunnerSocket(ctx, registry, socket, request),
  });
}
