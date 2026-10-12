import { fetchLlmAliases, fetchLlmLimits, fetchLlmProviders, fetchLlmSettings, fetchTeams } from '../../../api/endpoints';
import { useQuery } from '../../../app/useQuery';
import { QueryView } from '../../../components/states';
import { AliasesSection } from './Aliases';
import { GuardSection } from './Guard';
import { LimitsSection } from './Limits';
import { ProvidersSection } from './Providers';
import { SpendSection } from './Spend';

/*
 * Workspace → LLM (SPEC §10.1, PLAN P5-08 — `[proto §01 plate 7 · After onboarding · Workspace → LLM]`). The page an
 * owner or admin opens to point the workspace at models and to put a ceiling on what those models may cost.
 *
 * Four of the five sections are the gateway's own vocabulary, read from `@manythreads/shared` rather than re-listed here:
 * the eight aliases a BOT.md speaks (`LLM_ALIASES`), the four guard presets (`LLM_GUARD_PRESETS`), the four budget scopes
 * and the spend rollup. So this page and the plugin that enforces them cannot drift apart on what `smart` is called or
 * what `air-gapped` does.
 *
 * Everything on it is admin-only, at the route (`AdminOnly`), in the settings nav (an admin's group only) and on the
 * server (every route answers 404 to anyone else). The page loads its five reads together so the sections agree on one
 * picture, and a write in any section reloads the whole page: a new provider changes the alias dropdowns, an alias
 * change changes the fallback chains, and a limit changes what the other rows mean.
 */

export function LlmSettings() {
  const q = useQuery('llm-settings-page', async () => {
    const [providers, aliases, limits, settings, teams] = await Promise.all([
      fetchLlmProviders(),
      fetchLlmAliases(),
      fetchLlmLimits(),
      fetchLlmSettings(),
      fetchTeams(),
    ]);
    return {
      providers: providers.providers,
      aliases: aliases.aliases,
      limits: limits.limits,
      settings: settings.settings,
      teams: teams.teams,
    };
  });

  return (
    <>
      <h1 className="pane-title">LLM</h1>
      <p className="lede">
        Which models this workspace may call, what a bot asks for by name, and the limits the gateway enforces before a
        call leaves it. Every change here is pushed to the gateway for this workspace only.
      </p>
      <QueryView q={q}>
        {(data) => (
          <>
            <ProvidersSection providers={data.providers} reload={q.reload} />
            <AliasesSection providers={data.providers} aliases={data.aliases} reload={q.reload} />
            <LimitsSection limits={data.limits} teams={data.teams} reload={q.reload} />
            <GuardSection settings={data.settings} reload={q.reload} />
            <SpendSection teams={data.teams} />
          </>
        )}
      </QueryView>
    </>
  );
}
