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
  fetchTemplates,
  fetchWorkspace,
} from '../../api/endpoints';
import { useSession } from '../../app/session';
import { useQuery, type QueryState } from '../../app/useQuery';
import { fetchThreadRuns } from '../../runs/api';
import { fetchBots } from '../bots/api';
import { fetchBotRunners } from '../admin/runners/api';
import { fetchBotServers } from '../admin/runners/servers-api';
import { fetchColumnTasks } from '../boards/api';
import { fetchProjects } from '../projects/api';
import { onboardingSteps, type OnboardingSummary, type RunnerFact } from './steps';

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
  | {
      status: 'ok';
      summary: OnboardingSummary;
      tests: LlmAliasTest[];
      aliases: BoundAlias[];
      reload: () => void;
      hasProviders: boolean;
      state: OnboardingState;
      /** What the steps that do work need to show: the organization, the runners, the teams made from which templates. */
      facts: WizardFacts;
    };

/** The raw facts the panels draw from, beside the summary the pure logic derives. */
export interface WizardFacts {
  workspace: { name: string; slug: string; timeZone: string | null };
  runners: RunnerFact[];
  teams: Array<{ id: string; slug: string; name: string; template: string | null }>;
  madeTemplates: string[];
}

const MAX_TEAMS_READ = 8;

interface TeamFacts {
  bots: Record<string, Array<{ slug: string; status?: string }>>;
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
  const session = useSession();
  const workspace = useQuery(
    `ob-workspace:${key}`,
    () =>
      read(`ob-workspace:${key}`, live, () => fetchWorkspace().then((r) => ({ name: r.workspace.name, slug: r.workspace.slug, timeZone: r.workspace.timeZone })), { name: '', slug: '', timeZone: null as string | null }),
  );
  const adminRunners = useQuery(
    `ob-runners:${key}`,
    () =>
      read(
        `ob-runners:${key}`,
        live,
        () =>
          fetchBotRunners().then((r) =>
            r.items.map((x): RunnerFact => ({ id: x.id as string, name: x.name, kind: x.kind, enabled: x.enabled, status: x.status, isDefault: x.isDefault })),
          ),
        [] as RunnerFact[],
      ),
  );
  const servers = useQuery(
    `ob-servers:${key}`,
    () => read(`ob-servers:${key}`, live, () => fetchBotServers().then((r) => r.items.filter((x) => x.status === 'connected').length), 0),
  );
  const templates = useQuery(`ob-template-count:${key}`, () => read(`ob-template-count:${key}`, live, () => fetchTemplates().then((r) => r.templates.length), 0));
  const oidc = useQuery(`ob-oidc:${key}`, () => read(`ob-oidc:${key}`, live, () => fetchOidcProviders().then((r) => r.providers.filter((p) => p.enabled).length), 0));
  const providers = useQuery(`ob-providers:${key}`, () => read(`ob-providers:${key}`, live, () => fetchLlmProviders().then((r) => r.providers.length), 0));
  const aliases = useQuery(`ob-aliases:${key}`, () => read(`ob-aliases:${key}`, live, () => fetchLlmAliases().then((r) => r.aliases.map((a) => ({ alias: a.alias as string, model: a.model as string }))), [] as BoundAlias[]));
  const tests = useQuery(`ob-tests:${key}`, () => read(`ob-tests:${key}`, live, () => fetchLlmAliasTests().then((r) => r.tests), [] as LlmAliasTest[]));
  const teams = useQuery(
    `ob-teams:${key}`,
    () =>
      read(
        `ob-teams:${key}`,
        live,
        () => fetchTeams().then((r) => r.teams.map((t) => ({ id: t.id as string, slug: t.slug, name: t.name, template: t.template }))),
        [] as Array<{ id: string; slug: string; name: string; template: string | null }>,
      ),
  );
  // The question put to Brain, and the first delivery, are each a thread: whether a run there ended with an answer, and whether a card carries a pull request, are read here.
  const launchRoot = state.status === 'ok' ? (state.data.state.launch?.messageId ?? null) : null;
  const answered = useQuery(
    `ob-launch-run:${key}:${launchRoot ?? 'none'}`,
    () =>
      read(
        `ob-launch-run:${key}:${launchRoot ?? 'none'}`,
        live && launchRoot !== null,
        () => fetchThreadRuns(launchRoot as string).then((r) => r.runs.some((x) => x.state === 'done')),
        null as boolean | null,
      ),
  );
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
            return { slug, bots: bots.bots.map((b) => ({ slug: b.slug, status: b.status })), projects: projects.items.length, runners: runners.items.length };
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

  const deliveryAt = state.status === 'ok' ? (state.data.state.marks.find((m) => m.step === 'delivery' && m.kind === 'started')?.markedAt ?? null) : null;
  const deliverySlugs = slugs !== null ? slugs.join(',') : 'none';
  const delivered = useQuery(
    `ob-delivery:${key}:${deliveryAt ?? 'none'}:${deliverySlugs}`,
    () =>
      read(
        `ob-delivery:${key}:${deliveryAt ?? 'none'}:${deliverySlugs}`,
        live && deliveryAt !== null && slugs !== null,
        async () => {
          const lists = await Promise.all((slugs ?? []).map((slug) => fetchColumnTasks(slug, {}).then((r) => r.items).catch(() => [])));
          return lists.flat().some((t) => t.pullRequest !== null && t.createdAt >= (deliveryAt as string));
        },
        null as boolean | null,
      ),
  );

  const reads = [
    [workspace, `ob-workspace:${key}`],
    [adminRunners, `ob-runners:${key}`],
    [servers, `ob-servers:${key}`],
    [templates, `ob-template-count:${key}`],
    [answered, `ob-launch-run:${key}:${launchRoot ?? 'none'}`],
    [delivered, `ob-delivery:${key}:${deliveryAt ?? 'none'}:${deliverySlugs}`],
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

  // A question put to Brain, and a first delivery, are answered later and nobody on the page announces it: while one is waiting, read again every few seconds.
  const answeredNow = answered.status === 'ok' ? (answered.data as { value: boolean | null }).value === true : false;
  const deliveredNow = delivered.status === 'ok' ? (delivered.data as { value: boolean | null }).value === true : false;
  const waiting = (launchRoot !== null && !answeredNow) || (deliveryAt !== null && !deliveredNow);
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(announceOnboardingChange, 5000);
    return () => window.clearInterval(id);
  }, [waiting]);

  const failed = all.find((q) => q.status === 'error');
  if (failed && failed.status === 'error') return { status: 'error', error: failed.error };
  if (state.status !== 'ok') return { status: 'loading' };
  const settled = reads.every(([q, tag]) => q.status === 'ok' && q.data.tag === tag);
  if (!settled) return { status: 'loading' };
  const value = <T,>(q: QueryState<Tagged<T>>): T => (q as { data: Tagged<T> }).data.value;
  const ws = value(workspace);
  const teamRows = value(teams);
  const summary = onboardingSteps({
    workspaceName: ws.name,
    enabledSignInProviders: value(oidc),
    llmProviders: value(providers),
    boundAliases: value(aliases).map((a) => a.alias),
    tests: value(tests),
    teams: teamRows.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
    teamBots: value(perTeam).bots,
    projects: value(perTeam).projects,
    runners: value(perTeam).runners,
    secure: window.location.protocol === 'https:',
    state: state.data.state,
    palette: session.person.appearance.palette,
    adminRunners: value(adminRunners),
    connectedServers: value(servers),
    templates: value(templates),
    madeTemplates: teamRows.flatMap((t) => (t.template ? [t.template] : [])),
    launchAnswered: value(answered),
    deliveryDone: value(delivered),
  });
  const facts: WizardFacts = { workspace: ws, runners: value(adminRunners), teams: teamRows, madeTemplates: teamRows.flatMap((t) => (t.template ? [t.template] : [])) };
  return { status: 'ok', summary, tests: value(tests), aliases: value(aliases), reload, hasProviders: value(providers) > 0, state: state.data.state, facts };
}
