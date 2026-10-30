import { forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  EGRESS_HOST_MAX_LENGTH,
  LLM_PROVIDER_DOMAINS,
  ListTeamEgressResponse,
  SetTeamEgressRequest,
  SetTeamEgressResponse,
  isProviderHost,
  listTeamEgressRoute,
  normalizeEgressHost,
  setTeamEgressRoute,
  type TeamEgress,
} from '@manythreads/shared';
import { z } from 'zod';

// Workspace > Data protection, the reachable-hosts half (PLAN P10-04): each team's list of hosts its bots may reach and an optional proxy address.
// Workspace owners and admins only. A model provider's domain can not be put on a team's list (see `isProviderHost`): a model call is judged by the
// workspace's model setup, and a team list that named a provider would be a way round it.

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can manage which hosts a team may reach.');
}

interface TeamRow {
  team_id: string;
  team_name: string;
  enforce: boolean | null;
  hosts: string[] | null;
  proxy_url: string | null;
  updated_at: Date | string | null;
  [key: string]: unknown;
}

const toTeam = (row: TeamRow): TeamEgress =>
  ({
    teamId: row.team_id,
    teamName: row.team_name,
    enforce: row.enforce ?? false,
    hosts: row.hosts ?? [],
    proxyUrl: row.proxy_url,
    updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
  }) as TeamEgress;

const TEAM_SELECT = `SELECT t.id AS team_id, t.name AS team_name, e.enforce, e.hosts, e.proxy_url, e.updated_at
  FROM app.teams t LEFT JOIN app.team_egress e ON e.team_id = t.id`;

/** The workspace's model setup, when the model gateway is installed: the hosts of its providers (also off limits to a team list), its allowlist and preset. */
async function workspaceModelSetup(tx: PluginTx, workspaceId: string): Promise<{ providerHosts: string[]; allowlist: string[]; preset: string }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_providers') IS NOT NULL AND to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { providerHosts: [], allowlist: [], preset: 'standard' };
  const providers = (await tx.query<{ api_base: string | null }>('SELECT api_base FROM app.llm_providers WHERE workspace_id = $1::uuid AND api_base IS NOT NULL', [workspaceId])).rows;
  const providerHosts: string[] = [];
  for (const { api_base } of providers) {
    try {
      const host = new URL(api_base as string).hostname.toLowerCase();
      if (host) providerHosts.push(host);
    } catch {
      // an address that is not a URL names no host
    }
  }
  const settings = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { providerHosts, allowlist: settings?.egress_allowlist ?? [], preset: settings?.preset ?? 'standard' };
}

const TeamParams = z.object({ teamId: z.uuid() });

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listTeamEgressRoute.method,
    path: listTeamEgressRoute.path,
    schema: { response: ListTeamEgressResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const workspaceId = tx.actor.workspaceId;
      const rows = (await tx.query<TeamRow>(`${TEAM_SELECT} WHERE t.workspace_id = $1::uuid AND t.archived_at IS NULL ORDER BY lower(t.name), t.id`, [workspaceId])).rows;
      const setup = await workspaceModelSetup(tx, workspaceId);
      return json({ teams: rows.map(toTeam), workspaceHosts: setup.allowlist, preset: setup.preset, providerDomains: [...LLM_PROVIDER_DOMAINS, ...setup.providerHosts] });
    }),
  });

  ctx.http.route({
    method: setTeamEgressRoute.method,
    path: setTeamEgressRoute.path,
    schema: { body: SetTeamEgressRequest, response: SetTeamEgressResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { teamId } = TeamParams.parse(req.params);
      const body = SetTeamEgressRequest.parse(req.body);
      const workspaceId = tx.actor.workspaceId;
      const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE id = $1::uuid AND workspace_id = $2::uuid', [teamId, workspaceId])).rows[0];
      if (!team) throw notFound('There is no such team.');

      const hosts: string[] = [];
      const setup = await workspaceModelSetup(tx, workspaceId);
      for (const raw of body.hosts) {
        const host = normalizeEgressHost(raw);
        if (host === null) throw invalid(`"${raw.slice(0, 60)}" is not a host name. Write it like api.example.com, without a path.`);
        if (isProviderHost(host, setup.providerHosts)) {
          throw invalid(`${host} belongs to a model provider. Model calls follow the workspace's model setup and cannot be allowed here; list only other hosts a team's bots need.`);
        }
        if (host.length > EGRESS_HOST_MAX_LENGTH) throw invalid('A host name is at most 253 characters.');
        if (!hosts.includes(host)) hosts.push(host);
      }
      hosts.sort();

      const before = (await tx.query<{ enforce: boolean; hosts: string[]; proxy_url: string | null }>('SELECT enforce, hosts, proxy_url FROM app.team_egress WHERE team_id = $1::uuid', [teamId])).rows[0];
      const changed = !before || before.enforce !== body.enforce || before.proxy_url !== body.proxyUrl || before.hosts.length !== hosts.length || before.hosts.some((h, i) => h !== hosts[i]);
      if (changed) {
        await tx.query(
          `INSERT INTO app.team_egress (team_id, workspace_id, enforce, hosts, proxy_url, updated_by, updated_at) VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, $6::uuid, now())
           ON CONFLICT (team_id) DO UPDATE SET enforce = EXCLUDED.enforce, hosts = EXCLUDED.hosts, proxy_url = EXCLUDED.proxy_url, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [teamId, workspaceId, body.enforce, hosts, body.proxyUrl, tx.actor.id],
        );
        await ctx.audit.emit(tx, {
          type: 'guardrails.policy.updated',
          workspaceId,
          kind: 'egress',
          change: 'team_list',
          subject: null,
          teamId,
          changedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      const row = (await tx.query<TeamRow>(`${TEAM_SELECT} WHERE t.id = $1::uuid`, [teamId])).rows[0] as TeamRow;
      return json({ team: toTeam(row) });
    }),
  });
}
