import { forbidden, invalid, json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  abuseLimit,
  ClearOAuthAppResponse,
  clearOAuthAppRoute,
  ConnectionsOauthAppChangedEvent,
  ListOAuthAppsResponse,
  listOAuthAppsRoute,
  OAuthAppParams,
  PutOAuthAppRequest,
  PutOAuthAppResponse,
  putOAuthAppRoute,
  type PersonProviderId,
} from '@manythreads/shared';
import { clearWorkspaceApp, listApps, putWorkspaceApp } from './oauth/apps.ts';
import type { OAuthDeps } from './oauth/store.ts';

// The admin's side of signing people in (PLAN P16-02): the OAuth app (client id and secret) the workspace uses for Google, Microsoft and Notion.
//
//   GET    /api/admin/connections/oauth-apps              every provider: where its app comes from, its client id, whether a secret is stored (never the secret)
//   PUT    /api/admin/connections/oauth-apps/:provider    { clientId, clientSecret, tenant? }: seal the secret, keep the id; replaces what was there
//   DELETE /api/admin/connections/oauth-apps/:provider    forget the workspace's app (the server's environment, if it has one, applies again)
//
// Owners and admins only. The secret is sealed by the platform on the way in and no answer, event, audit row or error carries it; the audit row says only that the app
// of a provider was set or cleared, and by whom.

async function requireAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can set up the apps people sign in with.');
}

export function registerOAuthAppRoutes(ctx: PluginContext, deps: OAuthDeps): void {
  const publicUrl = ctx.runtime.publicUrl;
  const changed = (tx: PluginTx, provider: PersonProviderId, change: 'set' | 'cleared'): Promise<void> =>
    ctx.audit.emit(
      tx,
      ConnectionsOauthAppChangedEvent.parse({
        type: 'connections.oauth_app.changed',
        schemaVersion: 1,
        workspaceId: tx.actor.workspaceId,
        provider,
        change,
        actorId: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      }),
    );

  ctx.http.route({
    ...listOAuthAppsRoute,
    schema: { response: ListOAuthAppsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireAdmin(tx);
      return json({ apps: await listApps(deps, { workspaceId: tx.actor.workspaceId, publicUrl }) });
    }),
  });

  ctx.http.route({
    ...putOAuthAppRoute,
    schema: { body: PutOAuthAppRequest, response: PutOAuthAppResponse },
    rateLimit: abuseLimit(putOAuthAppRoute.method, putOAuthAppRoute.path),
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { provider } = OAuthAppParams.parse(req.params);
      const body = PutOAuthAppRequest.parse(req.body);
      if (body.tenant && provider !== 'microsoft') throw invalid('Only Microsoft has a directory setting.');
      const app = await putWorkspaceApp(deps, {
        workspaceId: tx.actor.workspaceId,
        actorId: tx.actor.id,
        provider,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        tenant: body.tenant || null,
        publicUrl,
      });
      await changed(tx, provider, 'set');
      return json({ app });
    }),
  });

  ctx.http.route({
    ...clearOAuthAppRoute,
    schema: { response: ClearOAuthAppResponse },
    rateLimit: abuseLimit(clearOAuthAppRoute.method, clearOAuthAppRoute.path),
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { provider } = OAuthAppParams.parse(req.params);
      const cleared = await clearWorkspaceApp(deps, { workspaceId: tx.actor.workspaceId, provider });
      if (cleared) await changed(tx, provider, 'cleared');
      return json({ cleared });
    }),
  });
}
