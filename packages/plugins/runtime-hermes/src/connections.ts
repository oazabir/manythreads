import {
  conflict,
  forbidden,
  invalid,
  json,
  notFound,
  requireManage,
  requireTeam,
  route,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  CreateHermesConnectionRequest,
  CreateHermesConnectionResponse,
  DeleteHermesConnectionResponse,
  HermesConnection,
  type HermesConnectionAgent,
  ListHermesConnectionsResponse,
  ReenableHermesProfileResponse,
  reenableHermesProfileRoute,
  TestHermesConnectionRequest,
  TestHermesConnectionResponse,
  UpdateHermesConnectionRequest,
  UpdateHermesConnectionResponse,
  createHermesConnectionRoute,
  deleteHermesConnectionRoute,
  listHermesConnectionsRoute,
  testHermesConnectionRoute,
  updateHermesConnectionRoute,
} from '@manythreads/shared';
import type { GatewayTarget } from './gateway.ts';
import { assertAllowedUrl, guardedFetch, OutboundBlockedError } from './outbound.ts';
import { ensureProfileSecrets, readProfileApiKey, reenableProfileSecrets } from './profile-secrets.ts';

// Hermes connections: the gateways a team's bots are placed on (`placement.gateway.connection`). A lead or workspace admin of the team adds an
// `external` one (a Hermes the customer runs), changes its address or key, removes it and tests it. The team's own pod is the reserved connection
// `managed`, registered by the platform through the `hermes.profiles` provider (`profiles.ts`). The API key is encrypted in `app.secrets` and
// is write-only here: nothing in this file returns it.

/** A row as the SQL columns come back; PostgreSQL returns timestamptz as Date. */
export interface ConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  kind: string;
  agent: string;
  base_url: string | null;
  secret_id: string | null;
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The one mapper of `app.hermes_connections`: a row to the shared type. The key is never read here, only whether there is one. */
export function toHermesConnection(r: ConnectionRow): HermesConnection {
  return HermesConnection.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    kind: r.kind,
    agent: r.agent,
    baseUrl: r.base_url,
    hasApiKey: r.secret_id !== null,
    status: r.status,
    lastCheckedAt: iso(r.last_checked_at),
    lastError: r.last_error,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
}

export const CONNECTION_COLUMNS =
  'id, workspace_id, team_id, name, kind, agent, base_url, secret_id, status, last_checked_at, last_error, created_by, created_at, updated_at';

/**
 * The address and key a run of `botId` should use for the team's connection `name`. An external connection has one key for the whole gateway;
 * the managed pod has one key per profile (the bot's `API_SERVER_KEY`). Runs as the system actor: this is the only reader of a key.
 */
export async function resolveTarget(
  ctx: PluginContext,
  query: { teamId: string; botId: string; botSlug: string; connection: string },
): Promise<GatewayTarget | null> {
  return ctx.db.system(async (tx) => {
    const row = (
      await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.hermes_connections WHERE team_id = $1::uuid AND name = $2`, [query.teamId, query.connection])
    ).rows[0];
    if (!row || row.base_url === null) return null;
    if (row.kind === 'managed') {
      // The first run of a managed bot can come before any controller asked for its profile: the key is created here, and stable afterwards.
      const bot = (await tx.query<{ id: string; workspace_id: string; team_id: string }>('SELECT id, workspace_id, team_id FROM app.bots WHERE id = $1::uuid AND team_id = $2::uuid', [query.botId, query.teamId])).rows[0];
      if (!bot) return null;
      const secrets = await ensureProfileSecrets(ctx, bot);
      return 'revoked' in secrets ? null : { baseUrl: row.base_url, apiKey: secrets.apiKey, kind: 'managed', agent: 'hermes' };
    }
    if (row.secret_id === null) return null;
    return { baseUrl: row.base_url, apiKey: await ctx.secrets.get(tx, row.secret_id), guarded: true, kind: 'external', agent: row.agent as HermesConnectionAgent };
  });
}

/**
 * Delete a secret once the request's transaction has committed. The row that referenced it is changed in that very transaction, so a delete from
 * another connection would wait for the row's lock, and the request waits for the delete: it must not be awaited inside the handler.
 */
function dropSecretAfterCommit(ctx: PluginContext, workspaceId: string, secretId: string, attempt = 0): void {
  const timer = setTimeout(() => {
    ctx.db.system((sys) => ctx.secrets.delete(sys, secretId), { workspaceId }).catch(() => {
      if (attempt < 4) dropSecretAfterCommit(ctx, workspaceId, secretId, attempt + 1);
    });
  }, 300 * (attempt + 1));
  timer.unref?.();
}

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Check a gateway. The answer is one of three fixed sentences — it answered, it did not (or not as a Hermes gateway for that profile), or it
 * refused the key — and never anything the remote side said: a lead must not be able to read the body of whatever sits at an address they typed.
 * The gateway's API lists no MCP tools, so `tools` and `manythreadsTools` stay null.
 */
export async function checkGateway(
  target: GatewayTarget,
  profile: string | undefined,
  options: { fetch?: typeof fetch },
): Promise<Pick<TestHermesConnectionResponse, 'ok' | 'error' | 'tools' | 'manythreadsTools'>> {
  const doFetch = options.fetch ?? (target.guarded === true ? guardedFetch : fetch);
  const root = target.baseUrl.replace(/\/+$/, '');
  const prefix = profile === undefined ? '' : `/p/${encodeURIComponent(profile)}`;
  const none = { tools: null, manythreadsTools: null } as const;
  let res: Response;
  try {
    res = await doFetch(`${root}${prefix}/v1/models`, {
      headers: { authorization: `Bearer ${target.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'The gateway did not answer. Check the address and that the gateway\'s API server is running.', ...none };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401 || res.status === 403) return { ok: false, error: "The gateway refused the API key. Use the key in the profile's .env (API_SERVER_KEY).", ...none };
  if (!res.ok) return { ok: false, error: 'The gateway did not answer as a Hermes gateway for that profile.', ...none };
  return { ok: true, error: null, ...none };
}

/** Refuse, when a lead saves an address, one the guard would refuse at use (the guard still runs at every request). */
async function requireAllowedAddress(baseUrl: string): Promise<void> {
  try {
    await assertAllowedUrl(new URL(baseUrl));
  } catch (err) {
    if (err instanceof OutboundBlockedError) throw invalid('That address cannot be used: it is not allowed from this server.');
    throw invalid('That address could not be resolved.');
  }
}

async function requireConnection(tx: PluginTx, teamId: string, connectionId: string): Promise<ConnectionRow> {
  const row = (await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.hermes_connections WHERE id = $1::uuid AND team_id = $2::uuid`, [connectionId, teamId])).rows[0];
  if (!row) throw notFound('No such Hermes connection');
  return row;
}

export interface ConnectionRouteOptions {
  fetch?: typeof fetch;
}

export function registerConnectionRoutes(ctx: PluginContext, options: ConnectionRouteOptions = {}, notify: (teamId: string) => void = () => undefined): void {
  const at = (): string => ctx.runtime.now().toISOString();

  ctx.http.route({
    method: listHermesConnectionsRoute.method,
    path: listHermesConnectionsRoute.path,
    schema: { response: ListHermesConnectionsResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const rows = await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.hermes_connections WHERE team_id = $1::uuid ORDER BY name`, [team.id]);
      return json(ListHermesConnectionsResponse.parse({ items: rows.rows.map(toHermesConnection) }));
    }),
  });

  ctx.http.route({
    method: createHermesConnectionRoute.method,
    path: createHermesConnectionRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { body: CreateHermesConnectionRequest, response: CreateHermesConnectionResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const body = CreateHermesConnectionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      await requireAllowedAddress(body.baseUrl);
      // The key is encrypted by the system actor (only an admin's or the system's transaction may write a secret), in its own transaction; if the
      // row then fails to insert, the secret is removed again so no orphan is left.
      const secretId = await ctx.db.system((sys) => ctx.secrets.put(sys, body.apiKey), { workspaceId: team.workspace_id });
      try {
        const inserted = await tx.query<ConnectionRow>(
          `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, agent, base_url, secret_id, created_by)
           VALUES ($1::uuid, $2::uuid, $3, 'external', $7, $4, $5::uuid, $6::uuid) RETURNING ${CONNECTION_COLUMNS}`,
          [team.workspace_id, team.id, body.name, body.baseUrl, secretId, tx.actor.id, body.agent ?? 'hermes'],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('the connection insert answered no row');
        await ctx.audit.emit(tx, { type: 'hermes.connection.created', workspaceId: team.workspace_id, teamId: team.id, connectionId: row.id, name: row.name, kind: 'external', agent: body.agent ?? 'hermes', actorId: tx.actor.id, at: at() });
        return json(CreateHermesConnectionResponse.parse({ connection: toHermesConnection(row) }), 201);
      } catch (err) {
        dropSecretAfterCommit(ctx, team.workspace_id, secretId);
        throw err;
      }
    }),
  });

  ctx.http.route({
    method: updateHermesConnectionRoute.method,
    path: updateHermesConnectionRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: UpdateHermesConnectionRequest, response: UpdateHermesConnectionResponse },
    handler: route(async (req, tx) => {
      const { slug, connectionId } = req.params as { slug: string; connectionId: string };
      const body = UpdateHermesConnectionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const current = await requireConnection(tx, team.id, connectionId);
      if (current.kind !== 'external') throw conflict("The team's own Hermes pod is managed by the platform; it cannot be edited here.");
      if (body.baseUrl === undefined && body.apiKey === undefined && body.agent === undefined) throw invalid('Nothing to change');
      if (body.baseUrl !== undefined) await requireAllowedAddress(body.baseUrl);
      let newSecret: string | null = null;
      if (body.apiKey !== undefined) newSecret = await ctx.db.system((sys) => ctx.secrets.put(sys, body.apiKey as string), { workspaceId: team.workspace_id });
      try {
        // A changed address or key invalidates the last check: the status goes back to "unknown" until the next test.
        const updated = await tx.query<ConnectionRow>(
          `UPDATE app.hermes_connections SET
             base_url = coalesce($3, base_url), secret_id = coalesce($4::uuid, secret_id), agent = coalesce($5, agent),
             status = 'unknown', last_error = NULL, last_checked_at = NULL, updated_at = now()
           WHERE id = $1::uuid AND team_id = $2::uuid RETURNING ${CONNECTION_COLUMNS}`,
          [connectionId, team.id, body.baseUrl ?? null, newSecret, body.agent ?? null],
        );
        const row = updated.rows[0];
        if (!row) throw forbidden('You do not have permission to do that');
        await ctx.audit.emit(tx, {
          type: 'hermes.connection.updated',
          workspaceId: team.workspace_id,
          teamId: team.id,
          connectionId,
          name: row.name,
          baseUrlChanged: body.baseUrl !== undefined && body.baseUrl !== current.base_url,
          keyChanged: body.apiKey !== undefined,
          agent: row.agent as HermesConnectionAgent,
          actorId: tx.actor.id,
          at: at(),
        });
        if (newSecret !== null && current.secret_id !== null) dropSecretAfterCommit(ctx, team.workspace_id, current.secret_id as string);
        return json(UpdateHermesConnectionResponse.parse({ connection: toHermesConnection(row) }));
      } catch (err) {
        if (newSecret !== null) dropSecretAfterCommit(ctx, team.workspace_id, newSecret as string);
        throw err;
      }
    }),
  });

  ctx.http.route({
    method: deleteHermesConnectionRoute.method,
    path: deleteHermesConnectionRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: DeleteHermesConnectionResponse },
    handler: route(async (req, tx) => {
      const { slug, connectionId } = req.params as { slug: string; connectionId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const current = await requireConnection(tx, team.id, connectionId);
      if (current.kind !== 'external') throw conflict("The team's own Hermes pod is managed by the platform; it cannot be removed here.");
      const gone = await tx.query('DELETE FROM app.hermes_connections WHERE id = $1::uuid AND team_id = $2::uuid RETURNING id', [connectionId, team.id]);
      if (gone.rows.length !== 1) throw forbidden('You do not have permission to do that');
      await ctx.audit.emit(tx, { type: 'hermes.connection.deleted', workspaceId: team.workspace_id, teamId: team.id, connectionId, name: current.name, actorId: tx.actor.id, at: at() });
      if (current.secret_id !== null) dropSecretAfterCommit(ctx, team.workspace_id, current.secret_id as string);
      return json(DeleteHermesConnectionResponse.parse({ deleted: true }));
    }),
  });

  ctx.http.route({
    method: reenableHermesProfileRoute.method,
    path: reenableHermesProfileRoute.path,
    rateLimit: { limit: 10, windowMs: 60_000 },
    schema: { response: ReenableHermesProfileResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = req.params as { slug: string; botSlug: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const bot = (
        await tx.query<{ id: string; workspace_id: string; team_id: string }>(
          `SELECT id, workspace_id, team_id FROM app.bots WHERE team_id = $1::uuid AND slug = $2 AND status = 'active' AND placement -> 'gateway' ->> 'connection' = 'managed'`,
          [team.id, botSlug],
        )
      ).rows[0];
      if (!bot) throw notFound(`No active bot "${botSlug}" on the managed gateway`);
      if (!(await reenableProfileSecrets(ctx, bot))) throw conflict('That bot has no managed profile yet; there is nothing to turn back on.');
      await ctx.audit.emit(tx, { type: 'hermes.profiles.changed', workspaceId: team.workspace_id, teamId: team.id, at: at() });
      notify(team.id);
      return json(ReenableHermesProfileResponse.parse({ enabled: true }));
    }),
  });

  ctx.http.route({
    method: testHermesConnectionRoute.method,
    path: testHermesConnectionRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { body: TestHermesConnectionRequest, response: TestHermesConnectionResponse },
    handler: route(async (req, tx) => {
      const { slug, connectionId } = req.params as { slug: string; connectionId: string };
      const body = TestHermesConnectionRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const current = await requireConnection(tx, team.id, connectionId);
      if (current.base_url === null) throw conflict('This connection has no address yet.');
      const checkedAt = at();
      let outcome: Pick<TestHermesConnectionResponse, 'ok' | 'error' | 'tools' | 'manythreadsTools'>;
      if (current.kind === 'managed' && body.profile === undefined) {
        // The pod's profiles each have their own key; without one named there is nothing to authenticate with.
        throw invalid('Name a profile (mt-<bot slug>) to test the managed pod.');
      }
      const key =
        current.kind === 'managed'
          ? await ctx.db.system(async (sys) => {
              const botSlug = (body.profile as string).replace(/^mt-/, '');
              const bot = (await sys.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1::uuid AND slug = $2', [team.id, botSlug])).rows[0];
              return bot ? readProfileApiKey(ctx, sys, bot.id) : null;
            })
          : current.secret_id === null
            ? null
            : await ctx.db.system((sys) => ctx.secrets.get(sys, current.secret_id as string));
      if (key === null) outcome = { ok: false, error: 'This connection has no API key yet.', tools: null, manythreadsTools: null };
      else {
        outcome = await checkGateway({ baseUrl: current.base_url, apiKey: key, guarded: current.kind === 'external', kind: current.kind === 'managed' ? 'managed' : 'external', agent: current.agent as HermesConnectionAgent }, body.profile, options.fetch ? { fetch: options.fetch } : {});
      }
      await tx.query(
        `UPDATE app.hermes_connections SET status = $3, last_checked_at = now(), last_error = $4, updated_at = now() WHERE id = $1::uuid AND team_id = $2::uuid`,
        [connectionId, team.id, outcome.ok ? 'ok' : 'error', outcome.error],
      );
      await ctx.audit.emit(tx, { type: 'hermes.connection.tested', workspaceId: team.workspace_id, teamId: team.id, connectionId, name: current.name, ok: outcome.ok, actorId: tx.actor.id, at: checkedAt });
      return json(TestHermesConnectionResponse.parse({ ...outcome, checkedAt }));
    }),
  });
}

