import { describe, expect, it } from 'vitest';
import type { OnboardingState } from '@manythreads/shared';
import { DEFAULT_WORKSPACE_NAME, isWorkingRunner, onboardingSteps, provenRunner, type OnboardingInput, type RunnerFact } from '../src/screens/onboarding/steps';

/*
 * PLAN P10-01 and Phase 27: the setup wizard. Every step's "done" is a fact (a model that answered a test after its last change, an enabled sign-in method, a team,
 * a runner that answered a real question, Brain on it, a project, HTTPS, the first goal answered); the only things a person records are decisions and two proofs
 * the wizard made. The derivation is pure, so the gate pins it here; the screens are proven in Playwright like every other screen.
 */

const empty: OnboardingState = { marks: [], launch: null, dismissedAt: null, dismissedBy: null };
const at = '2026-10-30T08:00:00.000Z';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const mark = (step: 'signin' | 'theme' | 'code' | 'infrastructure' | 'servers' | 'delivery', kind: 'skipped' | 'acknowledged' | 'started', refId: string | null = null) => ({
  step,
  kind,
  markedAt: at,
  markedBy: null,
  refId,
});
const proof = { step: 'runners' as const, kind: 'checked' as const, markedAt: at, markedBy: null, refId: RUNNER_ID };
const team = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering', name: 'Engineering' };
const runner = (over: Partial<RunnerFact> = {}): RunnerFact => ({ id: RUNNER_ID, name: 'hermes', kind: 'hermes_pod', enabled: true, status: 'ready', isDefault: true, ...over });

const base: OnboardingInput = {
  workspaceName: DEFAULT_WORKSPACE_NAME,
  enabledSignInProviders: 0,
  llmProviders: 0,
  boundAliases: [],
  tests: [],
  teams: [],
  teamBots: {},
  projects: 0,
  runners: 0,
  secure: false,
  state: empty,
  palette: 'classic',
  adminRunners: [],
  connectedServers: 0,
  templates: 5,
  madeTemplates: [],
};

const done = (input: OnboardingInput): string[] => onboardingSteps(input).steps.filter((s) => s.status === 'done').map((s) => s.id);
const step = (input: OnboardingInput, id: string) => onboardingSteps(input).steps.find((s) => s.id === id)!;

/** Every required step is true: models answer, a team has Brain, a runner answered a real question, and the question to Brain was answered. */
const ready: OnboardingInput = {
  ...base,
  workspaceName: 'Kahf Software',
  llmProviders: 1,
  boundAliases: ['smart'],
  tests: [{ alias: 'smart', outcome: 'ok', current: true }],
  teams: [team],
  teamBots: { [team.slug]: [{ slug: 'brain' }] },
  adminRunners: [runner()],
  state: { ...empty, marks: [proof], launch: { at, by: null, teamId: team.id as never, channelId: team.id as never, messageId: null } },
};

describe('the setup wizard', () => {
  it('has the thirteen steps in order, and on a new install only the first sign-in is done', () => {
    const s = onboardingSteps(base);
    expect(s.steps.map((x) => x.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.steps.map((x) => x.id)).toEqual([
      'bootstrap', 'theme', 'organization', 'infrastructure', 'models', 'signin', 'teams', 'servers', 'runners', 'bots', 'code', 'launch', 'delivery',
    ]);
    expect(done(base)).toEqual(['bootstrap']);
    expect(s.finished).toBe(false);
    expect(s.next?.id).toBe('organization');
    expect(s.total).toBe(13);
  });

  it('holds the checklist open for exactly the required steps', () => {
    const required = onboardingSteps(base).steps.filter((s) => !s.optional).map((s) => s.id);
    expect(required).toEqual(['bootstrap', 'organization', 'models', 'teams', 'runners', 'bots', 'launch']);
  });

  it('marks the look done by another palette or by keeping Classic, and never otherwise', () => {
    expect(step(base, 'theme').done).toBe(false);
    expect(step({ ...base, palette: 'harbor' }, 'theme').done).toBe(true);
    expect(step({ ...base, state: { ...empty, marks: [mark('theme', 'acknowledged')] } }, 'theme').done).toBe(true);
  });

  it('marks the organization done once it has a name of its own', () => {
    expect(step(base, 'organization').done).toBe(false);
    expect(step({ ...base, workspaceName: 'Kahf Software' }, 'organization').done).toBe(true);
    expect(step({ ...base, workspaceName: '  ' }, 'organization').done).toBe(false);
  });

  it('marks sign-in done with one enabled method, or with the password-only confirmation, and no other way', () => {
    expect(step({ ...base, enabledSignInProviders: 1 }, 'signin').done).toBe(true);
    const ack = { ...base, state: { ...empty, marks: [mark('signin', 'acknowledged')] } };
    expect(step(ack, 'signin').done).toBe(true);
    expect(step(ack, 'signin').hint).toContain('password');
  });

  it('needs the smart alias to have answered after its last change, because Brain runs on it', () => {
    expect(step({ ...base, tests: [{ alias: 'fast', outcome: 'ok', current: true }] }, 'models').done).toBe(false);
    expect(step({ ...base, tests: [{ alias: 'smart', outcome: 'ok', current: false }] }, 'models').done).toBe(false);
    expect(step({ ...base, tests: [{ alias: 'smart', outcome: 'failed', current: true }] }, 'models').done).toBe(false);
    expect(step({ ...base, tests: [{ alias: 'smart', outcome: 'ok', current: true }] }, 'models').done).toBe(true);
  });

  it('counts a team, and names the templates not made yet', () => {
    expect(step(base, 'teams').done).toBe(false);
    const one = { ...base, teams: [team], madeTemplates: ['engineering'] };
    expect(step(one, 'teams').done).toBe(true);
    expect(step(one, 'teams').hint).toContain('4 templates not made yet');
  });

  it('is done for the servers step only when a server is connected or a team runner exists, and the step is optional', () => {
    expect(step(base, 'servers').optional).toBe(true);
    expect(step({ ...base, connectedServers: 1 }, 'servers').done).toBe(true);
    expect(step({ ...base, runners: 2 }, 'servers').done).toBe(true);
  });

  describe('the runner is required', () => {
    it('is not done by a ready runner alone: it has to have answered a real question', () => {
      const noProof = { ...ready, state: { ...ready.state, marks: [] } };
      expect(step(noProof, 'runners').done).toBe(false);
      expect(step(noProof, 'runners').hint).toContain('real question');
      expect(step(ready, 'runners').done).toBe(true);
    });

    it('is not done by a proof of a runner that was since switched off, removed or lost its sign-in', () => {
      expect(step({ ...ready, adminRunners: [runner({ enabled: false })] }, 'runners').done).toBe(false);
      expect(step({ ...ready, adminRunners: [runner({ status: 'needs_sign_in' })] }, 'runners').done).toBe(false);
      expect(step({ ...ready, adminRunners: [] }, 'runners').done).toBe(false);
      expect(step({ ...ready, adminRunners: [runner({ id: '33333333-3333-4333-8333-333333333333' })] }, 'runners').done).toBe(false);
    });

    it('says what to do when there is no runner at all', () => {
      expect(step({ ...base, adminRunners: [] }, 'runners').hint).toContain('Hermes pod');
      expect(step({ ...base, adminRunners: null }, 'runners').done).toBe(false);
    });

    it('keeps the checklist unfinished and names the runners step as next while none passed', () => {
      const without = { ...ready, state: { ...ready.state, marks: [] } };
      const s = onboardingSteps(without);
      expect(s.finished).toBe(false);
      expect(s.next?.id).toBe('runners');
    });

    it('knows a working runner and the one the wizard proved', () => {
      expect(isWorkingRunner(runner())).toBe(true);
      expect(isWorkingRunner(runner({ enabled: false }))).toBe(false);
      expect(isWorkingRunner(runner({ status: 'starting' }))).toBe(false);
      expect(provenRunner([runner()], ready.state)?.id).toBe(RUNNER_ID);
      expect(provenRunner([runner()], empty)).toBeNull();
    });
  });

  it('wants Brain on a team and a default runner before the bots step is done', () => {
    expect(step({ ...ready, adminRunners: [runner({ isDefault: false })] }, 'bots').done).toBe(false);
    expect(step(ready, 'bots').done).toBe(true);
    expect(step({ ...ready, teamBots: { [team.slug]: [] } }, 'bots').done).toBe(false);
  });

  it('chooses the team that has Brain as the team the steps talk about', () => {
    const support = { id: '44444444-4444-4444-8444-444444444444', slug: 'support', name: 'Support' };
    const s = { ...ready, teams: [support, team], teamBots: { [support.slug]: [], [team.slug]: [{ slug: 'brain' }] } };
    expect(onboardingSteps(s).firstTeam).toEqual(team);
    expect(onboardingSteps(s).brainChat).toBe('/t/engineering/bots/brain/chat');
    expect(onboardingSteps({ ...s, teamBots: { [support.slug]: [], [team.slug]: [] } }).firstTeam).toEqual(support);
    expect(onboardingSteps({ ...s, teamBots: { [support.slug]: [], [team.slug]: [] } }).brainChat).toBeNull();
  });

  describe('the Brain check', () => {
    it('is done when the question was sent and its thread has an answer', () => {
      const withRoot = { ...ready, state: { ...ready.state, launch: { ...ready.state.launch!, messageId: '55555555-5555-4555-8555-555555555555' as never } } };
      expect(step({ ...withRoot, launchAnswered: true }, 'launch').done).toBe(true);
      expect(step({ ...withRoot, launchAnswered: false }, 'launch').done).toBe(false);
      expect(step({ ...withRoot, launchAnswered: null }, 'launch').done).toBe(true);
      expect(step({ ...ready, state: { ...ready.state, launch: null } }, 'launch').done).toBe(false);
    });
  });

  it('counts a set-aside optional step as handled but not as done, and never lets it finish the checklist', () => {
    const aside = { ...base, state: { ...empty, marks: [mark('infrastructure', 'skipped'), mark('code', 'skipped')] } };
    expect(step(aside, 'infrastructure').status).toBe('skipped');
    expect(step(aside, 'infrastructure').done).toBe(false);
    expect(onboardingSteps(aside).handled).toBe(onboardingSteps(base).handled + 2);
    expect(onboardingSteps(aside).finished).toBe(false);
  });

  it('finishes when every required step is done, and the optional ones stay to do', () => {
    const s = onboardingSteps(ready);
    expect(s.finished).toBe(true);
    expect(s.next).toBeNull();
    expect(step(ready, 'delivery').status).toBe('todo');
    expect(onboardingSteps({ ...ready, enabledSignInProviders: 0 }).finished).toBe(true);
  });

  it('marks the first delivery done only by a pull request after the start', () => {
    const started = { ...ready, state: { ...ready.state, marks: [...ready.state.marks, mark('delivery', 'started', '66666666-6666-4666-8666-666666666666')] } };
    expect(step(started, 'delivery').done).toBe(false);
    expect(step(started, 'delivery').hint).toContain('working');
    expect(step({ ...started, deliveryDone: true }, 'delivery').done).toBe(true);
  });

  it('offers the step after one, required ones first', () => {
    const s = onboardingSteps(base);
    expect(s.after('bootstrap')?.id).toBe('organization');
    expect(s.after('organization')?.id).toBe('models');
    expect(s.after('delivery')).toBeNull();
  });

  it('reports a checklist put away', () => {
    expect(onboardingSteps(ready).dismissed).toBe(false);
    expect(onboardingSteps({ ...ready, state: { ...ready.state, dismissedAt: at } }).dismissed).toBe(true);
  });
});
