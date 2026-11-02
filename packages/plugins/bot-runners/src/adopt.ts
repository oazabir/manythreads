import { conflict, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AdoptConnectionRequest,
  AdoptConnectionResponse,
  BotRunnerName,
  ListOldConnectionsResponse,
  OldConnection,
  OldConnectionPathParams,
  abuseLimit,
  adoptConnectionRoute,
  listOldConnectionsRoute,
} from '@manythreads/shared';
import { loadRunner, presentRunners, requireWorkspaceAdmin } from './common.ts';
import { DEFAULT_PROFILE_RULE } from './resolve.ts';

// Adopting a team's old connection (PLAN P19-02). Before runners, a team lead typed a Hermes address and key into a "connection" and a BOT.md named it
// (`placement.gateway.connection: host`). A workspace admin now lists those, and adopts one: a runner is made from it (same address, same key), available to
// that team only, and the connection row is linked to the runner by name. No BOT.md changes: the file still names the connection, and from the day of the
// adoption a run on that connection is resolved through the runner (its address, key, on/off switch and team list), so what an admin changes is what happens.

const POD_RUNNER_NAME = 'team-pod';
const POD_RUNNER_LABEL = 'Team Hermes pod';

interface OldRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  team_slug: string;
  team_name: string;
  name: string;
  kind: 'external' | 'managed';
  agent: 'hermes' | 'claude-code' | 'codex';
  base_url: string | null;
  secret_id: string | null;
  status: string;
  bot_count: number;
}

const OLD_SELECT = `SELECT c.id, c.workspace_id, c.team_id, t.slug AS team_slug, t.name AS team_name, c.name, c.kind, c.agent, c.base_url, c.secret_id, c.status,
       (SELECT count(*)::int FROM app.bots b WHERE b.team_id = c.team_id AND b.status IN ('active', 'disabled') AND b.placement -> 'gateway' ->> 'connection' = c.name) AS bot_count
  FROM app.hermes_connections c JOIN app.teams t ON t.id = c.team_id`;

const NOT_ADOPTABLE = 'This connection runs Claude Code or Codex. Those become runners with the Claude and Codex runner tasks of the plan; until then it stays as it is.';

const toOld = (r: OldRow): OldConnection =>
  OldConnection.parse({
    id: r.id,
    teamId: r.team_id,
    teamSlug: r.team_slug,
    teamName: r.team_name,
    name: r.name,
    kind: r.kind,
    agent: r.agent,
    baseUrl: r.base_url,
    adoptable: r.agent === 'hermes',
    adoptableReason: r.agent === 'hermes' ? null : NOT_ADOPTABLE,
    botCount: r.bot_count,
  });

export function registerAdoptionRoutes(ctx: PluginContext): void {
  const at = (): string => ctx.runtime.now().toISOString();

  ctx.http.route({
    method: listOldConnectionsRoute.method,
    path: listOldConnectionsRoute.path,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: ListOldConnectionsResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const rows = await tx.query<OldRow>(`${OLD_SELECT} WHERE c.workspace_id = $1::uuid AND c.runner_name IS NULL ORDER BY t.name, c.name`, [tx.actor.workspaceId]);
      return json(ListOldConnectionsResponse.parse({ items: rows.rows.map(toOld) }));
    }),
  });

  ctx.http.route({
    method: adoptConnectionRoute.method,
    path: adoptConnectionRoute.path,
    rateLimit: abuseLimit(adoptConnectionRoute.method, adoptConnectionRoute.path),
    schema: { body: AdoptConnectionRequest, response: AdoptConnectionResponse },
    handler: route(async (req, tx) => {
      const { connectionId } = OldConnectionPathParams.parse(req.params);
      const body = AdoptConnectionRequest.parse(req.body ?? {});
      await requireWorkspaceAdmin(tx);
      const row = (await tx.query<OldRow & { runner_name: string | null }>(`${OLD_SELECT.replace('c.status,', 'c.status, c.runner_name,')} WHERE c.id = $1::uuid`, [connectionId])).rows[0];
      if (!row) throw notFound('No such connection');
      if (row.runner_name !== null) throw conflict('That connection was already adopted into a runner.');
      if (row.agent !== 'hermes') throw conflict(NOT_ADOPTABLE);
      const workspaceId = row.workspace_id;
      let runnerId: string;

      if (row.kind === 'managed') {
        // The team's own pod: one shared runner for every pod, with each adopting team added to its list. The pod's address and per-bot keys stay where the platform keeps them.
        const name = body.name ?? POD_RUNNER_NAME;
        const existing = (await tx.query<{ id: string; kind: string; enabled: boolean }>('SELECT id, kind, enabled FROM app.bot_runners WHERE workspace_id = $1::uuid AND name = $2', [workspaceId, name])).rows[0];
        if (existing && existing.kind !== 'hermes_pod') throw conflict('A runner with that name already exists. Pick a different name.');
        // A pod runner an admin has switched off stays off: linking a team's connection to it would make that team's bots stop running.
        if (existing && !existing.enabled) throw conflict('The shared team pod runner is switched off. Switch it on under Runners first, then adopt this connection.');
        if (existing) runnerId = existing.id;
        else {
          const made = await tx.query<{ id: string }>(
            `INSERT INTO app.bot_runners (workspace_id, name, label, kind, profile_rule, status) VALUES ($1::uuid, $2, $3, 'hermes_pod', $4, 'ready') RETURNING id`,
            [workspaceId, name, body.label ?? POD_RUNNER_LABEL, DEFAULT_PROFILE_RULE],
          );
          const id = made.rows[0]?.id;
          if (!id) throw new Error('the runner insert answered no row');
          runnerId = id;
          await ctx.audit.emit(tx, { type: 'bot_runner.runner.created', workspaceId, runnerId, name, kind: 'hermes_pod', adopted: true, actorId: tx.actor.id, at: at() });
        }
        await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING', [runnerId, row.team_id]);
        await tx.query('UPDATE app.hermes_connections SET runner_name = $2, updated_at = now() WHERE id = $1::uuid', [row.id, name]);
        await announceAvailability(ctx, tx, runnerId, at());
      } else {
        const name = body.name ?? row.name;
        if (!BotRunnerName.safeParse(name).success) throw invalid('Give the runner a name of lowercase letters, digits, ".", "_" or "-".');
        if ((await tx.query('SELECT 1 FROM app.bot_runners WHERE workspace_id = $1::uuid AND name = $2', [workspaceId, name])).rows.length > 0) {
          throw conflict('A runner with that name already exists. Pick a different name for this one.');
        }
        if (row.base_url === null || row.secret_id === null) throw conflict('This connection has no address or key yet, so there is nothing to adopt.');
        // The runner gets a key of its own (a copy), so removing the runner never touches the connection's key and the other way round.
        const original = row.secret_id;
        const plain = await ctx.db.system((sys) => ctx.secrets.get(sys, original), { workspaceId });
        const secretId = await ctx.secrets.put(tx, plain);
        const label = (body.label ?? `${row.name} (${row.team_name})`).slice(0, 80);
        const made = await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runners (workspace_id, name, label, kind, base_url, secret_id, profile_rule, status, status_detail, last_checked_at)
           VALUES ($1::uuid, $2, $3, 'hermes_gateway', $4, $5::uuid, $6, $7, $8, now()) RETURNING id`,
          [workspaceId, name, label, row.base_url, secretId, DEFAULT_PROFILE_RULE, row.status === 'ok' ? 'ready' : 'not_set_up', row.status === 'ok' ? null : 'Adopted from a connection that had not been checked or was not working. Use Test to check it.'],
        );
        const id = made.rows[0]?.id;
        if (!id) throw new Error('the runner insert answered no row');
        runnerId = id;
        await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1::uuid, $2::uuid)', [runnerId, row.team_id]);
        await tx.query('UPDATE app.hermes_connections SET runner_name = $2, updated_at = now() WHERE id = $1::uuid', [row.id, name]);
        await ctx.audit.emit(tx, { type: 'bot_runner.runner.created', workspaceId, runnerId, name, kind: 'hermes_gateway', adopted: true, actorId: tx.actor.id, at: at() });
        await announceAvailability(ctx, tx, runnerId, at());
      }
      const [runner] = await presentRunners(ctx, tx, [await loadRunner(tx, runnerId)]);
      return json(AdoptConnectionResponse.parse({ runner }), 201);
    }),
  });
}

async function announceAvailability(ctx: PluginContext, tx: PluginTx, runnerId: string, at: string): Promise<void> {
  const r = (await tx.query<{ workspace_id: string; name: string; enabled: boolean; all_teams: boolean; teams: number }>(
    `SELECT r.workspace_id, r.name, r.enabled, r.all_teams, (SELECT count(*)::int FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id) AS teams FROM app.bot_runners r WHERE r.id = $1::uuid`,
    [runnerId],
  )).rows[0];
  if (!r) return;
  await ctx.audit.emit(tx, { type: 'bot_runner.availability.changed', workspaceId: r.workspace_id, runnerId, name: r.name, enabled: r.enabled, allTeams: r.all_teams, teamCount: r.all_teams ? 0 : r.teams, actorId: tx.actor.id, at });
}
