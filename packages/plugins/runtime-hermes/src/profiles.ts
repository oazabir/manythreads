import type { GatewayProfileSpec, HermesProfilesProvider, PluginContext, PluginLogger } from '@manythreads/sdk';
import { MANAGED_CONNECTION_NAME } from '@manythreads/shared';
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

export function createProfilesProvider(ctx: PluginContext, log: PluginLogger, env: ManagedEnv): HermesProfilesProvider & { notify(teamId: string): void } {
  const listeners = new Set<(change: { teamId: string }) => void>();
  return {
    id: 'hermes.profiles',

    async profilesForTeam(teamId: string): Promise<GatewayProfileSpec[]> {
      return ctx.db.system(async (tx) => {
        const bots = await tx.query<RunBotRow>(
          `SELECT id, slug, name, runtime, definition_sha, team_id, workspace_id, status
             FROM app.bots
            WHERE team_id = $1::uuid AND status = 'active' AND placement -> 'gateway' ->> 'connection' = $2
            ORDER BY slug`,
          [teamId, MANAGED_CONNECTION_NAME],
        );
        const llm = ctx.providers.get<LlmDoor>('llm');
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
          const wantsShell = (definition.frontmatter.capabilities?.runtime ?? []).includes('shell');
          const files = renderGatewayProfile(
            { frontmatter: definition.frontmatter, body: definition.body },
            {
              botSlug: bot.slug,
              mcpUrl: `${env.serverUrl}/api/mcp/bots/${bot.id}`,
              mcpTokenVar: GATEWAY_ENV.mcpToken,
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
