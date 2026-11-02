import type { BotRunnersProvider, GatewayProfileSpec, HermesProfilesProvider, McpToolsProvider, PluginContext, PluginLogger } from '@manythreads/sdk';
import { MANAGED_CONNECTION_NAME, mcpUrlOf } from '@manythreads/shared';
import { GATEWAY_ENV, renderGatewayProfile } from './gateway-profile.ts';
import { managedProfileName } from './gateway.ts';
import { ensureProfileSecrets } from './profile-secrets.ts';
import { loadDefinition, type LlmDoor, type RunBotRow } from './run-job.ts';

// The `hermes.profiles` provider: the managed pod's view of the team's bots (mode B). A controller (the pods plugin) asks `profilesForTeam`
// for the profile of every bot placed on the managed gateway — files plus the three credentials each needs — and writes them into the pod.
// `setManagedGateway` tells the platform where the pod answers; `onChange` (and the `hermes.profiles.changed` event) says when to ask again.

export interface ManagedEnv {
  /** The server as the pod reaches it, e.g. `http://manythreads-server:3000` (MANYTHREADS_INCLUSTER_URL). */
  serverUrl: string;
  /** The LLM gateway as the pod reaches it, e.g. `http://manythreads-litellm:4000/v1` (MANYTHREADS_INCLUSTER_LLM_URL). */
  llmUrl: string;
  /** Where the bot's commands run when its definition grants a shell (MANYTHREADS_MANAGED_SSH_HOST / _USER / _CWD); absent: no terminal is rendered. */
  terminal?: { host: string; user: string; cwd: string };
}

export function managedEnvFrom(env: NodeJS.ProcessEnv): ManagedEnv {
  const trim = (v: string | undefined, fallback: string): string => ((v ?? '').trim() || fallback).replace(/\/+$/, '');
  const host = (env['MANYTHREADS_MANAGED_SSH_HOST'] ?? '').trim();
  return {
    serverUrl: trim(env['MANYTHREADS_INCLUSTER_URL'], 'http://manythreads-server:3000'),
    llmUrl: trim(env['MANYTHREADS_INCLUSTER_LLM_URL'], 'http://manythreads-litellm:4000/v1'),
    ...(host === ''
      ? {}
      : {
          terminal: {
            host,
            user: (env['MANYTHREADS_MANAGED_SSH_USER'] ?? 'hermes').trim() || 'hermes',
            cwd: (env['MANYTHREADS_MANAGED_SSH_CWD'] ?? '/workspace').trim() || '/workspace',
          },
        }),
  };
}

/**
 * Which of a team's bots live on the team's own pod: the ones placed on the reserved connection `managed`, the ones placed by `runs_on` on a pod runner the team may use, and (when
 * the workspace default runner is a pod runner) the Hermes bots with no place of their own (P19-03). The WHERE fragment takes three parameters from `$first`; `podPlacementParams` gives them.
 */
export const podPlacementWhere = (first: number): string =>
  `(placement -> 'gateway' ->> 'connection' = $${first}
     OR placement ->> 'runs_on' = ANY($${first + 1}::text[])
     OR ($${first + 2}::boolean AND runtime = 'hermes' AND NOT (coalesce(placement, '{}'::jsonb) ?| ARRAY['runs_on', 'gateway', 'node', 'runner'])))`;

/** The three parameters of `podPlacementWhere`, from what the catalog says about the team (pure). */
export function podPlacementParamsOf(info: { defaultRunner: string | null; podRunners: readonly string[] } | undefined): [string, string[], boolean] {
  const pods = [...(info?.podRunners ?? [])];
  return [MANAGED_CONNECTION_NAME, pods, info?.defaultRunner != null && pods.includes(info.defaultRunner)];
}

export async function podPlacementParams(ctx: PluginContext, teamId: string): Promise<[string, string[], boolean]> {
  return podPlacementParamsOf(await ctx.providers.get<BotRunnersProvider>('bot.runners')?.teamRunners({ teamId }));
}

/** The teams with at least one active bot on their own pod, by the one rule above (the pods controller reconciles exactly these). */
export async function teamsWithPodBots(ctx: PluginContext): Promise<Array<{ id: string; slug: string }>> {
  const teams = await ctx.db.system(async (tx) => (await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM app.teams WHERE archived_at IS NULL ORDER BY slug')).rows);
  const out: Array<{ id: string; slug: string }> = [];
  for (const team of teams) {
    const placement = await podPlacementParams(ctx, team.id);
    const has = await ctx.db.system(async (tx) =>
      (await tx.query(`SELECT 1 FROM app.bots WHERE team_id = $1::uuid AND status = 'active' AND ${podPlacementWhere(2)} LIMIT 1`, [team.id, ...placement])).rows.length > 0,
    );
    if (has) out.push(team);
  }
  return out;
}

export function createProfilesProvider(ctx: PluginContext, log: PluginLogger, env: ManagedEnv): HermesProfilesProvider & { notify(teamId: string): void } {
  const listeners = new Set<(change: { teamId: string }) => void>();
  return {
    id: 'hermes.profiles',

    teamsWithPodBots: () => teamsWithPodBots(ctx),

    async profilesForTeam(teamId: string): Promise<GatewayProfileSpec[]> {
      const placement = await podPlacementParams(ctx, teamId);
      return ctx.db.system(async (tx) => {
        const bots = await tx.query<RunBotRow>(
          `SELECT id, slug, name, runtime, definition_sha, team_id, workspace_id, status
             FROM app.bots
            WHERE team_id = $1::uuid AND status = 'active' AND ${podPlacementWhere(2)}
            ORDER BY slug`,
          [teamId, ...placement],
        );
        const llm = ctx.providers.get<LlmDoor>('llm');
        const teamName = (await tx.query<{ name: string }>('SELECT name FROM app.teams WHERE id = $1::uuid', [teamId])).rows[0]?.name ?? 'the team';
        const specs: GatewayProfileSpec[] = [];
        for (const bot of bots.rows) {
          const definition = await loadDefinition(ctx, tx, bot, log);
          if (!definition) continue;
          if (definition.alias === null) {
            log.warn(`runtime-hermes: bot ${bot.slug} is on the managed gateway but names no model alias; no profile`);
            continue;
          }
          const llmKey = await llm?.botKey(tx, bot.id);
          if (!llmKey) {
            log.warn(`runtime-hermes: bot ${bot.slug} has no LLM gateway key yet; no profile`);
            continue;
          }
          const secrets = await ensureProfileSecrets(ctx, bot);
          if ('revoked' in secrets) {
            log.warn(`runtime-hermes: the token of managed bot ${bot.slug} was turned off by a person; no profile until a lead re-enables it`);
            continue;
          }
          // The digest of what the platform offers this bot (its grants, their approval flags, the tools this version adds): the pod re-serves the profile when it
          // changes, for a Hermes that cannot be told by push. Without gateway-mcp the line falls back to the native grants.
          const toolsDigest = (await ctx.providers.get<McpToolsProvider>('mcp.tools')?.toolsDigest(bot.id)) ?? undefined;
          const wantsShell = (definition.frontmatter.capabilities?.runtime ?? []).includes('shell');
          const files = renderGatewayProfile(
            { frontmatter: definition.frontmatter, body: definition.body },
            {
              botSlug: bot.slug,
              teamName,
              ...(toolsDigest ? { toolsDigest } : {}),
              mcpUrl: mcpUrlOf(env.serverUrl),
              mcpTokenVar: GATEWAY_ENV.mcpToken,
              filesInWorkbench: true,
              model: { baseUrl: env.llmUrl, apiKeyVar: GATEWAY_ENV.llmKey, alias: definition.alias },
              ...(wantsShell && env.terminal ? { terminal: { backend: 'ssh' as const, ...env.terminal } } : {}),
            },
          );
          specs.push({
            profile: managedProfileName(bot.slug),
            botId: bot.id,
            files: { ...files },
            secrets: { MCP_TOKEN: secrets.mcpToken, LLM_KEY: llmKey, API_SERVER_KEY: secrets.apiKey },
          });
        }
        return specs;
      });
    },

    async setManagedGateway(teamId: string, input: { baseUrl: string }): Promise<void> {
      await ctx.db.system(async (tx) => {
        const team = (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.teams WHERE id = $1::uuid', [teamId])).rows[0];
        if (!team) throw new Error('no such team');
        await tx.query(
          `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, base_url)
           VALUES ($1::uuid, $2::uuid, 'managed', 'managed', $3)
           ON CONFLICT (team_id, name) DO UPDATE SET base_url = EXCLUDED.base_url, updated_at = now()`,
          [team.workspace_id, teamId, input.baseUrl.replace(/\/+$/, '')],
        );
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    notify(teamId: string): void {
      for (const listener of listeners) {
        try {
          listener({ teamId });
        } catch (err) {
          log.warn(`runtime-hermes: a hermes.profiles listener threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
