import type { LlmAliasTest, OnboardingState } from '@manythreads/shared';

/*
 * The setup wizard's logic (PLAN P10-01, SPEC §16; Phase 27, docs/plans/onboarding-journey.md §5), pure so vitest pins it. Each step's "done" comes from a
 * fact the owning page already holds (a model alias that answered a test call after its last change, an enabled sign-in method, a team, a runner that
 * answered a real question, Brain on it, a project, the page served over HTTPS, the first goal sent), never from a click. The only things a person can
 * record are decisions ("sign-in is password only", "keep this theme", "we do not need this optional step") and two proofs the wizard made (a runner
 * answered a test turn; the first delivery was started).
 *
 * Seven steps are required and hold the checklist open: the first sign-in, the organization, the models, the teams, a working runner, the bots' places
 * and Brain's answer. The rest are optional and never do.
 */

export type StepId =
  | 'bootstrap'
  | 'theme'
  | 'organization'
  | 'infrastructure'
  | 'models'
  | 'signin'
  | 'teams'
  | 'servers'
  | 'runners'
  | 'bots'
  | 'code'
  | 'launch'
  | 'delivery';
export type StepStatus = 'done' | 'todo' | 'skipped';

/** What the wizard knows of one runner (an admin's view; the list is admin-only like the wizard). */
export interface RunnerFact {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  /** The runner's own state word (`ready`, `not_set_up`, `waiting_for_sign_in`, …). */
  status: string;
  isDefault: boolean;
}

export interface OnboardingInput {
  workspaceName: string;
  enabledSignInProviders: number;
  /** Model providers that exist (any key, tried or not). */
  llmProviders: number;
  /** Aliases that are bound to a model. */
  boundAliases: string[];
  /** The newest test call of each alias, as the server reports it. */
  tests: Array<Pick<LlmAliasTest, 'alias' | 'outcome' | 'current'>>;
  teams: Array<{ id: string; slug: string; name: string }>;
  /** Each team's bots by team slug; null while the rosters have not loaded. */
  teamBots: Record<string, Array<{ slug: string; status?: string }>> | null;
  /** Projects across the teams; null while unknown. */
  projects: number | null;
  /** Runners registered by a team's own members, across the teams (the old Servers fact); null while unknown. */
  runners: number | null;
  /** The page is open over HTTPS. */
  secure: boolean;
  state: OnboardingState;
  /** The palette the signed-in admin uses (`classic` until they pick another). */
  palette?: string;
  /** Every runner the admins made; null while unknown. */
  adminRunners?: RunnerFact[] | null;
  /** Enrolled servers that are connected now; null while unknown. */
  connectedServers?: number | null;
  /** Templates that exist (to say how many teams are left to make); null while unknown. */
  templates?: number | null;
  /** The team template ids already made. */
  madeTemplates?: string[];
  /** The Brain question's thread has a run that ended with an answer; null when unknown or not asked yet. */
  launchAnswered?: boolean | null;
  /** A card of the first delivery is done and carries a pull request; null when unknown or not started. */
  deliveryDone?: boolean | null;
}

export interface OnboardingStep {
  id: StepId;
  /** The step's number on screen (0 to 12). */
  n: number;
  title: string;
  status: StepStatus;
  done: boolean;
  /** An optional step never holds the checklist open. */
  optional: boolean;
  /** Where the page that does the work is; null when there is no page for it yet. */
  to: string | null;
  hint: string;
}

export interface OnboardingSummary {
  steps: OnboardingStep[];
  /** Steps done or set aside. */
  handled: number;
  total: number;
  /** Every required step is done: the checklist may be put away. */
  finished: boolean;
  dismissed: boolean;
  /** The first required step that is not done yet; null once every required step is done. */
  next: OnboardingStep | null;
  /** The step after `id` that is still to do (required ones first), for the "Continue" button; null when none is left. */
  after: (id: StepId) => OnboardingStep | null;
  firstTeam: { id: string; slug: string; name: string } | null;
  brainChat: string | null;
}

/** The alias the shipped Brain runs on: its definition names no model, so the default alias answers. A model on another alias does not make Brain able to answer. */
const BRAIN_ALIASES: readonly string[] = ['smart'];
/** The name the installer gives a new organization; the step is done when the admin has chosen their own. */
export const DEFAULT_WORKSPACE_NAME = 'My organization';

const markOf = (state: OnboardingState, step: string) => state.marks.find((m) => m.step === step);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A runner that can run a bot now: switched on and in the state `ready`. */
export const isWorkingRunner = (r: RunnerFact): boolean => r.enabled && r.status === 'ready';

/** The runner the wizard proved with a real answer, when it is still working; null otherwise. */
export function provenRunner(runners: readonly RunnerFact[] | null | undefined, state: OnboardingState): RunnerFact | null {
  const proof = markOf(state, 'runners');
  if (!proof || proof.kind !== 'checked' || proof.refId == null) return null;
  const r = (runners ?? []).find((x) => x.id === proof.refId);
  return r && isWorkingRunner(r) ? r : null;
}

export function onboardingSteps(input: OnboardingInput): OnboardingSummary {
  // The team the checklist talks about: the one that has Brain, else the first by name (the one to fix).
  const withBrain = input.teams.find((t) => (input.teamBots?.[t.slug] ?? []).some((b) => b.slug === 'brain')) ?? null;
  const first = withBrain ?? input.teams[0] ?? null;
  const brain = withBrain !== null;
  const passing = input.tests.filter((t) => t.outcome === 'ok' && t.current).map((t) => t.alias);
  const failing = input.tests.filter((t) => t.outcome === 'failed' && t.current).map((t) => t.alias);
  const stale = input.tests.filter((t) => !t.current).map((t) => t.alias);
  const signinMark = markOf(input.state, 'signin');
  const runners = input.adminRunners ?? null;
  const proven = provenRunner(runners, input.state);
  const working = (runners ?? []).filter(isWorkingRunner);
  const defaultRunner = (runners ?? []).find((r) => r.isDefault && r.enabled) ?? null;
  const modelsOk = passing.some((a) => BRAIN_ALIASES.includes(a));

  const build = (
    id: StepId,
    n: number,
    title: string,
    fact: boolean,
    optional: boolean,
    to: string | null,
    hint: string,
  ): OnboardingStep => {
    const skipped = !fact && optional && markOf(input.state, id) !== undefined;
    const status: StepStatus = fact ? 'done' : skipped ? 'skipped' : 'todo';
    return { id, n, title, status, done: fact, optional, to, hint };
  };

  const modelsHint = (): string => {
    const forBrain = passing.filter((a) => BRAIN_ALIASES.includes(a));
    if (forBrain.length > 0) return `${forBrain.join(', ')} answered a test call.`;
    if (passing.length > 0) return `${passing.join(', ')} answered, but Brain uses smart. Connect and test that one.`;
    if (input.llmProviders === 0) return 'Pick a provider and paste its key. Bots cannot answer without a model.';
    if (input.boundAliases.length === 0) return 'Connect the smart alias to a model, then test it.';
    if (failing.length > 0) return `The last test of ${failing.join(', ')} failed. The cause is shown below.`;
    if (stale.length > 0) return `${stale.join(', ')} changed since its last test. Test it again.`;
    return 'Test an alias to prove a model answers. A saved key is not a working key.';
  };

  const runnersHint = (): string => {
    if (runners === null) return 'Reading the runners…';
    if (proven) return `${proven.name} answered a real question.`;
    if (working.length > 0) return 'A runner is ready. Ask it one real question to prove it works.';
    if (runners.length === 0) return 'No bot can run yet: nothing is set up to run it. Choose where bots work, or let the wizard deploy a Hermes pod for you.';
    return 'None of the runners is ready yet. The reason is shown on its row.';
  };

  const botsHint = (): string => {
    if (!first) return 'Create a team first. Its template brings the default bots.';
    if (input.teamBots === null) return `Reading ${first.name}'s bots…`;
    if (!brain) return `${first.name} has no Brain yet. Add it from a team template.`;
    if (defaultRunner === null && runners !== null) return `Brain is on ${first.name}, but no runner is the default yet, so its bots have nowhere to run.`;
    return `Brain is on ${first.name}${defaultRunner ? ` and bots run on ${defaultRunner.name} unless a bot says otherwise` : ''}.`;
  };

  const teamsHint = (): string => {
    if (input.teams.length === 0) return 'Create your first team from a template.';
    const left = input.templates != null ? Math.max(0, input.templates - (input.madeTemplates ?? []).length) : 0;
    const names = `${plural(input.teams.length, 'team')}: ${input.teams.map((t) => t.name).join(', ')}.`;
    return left > 0 ? `${names} ${plural(left, 'template')} not made yet; make them from here when you want them.` : names;
  };

  const launched = input.state.launch !== null;
  const launchDone = launched && (input.state.launch?.messageId == null || input.launchAnswered !== false);
  const delivery = markOf(input.state, 'delivery');

  const steps: OnboardingStep[] = [
    build('bootstrap', 0, 'Your sign-in', true, false, '/settings/workspace/general', `${input.workspaceName} exists and you are signed in as its admin.`),
    build(
      'theme',
      1,
      'Pick a look',
      (input.palette ?? 'classic') !== 'classic' || markOf(input.state, 'theme') !== undefined,
      true,
      '/account/appearance',
      (input.palette ?? 'classic') !== 'classic' ? `You chose the ${input.palette} look. Change it any time in Appearance.` : 'Optional. Try the looks and keep the one you like; it is yours, everyone picks their own.',
    ),
    build(
      'organization',
      2,
      'Your organization',
      input.workspaceName.trim() !== '' && input.workspaceName.trim() !== DEFAULT_WORKSPACE_NAME,
      false,
      '/settings/workspace/general',
      input.workspaceName.trim() !== '' && input.workspaceName.trim() !== DEFAULT_WORKSPACE_NAME
        ? `Your organization is called ${input.workspaceName}.`
        : 'Name your organization and choose its time zone.',
    ),
    build(
      'infrastructure',
      3,
      'Address and HTTPS',
      input.secure,
      true,
      '/settings/workspace/https',
      input.secure
        ? 'This site is served over HTTPS.'
        : 'Optional. See how people reach this site and move it to your own domain when you have one. A private trial runs fine without it.',
    ),
    build('models', 4, 'Models', modelsOk, false, '/settings/workspace/llm', modelsHint()),
    build(
      'signin',
      5,
      'Sign-in methods',
      input.enabledSignInProviders > 0 || signinMark?.kind === 'acknowledged',
      true,
      '/settings/workspace/sign-in',
      input.enabledSignInProviders > 0
        ? `${plural(input.enabledSignInProviders, 'single sign-on method')} switched on. Admins keep a password as a way in if it fails.`
        : signinMark?.kind === 'acknowledged'
          ? 'You confirmed that everyone signs in with a password.'
          : 'Optional. Add Google or Microsoft sign-in so people do not need passwords, or confirm that passwords are what you want.',
    ),
    build('teams', 6, 'Teams', input.teams.length > 0, false, '/teams', teamsHint()),
    build(
      'servers',
      7,
      'Servers',
      (input.connectedServers ?? 0) > 0 || (input.runners ?? 0) > 0,
      true,
      '/settings/workspace/runners',
      (input.connectedServers ?? 0) > 0
        ? `${plural(input.connectedServers ?? 0, 'server')} connected. A server is a machine of your own where bots can run agents such as Claude Code.`
        : 'Optional. Add a machine of your own so bots can run agents there. None is connected yet.',
    ),
    build('runners', 8, 'Runners', proven !== null, false, '/settings/workspace/runners', runnersHint()),
    build('bots', 9, 'Where bots run', brain && defaultRunner !== null, false, first ? `/t/${first.slug}/bots` : '/teams', botsHint()),
    build(
      'code',
      10,
      'Code',
      (input.projects ?? 0) > 0,
      true,
      first ? `/t/${first.slug}/projects` : '/teams',
      (input.projects ?? 0) > 0
        ? `${plural(input.projects ?? 0, 'project')} connected to ${first?.name ?? 'your team'}.`
        : first
          ? 'Optional. Connect a Git repository so bots can read and change code. Skip it if this team has none.'
          : 'Optional. Create a team first, then connect its Git repository.',
    ),
    build(
      'launch',
      11,
      'Check that Brain answers',
      launchDone,
      false,
      first ? `/t/${first.slug}/bots/brain/chat` : null,
      launchDone
        ? 'Brain answered your question.'
        : launched
          ? 'Your question went to Brain. Wait for its answer; if none comes, the cause is shown below.'
          : brain
            ? 'Ask Brain a question and read its answer.'
            : 'Brain has to be on a team first. Finish the steps above.',
    ),
    build(
      'delivery',
      12,
      'A first delivery',
      input.deliveryDone === true,
      true,
      first ? `/t/${first.slug}/tasks` : null,
      input.deliveryDone === true
        ? 'The Engineer delivered a small change and opened a pull request.'
        : delivery?.kind === 'started'
          ? 'The Engineer is working on it. Watch the steps below.'
          : 'Optional. Give the Engineer a small job on a starter repository and watch the team deliver it.',
    ),
  ];

  const handled = steps.filter((s) => s.status !== 'todo').length;
  const requiredLeft = steps.filter((s) => s.status === 'todo' && !s.optional);
  const todo = steps.filter((s) => s.status === 'todo');
  return {
    steps,
    handled,
    total: steps.length,
    finished: requiredLeft.length === 0,
    dismissed: input.state.dismissedAt !== null,
    next: requiredLeft[0] ?? null,
    after: (id) => {
      const at = steps.findIndex((s) => s.id === id);
      return todo.find((s) => steps.indexOf(s) > at && !s.optional) ?? todo.find((s) => steps.indexOf(s) > at) ?? null;
    },
    firstTeam: first,
    brainChat: first && brain ? `/t/${first.slug}/bots/brain/chat` : null,
  };
}
