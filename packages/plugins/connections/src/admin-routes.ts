import { forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AdminConnectionParams,
  AdminDisconnectConnectionResponse,
  ConnectionsConnectionChangedEvent,
  ListConnectionPeopleResponse,
  ListConnectorHealthResponse,
  OffboardConnectionsRequest,
  OffboardConnectionsResponse,
  OffboardPathParams,
  OffboardPreviewResponse,
  abuseLimit,
  adminDisconnectConnectionRoute,
  connectionsHealthRoute,
  listConnectionPeopleRoute,
  offboardConnectionsRoute,
  offboardPreviewRoute,
  type ConnectionPersonRow,
  type ConnectorHealthRow,
} from '@manythreads/shared';
import { previewOffboarding, revokeAndDelete, startOffboarding } from './offboard.ts';
import { providerDef, servicesGranted } from './oauth/providers.ts';
import type { OAuthDeps } from './oauth/store.ts';
import { readUsage } from './usage.ts';

// The admin's view of connected apps (PLAN Bundle D, P16-11, decisions D31 to D33): health and usage per provider, who connected what, removing one person's grant, and the
// offboarding preview and button. Workspace owners and admins only: a team lead gets 403. Content-blind: counts, states and service names; never a token, an account address or
// what a call read. docs/plugins/connections.md "Admin".
//
//   GET    /api/admin/connections/health                           one row per provider (or kind) with people, team connections, sign-ins to redo, calls and failures in 7 days
//   GET    /api/admin/connections/people                           one row per person sign-in: provider, services, state, last used. No account address
//   DELETE /api/admin/connections/people/:connectionId             forget one person's sign-in (the provider is asked, the sealed tokens are deleted)
//   GET    /api/admin/people/:personId/offboard-connections        what removing a leaving person's connections will do
//   POST   /api/admin/people/:personId/offboard-connections        do it (202; a job finishes the work)

async function requireAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can see how connected apps are used.');
}

/** The sentence for the worst thing wrong with a provider, or null. */
export function healthProblem(row: { needsReconnect: number; calls7d: number; failures7d: number }): string | null {
  if (row.needsReconnect > 0) return `${String(row.needsReconnect)} ${row.needsReconnect === 1 ? 'person has' : 'people have'} to sign in again.`;
  if (row.calls7d >= 5 && row.failures7d * 2 > row.calls7d) return 'More than half of this week’s calls did not work.';
  return null;
}

/** The health rows of the connections plugin: system role, because the usage table gives the application role nothing. */
export async function connectionHealthRows(tx: PluginTx, workspaceId: string): Promise<ConnectorHealthRow[]> {
  const grants = (
    await tx.query<{ connector: string; people: number; shared: number; needs: number }>(
      `SELECT coalesce(o.provider, c.kind) AS connector,
              count(*) FILTER (WHERE c.scope = 'person')::int AS people,
              count(*) FILTER (WHERE c.scope <> 'person')::int AS shared,
              count(*) FILTER (WHERE o.state = 'needs_reconnect')::int AS needs
         FROM app.connections c LEFT JOIN app.connection_oauth o ON o.connection_id = c.id
        WHERE c.workspace_id = $1 GROUP BY 1`,
      [workspaceId],
    )
  ).rows;
  const usage = await readUsage(tx, workspaceId);
  const names = new Set([...grants.map((g) => g.connector), ...usage.keys()]);
  const rows = [...names].map((connector): ConnectorHealthRow => {
    const g = grants.find((x) => x.connector === connector);
    const u = usage.get(connector);
    const row = { needsReconnect: g?.needs ?? 0, calls7d: u?.calls ?? 0, failures7d: u?.failures ?? 0 };
    return {
      connector,
      area: 'connections',
      people: g?.people ?? 0,
      shared: g?.shared ?? 0,
      needsReconnect: row.needsReconnect,
      calls7d: row.calls7d,
      failures7d: row.failures7d,
      refused7d: {},
      lastUsedAt: u?.lastDay ? u.lastDay.toISOString() : null,
      problem: healthProblem(row),
    };
  });
  return rows.sort((a, b) => b.people + b.shared - (a.people + a.shared) || a.connector.localeCompare(b.connector)).slice(0, 100);
}

type PeopleRow = {
  connection_id: string;
  person_id: string;
  display_name: string;
  provider: string;
  status: 'enabled' | 'disabled';
  state: 'ok' | 'needs_reconnect';
  scopes: string[];
  connected_at: Date;
  refreshed_at: Date | null;
  last_used_on: string | null;
};

export function toPersonRow(r: PeopleRow): ConnectionPersonRow {
  const def = providerDef(r.provider);
  return {
    connectionId: r.connection_id,
    personId: r.person_id,
    personName: r.display_name.slice(0, 120),
    connector: r.provider,
    state: r.state === 'needs_reconnect' ? 'needs_reconnect' : r.status === 'disabled' ? 'disabled' : 'ok',
    services: def ? servicesGranted(def, r.scopes) : [],
    connectedAt: r.connected_at.toISOString(),
    refreshedAt: r.refreshed_at ? r.refreshed_at.toISOString() : null,
    lastUsedOn: r.last_used_on,
  } as ConnectionPersonRow;
}

export function registerAdminRoutes(ctx: PluginContext, deps: OAuthDeps): void {
  /** The person id of the actor making the request, read as the system (the request's own transaction need not see the row). */
  const personOf = async (sys: PluginTx, actorId: string, workspaceId: string): Promise<string | null> =>
    (await sys.query<{ ref_id: string }>(`SELECT ref_id FROM app.actors WHERE id = $1 AND workspace_id = $2 AND kind = 'person'`, [actorId, workspaceId])).rows[0]?.ref_id ?? null;

  ctx.http.route({
    ...connectionsHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireAdmin(tx);
      const rows = await deps.db.system((sys) => connectionHealthRows(sys, tx.actor.workspaceId), { workspaceId: tx.actor.workspaceId });
      return json({ rows });
    }),
  });

  ctx.http.route({
    ...listConnectionPeopleRoute,
    schema: { response: ListConnectionPeopleResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireAdmin(tx);
      // the function checks the role again and never returns an account address or a token
      const rows = (
        await tx.query<PeopleRow>(
          `SELECT connection_id, person_id, display_name, provider, status, state, scopes, connected_at, refreshed_at, to_char(last_used_on, 'YYYY-MM-DD') AS last_used_on
             FROM app.connections_admin_people()`,
        )
      ).rows;
      return json({ people: rows.map(toPersonRow) });
    }),
  });

  ctx.http.route({
    ...adminDisconnectConnectionRoute,
    schema: { response: AdminDisconnectConnectionResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { connectionId } = AdminConnectionParams.parse(req.params);
      const workspaceId = tx.actor.workspaceId;
      const target = await deps.db.system(
        async (sys) =>
          (
            await sys.query<{ id: string; provider: string }>(
              `SELECT c.id, o.provider FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id
                WHERE c.id = $1 AND c.workspace_id = $2 AND c.scope = 'person'`,
              [connectionId, workspaceId],
            )
          ).rows[0],
        { workspaceId },
      );
      if (!target) throw notFound('No such sign-in');
      const result = await revokeAndDelete(deps, { workspaceId, connectionIds: [target.id], ownerActorId: null }, async (sys, r) => {
        if (r.removed === 0) return;
        await ctx.audit.emit(
          sys,
          ConnectionsConnectionChangedEvent.parse({
            type: 'connections.connection.changed',
            schemaVersion: 1,
            workspaceId,
            teamId: null,
            connectionId: target.id,
            slug: target.provider,
            kind: target.provider,
            scope: 'person',
            change: 'deleted',
            actorId: tx.actor.id,
            at: ctx.runtime.now().toISOString(),
          }),
        );
      });
      if (result.removed === 0) throw notFound('No such sign-in');
      return json({ removed: true, providerRevoked: result.providerRevoked > 0 });
    }),
  });

  ctx.http.route({
    ...offboardPreviewRoute,
    schema: { response: OffboardPreviewResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { personId } = OffboardPathParams.parse(req.params);
      const workspaceId = tx.actor.workspaceId;
      const preview = await deps.db.system(async (sys) => previewOffboarding(sys, { workspaceId, personId, fallbackPersonId: await personOf(sys, tx.actor.id, workspaceId) }), { workspaceId });
      if (!preview) throw notFound('No such person');
      return json({ preview });
    }),
  });

  ctx.http.route({
    ...offboardConnectionsRoute,
    schema: { body: OffboardConnectionsRequest, response: OffboardConnectionsResponse },
    rateLimit: abuseLimit('POST', offboardConnectionsRoute.path),
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { personId } = OffboardPathParams.parse(req.params);
      OffboardConnectionsRequest.parse(req.body ?? {});
      const workspaceId = tx.actor.workspaceId;
      // the person must be one this admin can see (a non-owner admin does not see an owner's row, as on the Members page)
      const seen = (await tx.query('SELECT 1 FROM app.workspace_members WHERE workspace_id = app.workspace_id() AND person_id = $1', [personId])).rows.length > 0;
      if (!seen) throw notFound('No such person');
      const started = await deps.db.system(
        async (sys) => {
          const me = await personOf(sys, tx.actor.id, workspaceId);
          if (me === personId) throw invalid('You cannot remove your own connections here. Disconnect them from your own connections page.');
          return startOffboarding(ctx, sys, { workspaceId, personId, fallbackPersonId: me, actorId: tx.actor.id });
        },
        { workspaceId },
      );
      return json({ result: { queued: true, disabled: started.disabled, moved: started.moved } }, 202);
    }),
  });
}
