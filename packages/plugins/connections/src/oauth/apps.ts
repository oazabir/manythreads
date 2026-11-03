import type { PluginTx } from '@manythreads/sdk';
import type { OAuthAppStatus, PersonProviderId } from '@manythreads/shared';
import type { SecretDeps } from '../secrets.ts';
import { instanceLabel, oauthApp, PROVIDERS, providerIds, redirectUriFor, type Env } from './providers.ts';

// The OAuth app a workspace signs its people in to a provider with (PLAN P16-02). An admin enters the app's client id and secret on the admin page; the id is kept in
// the clear (every consent address carries it), the secret is sealed by the platform's secret service and only ever read back here, to make one call to the provider.
// No route returns the secret, a part of it or a hash of it: `OAuthAppStatus` only says whether one is stored.
//
// Which app a call uses: the one the workspace's admin entered, and when there is none, the one in the server's environment (a single-workspace install that set
// MANYTHREADS_OAUTH_<PROVIDER>_CLIENT_ID and _CLIENT_SECRET). Every function takes a system transaction in the one workspace.

/** The app to use for a call: its credentials, where it came from, and the Microsoft directory an admin chose (null = the server's default). */
export interface ResolvedApp {
  clientId: string;
  clientSecret: string;
  tenant: string | null;
  source: 'workspace' | 'server';
}

export type AppDeps = SecretDeps & { env: Env };

/** The app for a provider in this workspace, inside a system transaction the caller holds. Null when neither an admin nor the environment gave one. */
export async function resolveAppIn(deps: Pick<AppDeps, 'secrets' | 'env'>, tx: PluginTx, workspaceId: string, provider: PersonProviderId): Promise<ResolvedApp | null> {
  const row = (
    await tx.query<{ client_id: string; tenant: string | null; secret_id: string | null }>(
      `SELECT a.client_id, a.tenant, s.secret_id
         FROM app.connection_oauth_apps a LEFT JOIN app.connection_oauth_app_secrets s ON s.workspace_id = a.workspace_id AND s.provider = a.provider
        WHERE a.workspace_id = $1 AND a.provider = $2`,
      [workspaceId, provider],
    )
  ).rows[0];
  if (row?.secret_id) {
    const clientSecret = await deps.secrets.get(tx, row.secret_id);
    if (clientSecret !== null && clientSecret !== '') return { clientId: row.client_id, clientSecret, tenant: row.tenant, source: 'workspace' };
  }
  const fromEnv = oauthApp(provider, deps.env);
  return fromEnv ? { ...fromEnv, tenant: null, source: 'server' } : null;
}

/**
 * The subdomain an admin entered with the workspace's app for Zendesk or Salesforce, or null (none entered, or not a valid label: it is checked again here, so a row
 * written some other way can never become part of an address). Reads only that column, never the sealed secret.
 */
export const appInstance = (deps: Pick<AppDeps, 'db'>, workspaceId: string, provider: PersonProviderId): Promise<string | null> =>
  PROVIDERS[provider].instance === null
    ? Promise.resolve(null)
    : deps.db.system(
        async (tx) => instanceLabel((await tx.query<{ tenant: string | null }>('SELECT tenant FROM app.connection_oauth_apps WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider])).rows[0]?.tenant),
        { workspaceId },
      );

/** The same, in its own system transaction (the routes' transactions are the person's, which cannot read the sealed secret). */
export const resolveApp = (deps: AppDeps, workspaceId: string, provider: PersonProviderId): Promise<ResolvedApp | null> =>
  deps.db.system((tx) => resolveAppIn(deps, tx, workspaceId, provider), { workspaceId });

/** Which providers can be signed in to right now, without opening a secret: an admin's app with its secret stored, or the environment's. */
export async function configuredProviders(deps: Pick<AppDeps, 'db' | 'env'>, workspaceId: string): Promise<Set<PersonProviderId>> {
  const stored = await deps.db.system(
    async (tx) =>
      (
        await tx.query<{ provider: string }>(
          `SELECT a.provider FROM app.connection_oauth_apps a JOIN app.connection_oauth_app_secrets s ON s.workspace_id = a.workspace_id AND s.provider = a.provider WHERE a.workspace_id = $1`,
          [workspaceId],
        )
      ).rows.map((r) => r.provider),
    { workspaceId },
  );
  return new Set(providerIds().filter((id) => stored.includes(id) || oauthApp(id, deps.env) !== null));
}

/** What the admin page shows for every provider. Never the secret. */
export async function listApps(deps: Pick<AppDeps, 'db' | 'env'>, input: { workspaceId: string; publicUrl: string }): Promise<OAuthAppStatus[]> {
  const rows = await deps.db.system(
    async (tx) =>
      (
        await tx.query<{ provider: string; client_id: string; tenant: string | null; updated_at: Date; has_secret: boolean }>(
          `SELECT a.provider, a.client_id, a.tenant, a.updated_at, (s.secret_id IS NOT NULL) AS has_secret
             FROM app.connection_oauth_apps a LEFT JOIN app.connection_oauth_app_secrets s ON s.workspace_id = a.workspace_id AND s.provider = a.provider
            WHERE a.workspace_id = $1`,
          [input.workspaceId],
        )
      ).rows,
    { workspaceId: input.workspaceId },
  );
  return providerIds().map((id) => statusOf(id, rows.find((r) => r.provider === id), oauthApp(id, deps.env) !== null, input.publicUrl));
}

function statusOf(
  id: PersonProviderId,
  row: { client_id: string; tenant: string | null; updated_at: Date; has_secret: boolean } | undefined,
  inEnvironment: boolean,
  publicUrl: string,
): OAuthAppStatus {
  const tenantKind = id === 'microsoft' ? ('directory' as const) : PROVIDERS[id].instance ? ('subdomain' as const) : null;
  const base = { provider: id, label: PROVIDERS[id].label, redirectUri: redirectUriFor(publicUrl, id), supportsTenant: tenantKind !== null, tenantKind };
  if (row?.has_secret) return { ...base, source: 'workspace', clientId: row.client_id, tenant: row.tenant, hasSecret: true, updatedAt: row.updated_at.toISOString() };
  if (inEnvironment) return { ...base, source: 'server', clientId: null, tenant: null, hasSecret: true, updatedAt: null };
  return { ...base, source: null, clientId: null, tenant: null, hasSecret: false, updatedAt: null };
}

/**
 * Stores (or replaces) the workspace's app for a provider. The secret is sealed first and the old sealed value is deleted when it is replaced, all in one transaction, so
 * a failure leaves the old app as it was. Returns the status to show.
 */
export async function putWorkspaceApp(
  deps: AppDeps,
  input: { workspaceId: string; actorId: string; provider: PersonProviderId; clientId: string; clientSecret: string; tenant: string | null; publicUrl: string },
): Promise<OAuthAppStatus> {
  return deps.db.system(
    async (tx) => {
      const saved = (
        await tx.query<{ updated_at: Date }>(
          `INSERT INTO app.connection_oauth_apps (workspace_id, provider, client_id, tenant, updated_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, provider) DO UPDATE SET client_id = EXCLUDED.client_id, tenant = EXCLUDED.tenant, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING updated_at`,
          [input.workspaceId, input.provider, input.clientId, input.tenant, input.actorId],
        )
      ).rows[0]!;
      const old = (await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.connection_oauth_app_secrets WHERE workspace_id = $1 AND provider = $2', [input.workspaceId, input.provider])).rows[0];
      const secretId = await deps.secrets.put(tx, input.clientSecret);
      if (old) {
        await tx.query('UPDATE app.connection_oauth_app_secrets SET secret_id = $3 WHERE workspace_id = $1 AND provider = $2', [input.workspaceId, input.provider, secretId]);
        await deps.secrets.delete(tx, old.secret_id);
      } else {
        await tx.query('INSERT INTO app.connection_oauth_app_secrets (workspace_id, provider, secret_id) VALUES ($1, $2, $3)', [input.workspaceId, input.provider, secretId]);
      }
      return statusOf(input.provider, { client_id: input.clientId, tenant: input.tenant, updated_at: saved.updated_at, has_secret: true }, false, input.publicUrl);
    },
    { workspaceId: input.workspaceId },
  );
}

/** Removes the workspace's app for a provider; its sealed secret goes with it (a trigger reaps it). True when there was one. */
export async function clearWorkspaceApp(deps: Pick<AppDeps, 'db'>, input: { workspaceId: string; provider: PersonProviderId }): Promise<boolean> {
  return deps.db.system(
    async (tx) => (await tx.query('DELETE FROM app.connection_oauth_apps WHERE workspace_id = $1 AND provider = $2 RETURNING provider', [input.workspaceId, input.provider])).rows.length > 0,
    { workspaceId: input.workspaceId },
  );
}
