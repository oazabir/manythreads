import {
  conflict,
  forbidden,
  invalid,
  json,
  notFound,
  requireManage,
  requireTeam,
  route,
  type BotRunnersProvider,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import { checkHermesGateway } from '@manythreads/sdk/hermes-outbound';
import {
  CreateHermesConnectionResponse,
  DeleteHermesConnectionResponse,
  HermesConnection,
  type HermesConnectionAgent,
  ListHermesConnectionsResponse,
  ReenableHermesProfileResponse,
  reenableHermesProfileRoute,
  TestHermesConnectionRequest,
  TestHermesConnectionResponse,
  UpdateHermesConnectionResponse,
  createHermesConnectionRoute,
  deleteHermesConnectionRoute,
  listHermesConnectionsRoute,
  testHermesConnectionRoute,
  updateHermesConnectionRoute,
} from '@manythreads/shared';
import { GatewayRefused, type GatewayTarget } from './gateway.ts';
import { ensureProfileSecrets, readProfileApiKey, reenableProfileSecrets } from './profile-secrets.ts';

// Hermes connections: the gateways a team's bots were placed on (`placement.gateway.connection`). Since Phase 19 a workspace admin makes the places bots run
// as RUNNERS (`bot-runners`); a team lead can no longer make, change or remove a connection (those routes answer 403 with the reason), and the address of a
// connection is shown to a workspace admin only. What stays: the lead lists the team's connections and tests one with its three fixed sentences, the
// platform writes the reserved connection `managed` for the team's own pod (`profiles.ts`), and a connection an admin ADOPTED into a runner keeps its row
// (so a BOT.md naming it still finds it) but is resolved through the runner of that name. The API key is encrypted in `app.secrets` and is never returned.

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
  runner_name: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The one mapper of `app.hermes_connections`: a row to the shared type. The key is never read here, only whether there is one. */
export function toHermesConnection(r: ConnectionRow, options: { showAddress?: boolean } = {}): HermesConnection {
  return HermesConnection.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    kind: r.kind,
    agent: r.agent,
    baseUrl: options.showAddress === false ? null : r.base_url,
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
  'id, workspace_id, team_id, name, kind, agent, base_url, secret_id, status, last_checked_at, last_error, runner_name, created_by, created_at, updated_at';

type BotRef = { id: string; workspace_id: string; team_id: string };

/**
 * Where a run goes, from what the runner catalog resolved (`bot-runners`, the `bot.runners` provider). A Hermes gateway has one key for the whole gateway;
 * the team's own pod has one key per profile (the bot's `API_SERVER_KEY`), made here on first use. Runs as the system actor.
 */
async function targetOfRunner(ctx: PluginContext, teamId: string, runner: string, bot: BotRef | null, options: { unlistedIsAbsent?: boolean } = {}): Promise<GatewayTarget | null> {
  const provider = ctx.providers.get<BotRunnersProvider>('bot.runners');
  if (!provider) throw new GatewayRefused('Runners are not available on this server, so the bot cannot be placed on one.');
  const answer = await provider.resolveRunner({ teamId, runner });
  if (!answer.ok) {
    // A name that is no connection of the team may still be a runner: a runner the team may not use is then the same as a name that is nothing at all.
    if (options.unlistedIsAbsent && (answer.reason === 'unknown' || answer.reason === 'not_available_to_team')) return null;
    throw new GatewayRefused(answer.message);
  }
  const { target } = answer;
  if (target.address === null) return null;
  if (target.kind === 'hermes_gateway') {
    if (target.key === null) return null;
    return { baseUrl: target.address, apiKey: target.key, guarded: target.guard, kind: 'external', agent: target.agent };
  }
  if (target.kind === 'hermes_pod') {
    if (!bot) return null;
    const secrets = await ensureProfileSecrets(ctx, bot);
    return 'revoked' in secrets ? null : { baseUrl: target.address, apiKey: secrets.apiKey, kind: 'managed', agent: 'hermes' };
  }
  return null;
}

const botOf = (ctx: PluginContext, teamId: string, botId: string): Promise<BotRef | null> =>
  ctx.db.system(async (tx) => (await tx.query<BotRef>('SELECT id, workspace_id, team_id FROM app.bots WHERE id = $1::uuid AND team_id = $2::uuid', [botId, teamId])).rows[0] ?? null);

/**
 * The address and key a run of `botId` should use for the team's connection `name`, or for the runner of that name when the team has no such connection. A connection an admin adopted into a runner is resolved through that
 * runner, so its on/off switch, its team list and its current key rule; one nobody adopted is read as it always was. Runs as the system actor: this is the
 * only reader of a key.
 */
export async function resolveTarget(
  ctx: PluginContext,
  query: { teamId: string; botId: string; botSlug: string; connection: string },
): Promise<GatewayTarget | null> {
  const row = await ctx.db.system(async (tx) => (await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.hermes_connections WHERE team_id = $1::uuid AND name = $2`, [query.teamId, query.connection])).rows[0]);
  const bot = await botOf(ctx, query.teamId, query.botId);
  // No connection of that name: the name may be a runner an admin made available to this team (`gateway: host`), resolved with the same refusals as a `runs_on` placement.
  if (!row) return targetOfRunner(ctx, query.teamId, query.connection, bot, { unlistedIsAbsent: true });
  if (row.runner_name !== null) return targetOfRunner(ctx, query.teamId, row.runner_name, bot);
  if (row.base_url === null) return null;
  if (row.kind === 'managed') {
    // The first run of a managed bot can come before any controller asked for its profile: the key is created here, and stable afterwards.
    if (!bot) return null;
    const secrets = await ensureProfileSecrets(ctx, bot);
    return 'revoked' in secrets ? null : { baseUrl: row.base_url, apiKey: secrets.apiKey, kind: 'managed', agent: 'hermes' };
  }
  if (row.secret_id === null) return null;
  const secretId = row.secret_id;
  const baseUrl = row.base_url;
  const agent = row.agent as HermesConnectionAgent;
  return ctx.db.system(async (tx) => ({ baseUrl, apiKey: await ctx.secrets.get(tx, secretId), guarded: true, kind: 'external' as const, agent }));
}

/** The target of a bot placed straight on a runner (`placement.runs_on`, P19-03): the same answer as a connection that was adopted into it. */
export async function resolveRunnerTarget(ctx: PluginContext, query: { teamId: string; botId: string; runner: string }): Promise<GatewayTarget | null> {
  return targetOfRunner(ctx, query.teamId, query.runner, await botOf(ctx, query.teamId, query.botId));
}

/** Check a gateway: the SDK's check (three fixed sentences, never anything the remote side said), kept here under its old name for the connection test. */
export async function checkGateway(
  target: GatewayTarget,
  profile: string | undefined,
  options: { fetch?: typeof fetch },
): Promise<Pick<TestHermesConnectionResponse, 'ok' | 'error' | 'tools' | 'manythreadsTools'>> {
  return checkHermesGateway({ baseUrl: target.baseUrl, apiKey: target.apiKey, guarded: target.guarded === true }, profile, options);
}

async function requireConnection(tx: PluginTx, teamId: string, connectionId: string): Promise<ConnectionRow> {
  const row = (await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.hermes_connections WHERE id = $1::uuid AND team_id = $2::uuid`, [connectionId, teamId])).rows[0];
  if (!row) throw notFound('No such Hermes connection');
  return row;
}

export interface ConnectionRouteOptions {
  fetch?: typeof fetch;
}

/** What a lead is told when they try to make, change or remove a connection: the plain reason and who to ask. */
export const CONNECTIONS_ADMIN_ONLY = 'Runners are set up by a workspace admin now. Ask an admin to add or change this under Runners.';

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
      // Only a workspace admin reads an address: a lead sees that a connection exists, is OK or not, and nothing about where it points.
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      const showAddress = role === 'owner' || role === 'admin';
      const rows = await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.hermes_connections WHERE team_id = $1::uuid ORDER BY name`, [team.id]);
      return json(ListHermesConnectionsResponse.parse({ items: rows.rows.map((r) => toHermesConnection(r, { showAddress })) }));
    }),
  });

  // Make, change and remove: a workspace admin does these as a runner now. The routes stay so an old client gets the reason, not a missing page; the body is not read.
  ctx.http.route({
    method: createHermesConnectionRoute.method,
    path: createHermesConnectionRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: CreateHermesConnectionResponse },
    handler: route(async () => {
      throw forbidden(CONNECTIONS_ADMIN_ONLY);
    }),
  });

  ctx.http.route({
    method: updateHermesConnectionRoute.method,
    path: updateHermesConnectionRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: UpdateHermesConnectionResponse },
    handler: route(async () => {
      throw forbidden(CONNECTIONS_ADMIN_ONLY);
    }),
  });

  ctx.http.route({
    method: deleteHermesConnectionRoute.method,
    path: deleteHermesConnectionRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: DeleteHermesConnectionResponse },
    handler: route(async () => {
      throw forbidden(CONNECTIONS_ADMIN_ONLY);
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
      const check = (target: GatewayTarget) => checkGateway(target, body.profile, options.fetch ? { fetch: options.fetch } : {});
      if (current.runner_name !== null && current.kind === 'external') {
        // An adopted connection is asked where its runner points now, with the runner's key; if the runner will not serve the team, it says so in its own words.
        let target: GatewayTarget | null = null;
        let refused: string | null = null;
        try {
          target = await targetOfRunner(ctx, team.id, current.runner_name, null);
        } catch (err) {
          if (!(err instanceof GatewayRefused)) throw err;
          refused = err.message;
        }
        outcome = target === null ? { ok: false, error: refused ?? 'This connection has no API key yet.', tools: null, manythreadsTools: null } : await check(target);
      } else {
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
        outcome =
          key === null
            ? { ok: false, error: 'This connection has no API key yet.', tools: null, manythreadsTools: null }
            : await check({ baseUrl: current.base_url, apiKey: key, guarded: current.kind === 'external', kind: current.kind === 'managed' ? 'managed' : 'external', agent: current.agent as HermesConnectionAgent });
      }
      // A lead cannot write the row any more: the platform records the answer.
      await ctx.db.system(
        (sys) =>
          sys.query(`UPDATE app.hermes_connections SET status = $3, last_checked_at = now(), last_error = $4, updated_at = now() WHERE id = $1::uuid AND team_id = $2::uuid`, [connectionId, team.id, outcome.ok ? 'ok' : 'error', outcome.error]),
        { workspaceId: team.workspace_id },
      );
      await ctx.audit.emit(tx, { type: 'hermes.connection.tested', workspaceId: team.workspace_id, teamId: team.id, connectionId, name: current.name, ok: outcome.ok, actorId: tx.actor.id, at: checkedAt });
      return json(TestHermesConnectionResponse.parse({ ...outcome, checkedAt }));
    }),
  });
}
