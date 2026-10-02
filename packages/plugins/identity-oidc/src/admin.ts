import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AuthProviderId,
  CreateOidcProviderRequest,
  DeleteOidcProviderResponse,
  ListOidcProvidersResponse,
  OidcProviderResponse,
  TestOidcProviderResponse,
  UpdateOidcProviderRequest,
  createOidcProviderRoute,
  deleteOidcProviderRoute,
  disableOidcProviderRoute,
  enableOidcProviderRoute,
  listOidcProvidersRoute,
  testOidcProviderRoute,
  updateOidcProviderRoute,
  type OidcProvider,
  type OidcProviderKind,
  type OidcTestResult,
} from '@manythreads/shared';
import { z } from 'zod';
import { DiscoveryError, discoverIssuer } from './protocol.ts';
import {
  OIDC_KINDS,
  PROVIDER_COLUMNS,
  issuerFor,
  readConfig,
  toOidcProvider,
  type ProviderRow,
  type StoredConfig,
} from './provider.ts';

const ProviderParams = z.object({ providerId: AuthProviderId });

/** Discovery now: ok with a message, or the reason it failed (shown to the admin, never containing the secret). */
async function runDiscovery(kind: OidcProviderKind, config: StoredConfig, now: Date): Promise<OidcTestResult> {
  const issuer = issuerFor(kind, config);
  try {
    const metadata = await discoverIssuer(issuer, config.clientId, { fresh: true });
    return { ok: true, message: `Discovery succeeded at ${metadata.issuer}.`, checkedAt: now.toISOString() };
  } catch (err) {
    const message = err instanceof DiscoveryError ? err.message : `Discovery failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, message: message.slice(0, 500), checkedAt: now.toISOString() };
  }
}

/** Provider admin API: workspace owners and admins only. */
export function registerAdmin(ctx: PluginContext): void {
  const publicUrl = ctx.runtime.publicUrl;
  const present = (row: ProviderRow): OidcProvider => toOidcProvider(row, publicUrl);

  async function requireAdmin(tx: PluginTx): Promise<{ personId: string | null }> {
    const res = await tx.query<{ role: string | null; person_id: string | null }>(
      'SELECT app.workspace_role() AS role, app.person_id() AS person_id',
    );
    const role = res.rows[0]?.role;
    if (role !== 'owner' && role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only workspace admins can manage sign-in methods.');
    }
    return { personId: res.rows[0]?.person_id ?? null };
  }

  async function loadRow(tx: PluginTx, providerId: string): Promise<ProviderRow> {
    const res = await tx.query<ProviderRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM app.auth_providers WHERE id = $1 AND workspace_id = $2 AND kind = ANY($3::text[])`,
      [providerId, tx.actor.workspaceId, [...OIDC_KINDS]],
    );
    const row = res.rows[0];
    if (!row) throw new HttpError(404, 'not_found', 'No such sign-in provider.');
    return row;
  }

  const audit = (
    tx: PluginTx,
    row: ProviderRow,
    personId: string | null,
    change: 'created' | 'updated' | 'enabled' | 'disabled' | 'deleted' | 'tested',
  ): Promise<void> =>
    ctx.events.emit(tx, {
      type: 'identity.provider.changed',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      providerId: row.id,
      kind: row.kind,
      change,
      enabled: row.enabled,
      personId,
    });

  /**
   * Stores the discovery result: `lastTest` always; `enabled` and `disabled_reason` follow `wantEnabled`. A failure
   * leaves the provider disabled with the reason; a success enables it only when asked to.
   */
  async function settle(tx: PluginTx, row: ProviderRow, result: OidcTestResult, wantEnabled: boolean): Promise<ProviderRow> {
    const enabled = wantEnabled && result.ok;
    const reason = result.ok ? null : result.message;
    const res = await tx.query<ProviderRow>(
      `UPDATE app.auth_providers
          SET enabled = $2, disabled_reason = $3, config = config || jsonb_build_object('lastTest', $4::jsonb), updated_at = now()
        WHERE id = $1 RETURNING ${PROVIDER_COLUMNS}`,
      [row.id, enabled, reason, JSON.stringify(result)],
    );
    return res.rows[0] as ProviderRow;
  }

  ctx.http.route({
    method: listOidcProvidersRoute.method,
    path: listOidcProvidersRoute.path,
    schema: { response: ListOidcProvidersResponse },
    handler: async (_req, tx) => {
      await requireAdmin(tx);
      const res = await tx.query<ProviderRow>(
        `SELECT ${PROVIDER_COLUMNS} FROM app.auth_providers WHERE workspace_id = $1 AND kind = ANY($2::text[]) ORDER BY created_at, id`,
        [tx.actor.workspaceId, [...OIDC_KINDS]],
      );
      return { body: { providers: res.rows.map(present) } };
    },
  });

  ctx.http.route({
    method: createOidcProviderRoute.method,
    path: createOidcProviderRoute.path,
    schema: { body: CreateOidcProviderRequest, response: OidcProviderResponse },
    handler: async (req, tx) => {
      const { personId } = await requireAdmin(tx);
      const body = CreateOidcProviderRequest.parse(req.body);
      const config: StoredConfig = {
        name: body.label ?? '',
        clientId: body.clientId,
        ...(body.kind === 'microsoft' ? { tenantId: body.tenantId } : {}),
        ...(body.kind === 'oidc' ? { issuer: body.issuer } : {}),
      };
      const secretId = await ctx.secrets.put(tx, body.clientSecret);
      const created = await tx.query<ProviderRow>(
        `INSERT INTO app.auth_providers (workspace_id, kind, config, secret_id, enabled, allowed_domains)
         VALUES ($1, $2, $3::jsonb, $4, false, $5) RETURNING ${PROVIDER_COLUMNS}`,
        [tx.actor.workspaceId, body.kind, JSON.stringify(config), secretId, body.allowedDomains],
      );
      const result = await runDiscovery(body.kind, config, ctx.runtime.now());
      const row = await settle(tx, created.rows[0] as ProviderRow, result, body.enabled);
      await audit(tx, row, personId, 'created');
      return { status: 200, body: { provider: present(row) } };
    },
  });

  ctx.http.route({
    method: updateOidcProviderRoute.method,
    path: updateOidcProviderRoute.path,
    schema: { body: UpdateOidcProviderRequest, response: OidcProviderResponse },
    handler: async (req, tx) => {
      const { personId } = await requireAdmin(tx);
      const { providerId } = ProviderParams.parse(req.params);
      const body = UpdateOidcProviderRequest.parse(req.body);
      const before = await loadRow(tx, providerId);
      const kind = before.kind as OidcProviderKind;
      if (body.tenantId !== undefined && kind !== 'microsoft') {
        throw new HttpError(400, 'validation_failed', 'Only a Microsoft provider has a tenant id.');
      }
      if (body.issuer !== undefined && kind !== 'oidc') {
        throw new HttpError(400, 'validation_failed', 'Only an OpenID Connect provider has an issuer URL.');
      }
      if (kind === 'google' && body.allowedDomains !== undefined && body.allowedDomains.length === 0) {
        throw new HttpError(400, 'validation_failed', 'Google sign-in needs at least one allowed domain.');
      }
      const old = readConfig(before.config);
      const config: StoredConfig = {
        ...old,
        ...(body.label !== undefined ? { name: body.label } : {}),
        ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
        ...(body.tenantId !== undefined ? { tenantId: body.tenantId } : {}),
        ...(body.issuer !== undefined ? { issuer: body.issuer } : {}),
      };
      let secretId = before.secret_id;
      if (body.clientSecret !== undefined) secretId = await ctx.secrets.put(tx, body.clientSecret);
      const updated = await tx.query<ProviderRow>(
        `UPDATE app.auth_providers SET config = $2::jsonb, secret_id = $3, allowed_domains = $4, updated_at = now()
          WHERE id = $1 RETURNING ${PROVIDER_COLUMNS}`,
        [providerId, JSON.stringify(config), secretId, body.allowedDomains ?? before.allowed_domains],
      );
      if (body.clientSecret !== undefined && before.secret_id) await ctx.secrets.delete(tx, before.secret_id);

      // Re-run discovery whenever the endpoint changed. A provider that an earlier failure switched off comes back on
      // once the fix passes; one the admin switched off by hand stays off.
      const endpointChanged = body.issuer !== undefined || body.tenantId !== undefined || body.clientId !== undefined;
      let row = updated.rows[0] as ProviderRow;
      if (endpointChanged) {
        const result = await runDiscovery(kind, config, ctx.runtime.now());
        const autoDisabled = !before.enabled && before.disabled_reason !== null;
        row = await settle(tx, row, result, before.enabled || autoDisabled);
      }
      await audit(tx, row, personId, 'updated');
      return { body: { provider: present(row) } };
    },
  });

  ctx.http.route({
    method: testOidcProviderRoute.method,
    path: testOidcProviderRoute.path,
    schema: { response: TestOidcProviderResponse },
    handler: async (req, tx) => {
      const { personId } = await requireAdmin(tx);
      const { providerId } = ProviderParams.parse(req.params);
      const before = await loadRow(tx, providerId);
      const result = await runDiscovery(before.kind as OidcProviderKind, readConfig(before.config), ctx.runtime.now());
      // A failing test switches an enabled provider off (with the reason); a passing one changes nothing else.
      const row = await settle(tx, before, result, before.enabled);
      await audit(tx, row, personId, 'tested');
      return { body: { result, provider: present(row) } };
    },
  });

  ctx.http.route({
    method: enableOidcProviderRoute.method,
    path: enableOidcProviderRoute.path,
    schema: { response: OidcProviderResponse },
    handler: async (req, tx) => {
      const { personId } = await requireAdmin(tx);
      const { providerId } = ProviderParams.parse(req.params);
      const before = await loadRow(tx, providerId);
      if (!before.secret_id) throw new HttpError(409, 'conflict', 'Add the client secret before enabling this provider.');
      const result = await runDiscovery(before.kind as OidcProviderKind, readConfig(before.config), ctx.runtime.now());
      const row = await settle(tx, before, result, true);
      await audit(tx, row, personId, 'enabled');
      return { body: { provider: present(row) } };
    },
  });

  ctx.http.route({
    method: disableOidcProviderRoute.method,
    path: disableOidcProviderRoute.path,
    schema: { response: OidcProviderResponse },
    handler: async (req, tx) => {
      const { personId } = await requireAdmin(tx);
      const { providerId } = ProviderParams.parse(req.params);
      await loadRow(tx, providerId);
      const res = await tx.query<ProviderRow>(
        `UPDATE app.auth_providers SET enabled = false, disabled_reason = NULL, updated_at = now() WHERE id = $1 RETURNING ${PROVIDER_COLUMNS}`,
        [providerId],
      );
      const row = res.rows[0] as ProviderRow;
      await audit(tx, row, personId, 'disabled');
      return { body: { provider: present(row) } };
    },
  });

  ctx.http.route({
    method: deleteOidcProviderRoute.method,
    path: deleteOidcProviderRoute.path,
    schema: { response: DeleteOidcProviderResponse },
    handler: async (req, tx) => {
      const { personId } = await requireAdmin(tx);
      const { providerId } = ProviderParams.parse(req.params);
      const before = await loadRow(tx, providerId);
      await tx.query('DELETE FROM app.auth_providers WHERE id = $1', [providerId]);
      if (before.secret_id) await ctx.secrets.delete(tx, before.secret_id);
      await audit(tx, { ...before, enabled: false }, personId, 'deleted');
      return { body: { ok: true as const } };
    },
  });
}
