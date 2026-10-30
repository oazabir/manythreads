import type { LlmAliasTest, OnboardingState } from '@manythreads/shared';

/*
 * The setup checklist's logic (PLAN P10-01, SPEC §16), pure so vitest pins it. Each step's "done" comes from a fact the owning page already holds
 * (a model alias that answered a test call after its last change, an enabled sign-in method, a team, Brain on it, a project, a runner, the page
 * served over HTTPS, the first goal sent), never from a click. The only things a person can record are decisions: "sign-in is password only" and
 * "we do not need this optional step". A step that is a fact cannot be set aside.
 */

export type StepId = 'bootstrap' | 'signin' | 'models' | 'code' | 'infrastructure' | 'teams' | 'bots' | 'servers' | 'launch';
export type StepStatus = 'done' | 'todo' | 'skipped';

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
  teamBots: Record<string, Array<{ slug: string }>> | null;
  /** Projects across the teams; null while unknown. */
  projects: number | null;
  /** Runners across the teams; null while unknown. */
  runners: number | null;
  /** The page is open over HTTPS. */
  secure: boolean;
  state: OnboardingState;
}

export interface OnboardingStep {
  id: StepId;
  /** The SPEC §16 step number. */
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
  /** Every required step is done and the first goal was sent: the checklist may be put away. */
  finished: boolean;
  dismissed: boolean;
  /** The first required step that is not done yet; null once every required step is done. */
  next: OnboardingStep | null;
  firstTeam: { id: string; slug: string; name: string } | null;
  brainChat: string | null;
}

/** The aliases the shipped Brain asks for (`model.aliases` in the templates' BOT.md): a model that answers on another alias does not make Brain able to answer. */
const BRAIN_ALIASES: readonly string[] = ['smart', 'fast'];

const markOf = (state: OnboardingState, step: string) => state.marks.find((m) => m.step === step);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function onboardingSteps(input: OnboardingInput): OnboardingSummary {
  // The team the checklist talks about: the one that has Brain, else the first by name (the one to fix).
  const withBrain = input.teams.find((t) => (input.teamBots?.[t.slug] ?? []).some((b) => b.slug === 'brain')) ?? null;
  const first = withBrain ?? input.teams[0] ?? null;
  const brain = withBrain !== null;
  const passing = input.tests.filter((t) => t.outcome === 'ok' && t.current).map((t) => t.alias);
  const failing = input.tests.filter((t) => t.outcome === 'failed' && t.current).map((t) => t.alias);
  const stale = input.tests.filter((t) => !t.current).map((t) => t.alias);
  const signinMark = markOf(input.state, 'signin');

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
    if (passing.length > 0) return `${passing.join(', ')} answered, but Brain uses smart and fast. Connect and test one of those.`;
    if (input.llmProviders === 0) return 'Add a model provider and its key first. Bots cannot answer without one.';
    if (input.boundAliases.length === 0) return 'Connect the smart alias to a model, then test it.';
    if (failing.length > 0) return `The last test of ${failing.join(', ')} failed. The cause is shown below.`;
    if (stale.length > 0) return `${stale.join(', ')} changed since its last test. Test it again.`;
    return 'Test an alias to prove a model answers. A saved key is not a working key.';
  };

  const steps: OnboardingStep[] = [
    build('bootstrap', 0, 'Sign in as the workspace owner', true, false, '/settings/workspace/general', `${input.workspaceName} exists and you are signed in as its admin.`),
    build(
      'signin',
      1,
      'Sign-in methods',
      input.enabledSignInProviders > 0 || signinMark?.kind === 'acknowledged',
      false,
      '/settings/workspace/sign-in',
      input.enabledSignInProviders > 0
        ? `${plural(input.enabledSignInProviders, 'single sign-on method')} switched on. Admins keep a password as a way in if it fails.`
        : signinMark?.kind === 'acknowledged'
          ? 'You confirmed that everyone signs in with a password.'
          : 'Add Google or Microsoft sign-in so people do not need passwords, or confirm that passwords are what you want.',
    ),
    build('models', 2, 'Models', passing.some((a) => BRAIN_ALIASES.includes(a)), false, '/settings/workspace/llm', modelsHint()),
    build(
      'code',
      3,
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
      'infrastructure',
      4,
      'Domain and HTTPS',
      input.secure,
      true,
      '/settings/workspace/https',
      input.secure
        ? 'This workspace is served over HTTPS. Open the page for the full checks.'
        : 'Optional. Serve the workspace over HTTPS through Cloudflare or with a Let’s Encrypt certificate. A private trial runs fine without it.',
    ),
    build(
      'teams',
      5,
      'Teams',
      input.teams.length > 0,
      false,
      '/teams',
      input.teams.length > 0 ? `${plural(input.teams.length, 'team')}: ${input.teams.map((t) => t.name).join(', ')}.` : 'Create your first team from a template.',
    ),
    build(
      'bots',
      6,
      'Bots',
      brain,
      false,
      first ? `/t/${first.slug}/bots` : '/teams',
      !first
        ? 'Create a team first. Its template brings the default bots.'
        : input.teamBots === null
          ? `Reading ${first.name}'s bots…`
          : brain
            ? `Brain is on ${first.name}.`
            : `${first.name} has no Brain yet. Add it from a team template.`,
    ),
    build(
      'servers',
      7,
      'Servers',
      (input.runners ?? 0) > 0,
      true,
      null,
      (input.runners ?? 0) > 0
        ? `${plural(input.runners ?? 0, 'runner')} registered. A runner is a program on your own server that runs bots' commands there.`
        : 'Optional. A runner is a program you start on your own server so bots can run commands there. None is registered yet.',
    ),
    build(
      'launch',
      8,
      'Your first goal',
      input.state.launch !== null,
      false,
      first ? `/t/${first.slug}/bots/brain/chat` : null,
      input.state.launch !== null
        ? 'Your first question went to Brain.'
        : brain
          ? 'Ask Brain a question and read its answer.'
          : 'Brain has to be on a team first. Finish the steps above.',
    ),
  ];

  const handled = steps.filter((s) => s.status !== 'todo').length;
  const requiredLeft = steps.filter((s) => s.status === 'todo' && !s.optional);
  return {
    steps,
    handled,
    total: steps.length,
    finished: requiredLeft.length === 0,
    dismissed: input.state.dismissedAt !== null,
    next: requiredLeft[0] ?? null,
    firstTeam: first,
    brainChat: first && brain ? `/t/${first.slug}/bots/brain/chat` : null,
  };
}
