import { useEffect, useRef } from 'react';
import type { LlmAliasTest, OnboardingState } from '@manythreads/shared';
import {
  fetchLlmAliasTests,
  fetchLlmAliases,
  fetchLlmProviders,
  fetchOidcProviders,
  fetchOnboarding,
  fetchRunners,
  fetchTeams,
  fetchWorkspace,
} from '../../api/endpoints';
import { useQuery, type QueryState } from '../../app/useQuery';
import { fetchBots } from '../bots/api';
import { fetchProjects } from '../projects/api';
import { onboardingSteps, type OnboardingSummary } from './steps';

/*
 * Reads the facts the setup checklist is derived from, each from the page that owns it, and hands them to the pure `onboardingSteps`. The wizard
 * reads everything; the sidebar card reads the checklist's own state first and stops there once it was put away (one request for most people on most
 * days). Anything that changes a fact calls `announceOnboardingChange()` so the card and the wizard read again.
 */

const CHANGED = 'mt:onboarding-changed';
export const announceOnboardingChange = (): void => {
  window.dispatchEvent(new Event(CHANGED));
};

/** A model alias that is connected to a model. */
export interface BoundAlias {
  alias: string;
  model: string;
}

export type OnboardingView =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ok'; summary: OnboardingSummary; tests: LlmAliasTest[]; aliases: BoundAlias[]; reload: () => void; hasProviders: boolean; state: OnboardingState };

const MAX_TEAMS_READ = 8;

interface TeamFacts {
  bots: Record<string, Array<{ slug: string }>>;
  projects: number;
  runners: number;
}

/** A result tagged with the key it was read for: the data hook keeps showing the previous result while a new key loads, and a tag that is not the current key is not an answer. */
interface Tagged<T> {
  tag: string;
  value: T;
}
const read = <T>(tag: string, on: boolean, load: () => Promise<T>, off: T): Promise<Tagged<T>> => (on ? load() : Promise.resolve(off)).then((value) => ({ tag, value }));

export function useOnboarding(mode: 'wizard' | 'card'): OnboardingView {
  const state = useQuery('ob-state', fetchOnboarding);
  // the card stops at the state once the checklist was put away; the wizard always reads everything
  const live = state.status === 'ok' && (mode === 'wizard' || state.data.state.dismissedAt === null);
  const key = live ? 'on' : 'off';
  const workspace = useQuery(`ob-workspace:${key}`, () => read(`ob-workspace:${key}`, live, () => fetchWorkspace().then((r) => r.workspace.name), ''));
  const oidc = useQuery(`ob-oidc:${key}`, () => read(`ob-oidc:${key}`, live, () => fetchOidcProviders().then((r) => r.providers.filter((p) => p.enabled).length), 0));
  const providers = useQuery(`ob-providers:${key}`, () => read(`ob-providers:${key}`, live, () => fetchLlmProviders().then((r) => r.providers.length), 0));
  const aliases = useQuery(`ob-aliases:${key}`, () => read(`ob-aliases:${key}`, live, () => fetchLlmAliases().then((r) => r.aliases.map((a) => ({ alias: a.alias as string, model: a.model as string }))), [] as BoundAlias[]));
  const tests = useQuery(`ob-tests:${key}`, () => read(`ob-tests:${key}`, live, () => fetchLlmAliasTests().then((r) => r.tests), [] as LlmAliasTest[]));
  const teams = useQuery(`ob-teams:${key}`, () => read(`ob-teams:${key}`, live, () => fetchTeams().then((r) => r.teams.map((t) => ({ id: t.id as string, slug: t.slug, name: t.name }))), [] as Array<{ id: string; slug: string; name: string }>));
  // Facts about the teams are read for the first few (by name); a workspace with more teams still gets an honest answer for those.
  const slugs = teams.status === 'ok' && teams.data.tag === `ob-teams:${key}` ? teams.data.value.slice(0, MAX_TEAMS_READ).map((t) => t.slug) : null;
  const sub = `${key}:${slugs === null ? 'none' : slugs.join(',')}`;
  const perTeam = useQuery(`ob-team-facts:${sub}`, () =>
    read(
      `ob-team-facts:${sub}`,
      live && slugs !== null && slugs.length > 0,
      async (): Promise<TeamFacts> => {
        const rows = await Promise.all(
          (slugs ?? []).map(async (slug) => {
            const [bots, projects, runners] = await Promise.all([fetchBots(slug), fetchProjects(slug), fetchRunners(slug)]);
            return { slug, bots: bots.bots.map((b) => ({ slug: b.slug })), projects: projects.items.length, runners: runners.items.length };
          }),
        );
        return {
          bots: Object.fromEntries(rows.map((r) => [r.slug, r.bots])),
          projects: rows.reduce((n, r) => n + r.projects, 0),
          runners: rows.reduce((n, r) => n + r.runners, 0),
        };
      },
      { bots: {}, projects: 0, runners: 0 },
    ),
  );

  const reads = [
    [workspace, `ob-workspace:${key}`],
    [oidc, `ob-oidc:${key}`],
    [providers, `ob-providers:${key}`],
    [aliases, `ob-aliases:${key}`],
    [tests, `ob-tests:${key}`],
    [teams, `ob-teams:${key}`],
    [perTeam, `ob-team-facts:${sub}`],
  ] as Array<[QueryState<Tagged<unknown>> & { reload: () => void }, string]>;
  const all = [state as QueryState<unknown> & { reload: () => void }, ...reads.map(([q]) => q as QueryState<unknown> & { reload: () => void })];
  const reload = (): void => all.forEach((q) => q.reload());
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    const on = (): void => reloadRef.current();
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, []);

  const failed = all.find((q) => q.status === 'error');
  if (failed && failed.status === 'error') return { status: 'error', error: failed.error };
  if (state.status !== 'ok') return { status: 'loading' };
  const settled = reads.every(([q, tag]) => q.status === 'ok' && q.data.tag === tag);
  if (!settled) return { status: 'loading' };
  const value = <T,>(q: QueryState<Tagged<T>>): T => (q as { data: Tagged<T> }).data.value;
  const summary = onboardingSteps({
    workspaceName: value(workspace),
    enabledSignInProviders: value(oidc),
    llmProviders: value(providers),
    boundAliases: value(aliases).map((a) => a.alias),
    tests: value(tests),
    teams: value(teams),
    teamBots: value(perTeam).bots,
    projects: value(perTeam).projects,
    runners: value(perTeam).runners,
    secure: window.location.protocol === 'https:',
    state: state.data.state,
  });
  return { status: 'ok', summary, tests: value(tests), aliases: value(aliases), reload, hasProviders: value(providers) > 0, state: state.data.state };
}
