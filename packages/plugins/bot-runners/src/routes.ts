import { conflict, forbidden, invalid, json, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { checkHermesGateway } from '@manythreads/sdk/hermes-outbound';
import {
  BotRunnerPathParams,
  CreateBotRunnerRequest,
  CreateBotRunnerResponse,
  DeleteBotRunnerResponse,
  ListBotRunnersResponse,
  ListTeamBotRunnersResponse,
  LlmAliasName,
  SetBotRunnerTeamsRequest,
  SetBotRunnerTeamsResponse,
  SetDefaultBotRunnerRequest,
  SetDefaultBotRunnerResponse,
  TeamBotRunner,
  TestBotRunnerRequest,
  TestBotRunnerResponse,
  UpdateBotRunnerRequest,
  UpdateBotRunnerResponse,
  abuseLimit,
  createBotRunnerRoute,
  deleteBotRunnerRoute,
  listBotRunnersRoute,
  listTeamBotRunnersRoute,
  setBotRunnerTeamsRoute,
  setDefaultBotRunnerRoute,
  testBotRunnerRoute,
  updateBotRunnerRoute,
  type BotRunnerStatus,
  type BotRunnerTeams,
} from '@manythreads/shared';
import { registerAdoptionRoutes } from './adopt.ts';
import { loadRunner, presentOne, presentRunners, requireAllowedAddress, requireWorkspaceAdmin } from './common.ts';
import { DEFAULT_PROFILE_RULE } from './resolve.ts';
import { effectiveStatus, placementsOf, RUNNER_SELECT, type RunnerRow } from './rows.ts';

// The runner catalog's routes (PLAN P19-02, docs/plugins/bot-runners.md). A workspace admin makes, changes, tests, shares and removes runners; a team member
// reads the short view of the runners available to their team. A key is accepted and never returned; neither an error nor a log line carries an address,
// a key or a node to someone who is not a workspace admin (the database refuses the read, and the routes below start with the admin check).

const READ_LIMIT = { limit: 120, windowMs: 60_000 };
const WRITE_LIMIT = { limit: 60, windowMs: 60_000 };

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

/** The kinds that need no sign-in file or pod yet. The other two are accepted by the shape and answered here. */
const NOT_YET = 'Claude Code and Codex runners are not available yet.';

/** The status a new or re-aimed LLM gateway runner starts in: ready when its alias is bound on the LLM page, otherwise not set up. */
async function llmAliasStatus(tx: PluginTx, workspaceId: string, alias: string): Promise<{ status: BotRunnerStatus; detail: string | null }> {
  const there = (await tx.query<{ t: string | null }>("SELECT to_regclass('app.llm_aliases')::text AS t")).rows[0]?.t;
  if (there) {
    const bound = (await tx.query('SELECT 1 FROM app.llm_aliases WHERE workspace_id = $1::uuid AND alias = $2', [workspaceId, alias])).rows.length > 0;
    if (bound) return { status: 'ready', detail: null };
  }
  return { status: 'not_set_up', detail: `The model alias "${alias}" has no model yet. Set it on the LLM page.` };
}

/** Replace a runner's team list (and its all-teams flag). Teams of another workspace are refused by the database. */
async function writeTeams(tx: PluginTx, runnerId: string, teams: BotRunnerTeams): Promise<number> {
  await tx.query('DELETE FROM app.bot_runner_teams WHERE runner_id = $1::uuid', [runnerId]);
  if ('all' in teams) {
    await tx.query('UPDATE app.bot_runners SET all_teams = true, updated_at = now() WHERE id = $1::uuid', [runnerId]);
    return 0;
  }
  const unique = [...new Set(teams.teams)];
  if (unique.length > 0) {
    await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) SELECT $1::uuid, t FROM unnest($2::uuid[]) AS t', [runnerId, unique]);
  }
  await tx.query('UPDATE app.bot_runners SET all_teams = false, updated_at = now() WHERE id = $1::uuid', [runnerId]);
  return unique.length;
}

/** Which settings belong to which kind: a setting on the wrong kind is refused rather than stored and ignored. */
function checkSettingsFit(kind: string, s: { baseUrl?: unknown; apiKey?: unknown; profileRule?: unknown; node?: unknown; modelAlias?: unknown }): void {
  const gateway = kind === 'hermes_gateway';
  const pod = kind === 'hermes_pod';
  if ((s.baseUrl !== undefined || s.apiKey !== undefined) && !gateway) throw invalid('An address and a key belong to a Hermes gateway runner only.');
  if (s.profileRule !== undefined && !gateway && !pod) throw invalid('A profile rule belongs to a Hermes runner only.');
  if (s.node !== undefined && s.node !== null && !pod) throw invalid('A node belongs to a pod runner only.');
  if (s.modelAlias !== undefined && kind !== 'llm_gateway') throw invalid('A model alias belongs to an LLM gateway runner only.');
}

function requireAlias(alias: string | undefined): string {
  if (alias === undefined) throw invalid('Name the model alias this runner calls.');
  if (!LlmAliasName.safeParse(alias).success) throw invalid('That is not a model alias. See the LLM page for the names.');
  return alias;
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listBotRunnersRoute.method,
    path: listBotRunnersRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: ListBotRunnersResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const rows = await tx.query<RunnerRow>(`SELECT ${RUNNER_SELECT} WHERE r.workspace_id = $1::uuid ORDER BY r.is_default DESC, r.label, r.name`, [tx.actor.workspaceId]);
      return json(ListBotRunnersResponse.parse({ items: await presentRunners(ctx, tx, rows.rows) }));
    }),
  });

  ctx.http.route({
    method: createBotRunnerRoute.method,
    path: createBotRunnerRoute.path,
    rateLimit: abuseLimit(createBotRunnerRoute.method, createBotRunnerRoute.path),
    schema: { body: CreateBotRunnerRequest, response: CreateBotRunnerResponse },
    handler: route(async (req, tx) => {
      const body = CreateBotRunnerRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      if (body.kind === 'claude_cli' || body.kind === 'codex_cli') throw conflict(NOT_YET);
      checkSettingsFit(body.kind, body);
      const workspaceId = tx.actor.workspaceId;
      if ((await tx.query('SELECT 1 FROM app.bot_runners WHERE workspace_id = $1::uuid AND name = $2', [workspaceId, body.name])).rows.length > 0) {
        throw conflict('A runner with that name already exists. Names are used in bot files, so pick a different one.');
      }
      let status: BotRunnerStatus = 'ready';
      let detail: string | null = null;
      let secretId: string | null = null;
      if (body.kind === 'hermes_gateway') {
        if (body.baseUrl === undefined || body.apiKey === undefined) throw invalid('A Hermes gateway runner needs an address and a key.');
        await requireAllowedAddress(body.baseUrl);
        // Written in the admin's own transaction: if the row below fails, the secret goes with it.
        secretId = await ctx.secrets.put(tx, body.apiKey);
        status = 'not_set_up';
        detail = 'Not tested yet. Use Test to check the address and the key.';
      } else if (body.kind === 'llm_gateway') {
        ({ status, detail } = await llmAliasStatus(tx, workspaceId, requireAlias(body.modelAlias)));
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, base_url, secret_id, profile_rule, node, model_alias, status, status_detail)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12) RETURNING id`,
        [
          workspaceId,
          body.name,
          body.label,
          body.kind,
          body.enabled ?? true,
          body.baseUrl ?? null,
          secretId,
          body.kind === 'hermes_gateway' || body.kind === 'hermes_pod' ? (body.profileRule ?? DEFAULT_PROFILE_RULE) : null,
          body.node ?? null,
          body.modelAlias ?? null,
          status,
          detail,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('the runner insert answered no row');
      const at = now(ctx);
      await ctx.audit.emit(tx, { type: 'bot_runner.runner.created', workspaceId, runnerId: id, name: body.name, kind: body.kind, adopted: false, actorId: tx.actor.id, at });
      if (body.teams !== undefined) {
        const teamCount = await writeTeams(tx, id, body.teams);
        await ctx.audit.emit(tx, { type: 'bot_runner.availability.changed', workspaceId, runnerId: id, name: body.name, enabled: body.enabled ?? true, allTeams: 'all' in body.teams, teamCount, actorId: tx.actor.id, at });
      }
      return json(CreateBotRunnerResponse.parse({ runner: await presentOne(ctx, tx, id) }), 201);
    }),
  });

  ctx.http.route({
    method: updateBotRunnerRoute.method,
    path: updateBotRunnerRoute.path,
    rateLimit: abuseLimit(updateBotRunnerRoute.method, updateBotRunnerRoute.path),
    schema: { body: UpdateBotRunnerRequest, response: UpdateBotRunnerResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      const body = UpdateBotRunnerRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      const current = await loadRunner(tx, id);
      checkSettingsFit(current.kind, body);
      const changed: Array<'label' | 'address' | 'key' | 'profile_rule' | 'node' | 'model_alias' | 'enabled'> = [];
      const sets: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (body.label !== undefined && body.label !== current.label) {
        set('label', body.label);
        changed.push('label');
      }
      let resetCheck = false;
      if (body.baseUrl !== undefined && body.baseUrl !== current.base_url) {
        await requireAllowedAddress(body.baseUrl);
        set('base_url', body.baseUrl);
        changed.push('address');
        resetCheck = true;
      }
      let oldSecret: string | null = null;
      if (body.apiKey !== undefined) {
        const fresh = await ctx.secrets.put(tx, body.apiKey);
        oldSecret = current.secret_id;
        values.push(fresh);
        sets.push(`secret_id = $${values.length}::uuid`);
        changed.push('key');
        resetCheck = true;
      }
      if (body.profileRule !== undefined && body.profileRule !== current.profile_rule) {
        set('profile_rule', body.profileRule);
        changed.push('profile_rule');
      }
      if (body.node !== undefined && body.node !== current.node) {
        set('node', body.node);
        changed.push('node');
      }
      if (body.modelAlias !== undefined && body.modelAlias !== current.model_alias) {
        const alias = requireAlias(body.modelAlias);
        const state = await llmAliasStatus(tx, current.workspace_id, alias);
        set('model_alias', alias);
        set('status', state.status);
        set('status_detail', state.detail);
        changed.push('model_alias');
      }
      if (body.enabled !== undefined && body.enabled !== current.enabled) {
        if (!body.enabled && current.is_default) throw conflict('This is the default runner. Make another runner the default (or none) before switching it off.');
        set('enabled', body.enabled);
        changed.push('enabled');
      }
      if (changed.length === 0) throw invalid('Nothing to change');
      // A new address or key invalidates the last check: the runner reads "not set up" until the next test.
      if (resetCheck) {
        set('status', 'not_set_up');
        set('status_detail', 'Changed. Use Test to check the address and the key.');
        sets.push('last_checked_at = NULL');
      }
      await tx.query(`UPDATE app.bot_runners SET ${sets.join(', ')}, updated_at = now() WHERE id = $1::uuid`, values);
      if (oldSecret !== null) await ctx.secrets.delete(tx, oldSecret);
      const at = now(ctx);
      await ctx.audit.emit(tx, { type: 'bot_runner.runner.updated', workspaceId: current.workspace_id, runnerId: id, name: current.name, changed, actorId: tx.actor.id, at });
      if (changed.includes('enabled')) {
        const teamCount = (await tx.query('SELECT 1 FROM app.bot_runner_teams WHERE runner_id = $1::uuid', [id])).rows.length;
        await ctx.audit.emit(tx, { type: 'bot_runner.availability.changed', workspaceId: current.workspace_id, runnerId: id, name: current.name, enabled: body.enabled === true, allTeams: current.all_teams, teamCount: current.all_teams ? 0 : teamCount, actorId: tx.actor.id, at });
      }
      return json(UpdateBotRunnerResponse.parse({ runner: await presentOne(ctx, tx, id) }));
    }),
  });

  ctx.http.route({
    method: deleteBotRunnerRoute.method,
    path: deleteBotRunnerRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { response: DeleteBotRunnerResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const current = await loadRunner(tx, id);
      const workspaceId = current.workspace_id;
      // Bots of every team are counted, so the count is read as the system; the answer names teams, never an address or a key.
      const placed = (await ctx.db.system((sys) => placementsOf(sys, workspaceId, [id]), { workspaceId })).get(id);
      if (placed && placed.count > 0) {
        const bots = placed.count === 1 ? '1 bot is' : `${placed.count} bots are`;
        throw conflict(`${bots} still placed on "${current.label}" (teams: ${placed.teams.join(', ')}). Move them to another runner first.`);
      }
      // Connections an admin adopted into this runner: an external one goes with it, the team's own pod row stays (the platform keeps it) and is simply unlinked.
      const linked = await tx.query<{ id: string; kind: string; secret_id: string | null }>(
        'SELECT id, kind, secret_id FROM app.hermes_connections WHERE workspace_id = $1::uuid AND runner_name = $2',
        [workspaceId, current.name],
      );
      for (const c of linked.rows) {
        if (c.kind === 'managed') await tx.query('UPDATE app.hermes_connections SET runner_name = NULL, updated_at = now() WHERE id = $1::uuid', [c.id]);
        else {
          await tx.query('DELETE FROM app.hermes_connections WHERE id = $1::uuid', [c.id]);
          if (c.secret_id !== null) await ctx.secrets.delete(tx, c.secret_id);
        }
      }
      const gone = await tx.query('DELETE FROM app.bot_runners WHERE id = $1::uuid RETURNING id', [id]);
      if (gone.rows.length !== 1) throw forbidden();
      if (current.secret_id !== null) await ctx.secrets.delete(tx, current.secret_id);
      await ctx.audit.emit(tx, { type: 'bot_runner.runner.deleted', workspaceId, runnerId: id, name: current.name, kind: current.kind, actorId: tx.actor.id, at: now(ctx) });
      return json(DeleteBotRunnerResponse.parse({ deleted: true }));
    }),
  });

  ctx.http.route({
    method: testBotRunnerRoute.method,
    path: testBotRunnerRoute.path,
    rateLimit: abuseLimit(testBotRunnerRoute.method, testBotRunnerRoute.path),
    schema: { body: TestBotRunnerRequest, response: TestBotRunnerResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      const body = TestBotRunnerRequest.parse(req.body ?? {});
      await requireWorkspaceAdmin(tx);
      const current = await loadRunner(tx, id);
      const checkedAt = now(ctx);
      let ok: boolean;
      let error: string | null;
      let status: BotRunnerStatus;
      if (current.kind === 'hermes_gateway') {
        if (current.base_url === null || current.secret_id === null) {
          ok = false;
          error = 'This runner has no address or key yet.';
        } else {
          const secretId = current.secret_id;
          const key = await ctx.db.system((sys) => ctx.secrets.get(sys, secretId), { workspaceId: current.workspace_id });
          // The same check as a connection test: three fixed sentences, through the outbound guard, and never anything the remote side said.
          const outcome = await checkHermesGateway({ baseUrl: current.base_url, apiKey: key, guarded: true }, body.profile, {});
          ok = outcome.ok;
          error = outcome.error;
        }
        status = ok ? 'ready' : 'not_set_up';
        await tx.query('UPDATE app.bot_runners SET status = $2, status_detail = $3, last_checked_at = now(), updated_at = now() WHERE id = $1::uuid', [id, status, error]);
        status = effectiveStatus({ enabled: current.enabled, status });
      } else {
        // The other kinds are not asked over the network from here: they report the state they are in.
        status = effectiveStatus(current);
        ok = status === 'ready';
        error = ok ? null : (current.status_detail ?? (current.enabled ? 'This runner is not ready.' : 'This runner is switched off.'));
      }
      await ctx.audit.emit(tx, { type: 'bot_runner.runner.tested', workspaceId: current.workspace_id, runnerId: id, name: current.name, ok, actorId: tx.actor.id, at: checkedAt });
      return json(TestBotRunnerResponse.parse({ ok, error, status, checkedAt }));
    }),
  });

  ctx.http.route({
    method: setBotRunnerTeamsRoute.method,
    path: setBotRunnerTeamsRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: SetBotRunnerTeamsRequest, response: SetBotRunnerTeamsResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      const body = SetBotRunnerTeamsRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      const current = await loadRunner(tx, id);
      const teamCount = await writeTeams(tx, id, body);
      await ctx.audit.emit(tx, { type: 'bot_runner.availability.changed', workspaceId: current.workspace_id, runnerId: id, name: current.name, enabled: current.enabled, allTeams: 'all' in body, teamCount, actorId: tx.actor.id, at: now(ctx) });
      return json(SetBotRunnerTeamsResponse.parse({ runner: await presentOne(ctx, tx, id) }));
    }),
  });

  ctx.http.route({
    method: setDefaultBotRunnerRoute.method,
    path: setDefaultBotRunnerRoute.path,
    rateLimit: abuseLimit(setDefaultBotRunnerRoute.method, setDefaultBotRunnerRoute.path),
    schema: { body: SetDefaultBotRunnerRequest, response: SetDefaultBotRunnerResponse },
    handler: route(async (req, tx) => {
      const body = SetDefaultBotRunnerRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      const workspaceId = tx.actor.workspaceId;
      const previous = (await tx.query<{ id: string }>('SELECT id FROM app.bot_runners WHERE workspace_id = $1::uuid AND is_default', [workspaceId])).rows[0]?.id ?? null;
      if (body.runnerId !== null) {
        const target = await loadRunner(tx, body.runnerId);
        if (!target.enabled) throw conflict('A runner that is switched off cannot be the default.');
        if (target.kind === 'claude_cli' || target.kind === 'codex_cli' || target.kind === 'llm_gateway') throw conflict('This kind of runner cannot be the default yet.');
      }
      if (previous !== body.runnerId) {
        // One statement clears the old default before the next sets the new one: the database allows one default per workspace.
        await tx.query('UPDATE app.bot_runners SET is_default = false, updated_at = now() WHERE workspace_id = $1::uuid AND is_default', [workspaceId]);
        if (body.runnerId !== null) await tx.query('UPDATE app.bot_runners SET is_default = true, updated_at = now() WHERE id = $1::uuid', [body.runnerId]);
        await ctx.audit.emit(tx, { type: 'bot_runner.default.changed', workspaceId, runnerId: body.runnerId, previousRunnerId: previous, actorId: tx.actor.id, at: now(ctx) });
      }
      return json(SetDefaultBotRunnerResponse.parse({ defaultRunnerId: body.runnerId }));
    }),
  });

  ctx.http.route({
    method: listTeamBotRunnersRoute.method,
    path: listTeamBotRunnersRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: ListTeamBotRunnersResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      // The database function checks that the caller belongs to the team and returns the short view only.
      const rows = await tx.query<{ name: string; label: string; kind: string; status: string; is_default: boolean; owner_name: string | null; plan_label: string | null; shared_with: number }>(
        'SELECT name, label, kind, status, is_default, owner_name, plan_label, shared_with FROM app.bot_runners_for_team($1::uuid)',
        [team.id],
      );
      const items = rows.rows.map((r) =>
        TeamBotRunner.parse({ name: r.name, label: r.label, kind: r.kind, status: r.status, isDefault: r.is_default, ownerName: r.owner_name, planLabel: r.plan_label, sharedWith: r.shared_with }),
      );
      return json(ListTeamBotRunnersResponse.parse({ items }));
    }),
  });

  registerAdoptionRoutes(ctx);
}
