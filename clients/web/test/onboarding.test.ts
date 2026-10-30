import { describe, expect, it } from 'vitest';
import type { OnboardingState } from '@manythreads/shared';
import { onboardingSteps, type OnboardingInput } from '../src/screens/onboarding/steps';

/*
 * PLAN P10-01: the setup checklist. Every step's "done" is a fact (a model that answered a test after its last change, an enabled sign-in method, a team,
 * Brain on it, a project, a runner, HTTPS, the first goal sent); the only things a person records are decisions. The derivation is pure, so the gate pins
 * it here; the screens are proven in Playwright like every other screen.
 */

const empty: OnboardingState = { marks: [], launch: null, dismissedAt: null, dismissedBy: null };
const mark = (step: 'signin' | 'code' | 'infrastructure' | 'servers', kind: 'skipped' | 'acknowledged') => ({ step, kind, markedAt: '2026-10-30T08:00:00.000Z', markedBy: null });
const team = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering', name: 'Engineering' };

const base: OnboardingInput = {
  workspaceName: 'Kahf Software',
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
};

const done = (input: OnboardingInput): string[] => onboardingSteps(input).steps.filter((s) => s.status === 'done').map((s) => s.id);
const step = (input: OnboardingInput, id: string) => onboardingSteps(input).steps.find((s) => s.id === id)!;

/** Everything required is true, and the first goal was sent. */
const ready: OnboardingInput = {
  ...base,
  enabledSignInProviders: 1,
  llmProviders: 1,
  boundAliases: ['smart'],
  tests: [{ alias: 'smart', outcome: 'ok', current: true }],
  teams: [team],
  teamBots: { [team.slug]: [{ slug: 'brain' }] },
  state: { ...empty, launch: { at: '2026-10-30T08:00:00.000Z', by: null, teamId: team.id as never, channelId: team.id as never } },
};

describe('the setup checklist', () => {
  it('has the nine steps of the spec in order, and on a new install only the sign-in as owner is done', () => {
    const s = onboardingSteps(base);
    expect(s.steps.map((x) => x.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(s.steps.map((x) => x.id)).toEqual(['bootstrap', 'signin', 'models', 'code', 'infrastructure', 'teams', 'bots', 'servers', 'launch']);
    expect(done(base)).toEqual(['bootstrap']);
    expect(s.finished).toBe(false);
    expect(s.next?.id).toBe('signin');
    expect(s.handled).toBe(1);
    expect(s.total).toBe(9);
  });

  it('marks sign-in done with one enabled method, or with the password-only confirmation, and no other way', () => {
    expect(step({ ...base, enabledSignInProviders: 1 }, 'signin').done).toBe(true);
    const ack = { ...base, state: { ...empty, marks: [mark('signin', 'acknowledged')] } };
    expect(step(ack, 'signin').done).toBe(true);
    expect(step(ack, 'signin').hint).toContain('password');
    expect(step({ ...base, llmProviders: 3 }, 'signin').done).toBe(false);
  });

  it('is never green for a model that was only saved: a provider and an alias are not an answer', () => {
    const saved = { ...base, llmProviders: 1, boundAliases: ['smart'] };
    expect(step(saved, 'models').done).toBe(false);
    expect(step(saved, 'models').hint).toContain('Test an alias');
    expect(step({ ...base, llmProviders: 0 }, 'models').hint).toContain('Add a model provider');
    expect(step({ ...base, llmProviders: 1 }, 'models').hint).toContain('Connect the smart alias');
  });

  it('marks models done only for a test that passed and still counts', () => {
    const ok = { ...base, llmProviders: 1, boundAliases: ['smart'], tests: [{ alias: 'smart' as const, outcome: 'ok' as const, current: true }] };
    expect(step(ok, 'models').done).toBe(true);
    expect(step(ok, 'models').hint).toContain('smart answered');
    const failed = { ...ok, tests: [{ alias: 'smart' as const, outcome: 'failed' as const, current: true }] };
    expect(step(failed, 'models').done).toBe(false);
    expect(step(failed, 'models').hint).toContain('failed');
    const stale = { ...ok, tests: [{ alias: 'smart' as const, outcome: 'ok' as const, current: false }] };
    expect(step(stale, 'models').done).toBe(false);
    expect(step(stale, 'models').hint).toContain('changed since');
  });

  it('does not count a model that answers on an alias Brain does not use', () => {
    const codeOnly = { ...base, llmProviders: 1, boundAliases: ['code'], tests: [{ alias: 'code' as const, outcome: 'ok' as const, current: true }] };
    expect(step(codeOnly, 'models').done).toBe(false);
    expect(step(codeOnly, 'models').hint).toContain('Brain uses smart and fast');
    const fast = { ...codeOnly, boundAliases: ['fast'], tests: [{ alias: 'fast' as const, outcome: 'ok' as const, current: true }] };
    expect(step(fast, 'models').done).toBe(true);
  });

  it('marks teams done with one team, and sends the bots step to that team', () => {
    const s = { ...base, teams: [team] };
    expect(step(s, 'teams').done).toBe(true);
    expect(step(s, 'teams').hint).toContain('Engineering');
    expect(step(s, 'bots').to).toBe('/t/engineering/bots');
    expect(step(s, 'bots').done).toBe(false);
    expect(onboardingSteps(s).firstTeam).toEqual(team);
  });

  it('picks the team that has Brain, not the first by name, for the bots step and the first goal', () => {
    const support = { id: '00000000-0000-7000-8000-0000000b0002', slug: 'customer-support', name: 'Customer support' };
    const s = { ...base, teams: [support, team] };
    expect(onboardingSteps({ ...s, teamBots: { [support.slug]: [], [team.slug]: [{ slug: 'brain' }] } }).firstTeam).toEqual(team);
    expect(onboardingSteps({ ...s, teamBots: { [support.slug]: [], [team.slug]: [{ slug: 'brain' }] } }).brainChat).toBe('/t/engineering/bots/brain/chat');
    // with no Brain anywhere the first team by name is the one to fix
    expect(onboardingSteps({ ...s, teamBots: { [support.slug]: [], [team.slug]: [] } }).firstTeam).toEqual(support);
  });

  it('marks bots done only with Brain, and waits for the roster instead of guessing', () => {
    const s = { ...base, teams: [team] };
    expect(step({ ...s, teamBots: { [team.slug]: [{ slug: 'coder' }] } }, 'bots').done).toBe(false);
    expect(step({ ...s, teamBots: { [team.slug]: [{ slug: 'brain' }, { slug: 'coder' }] } }, 'bots').done).toBe(true);
    const waiting = step({ ...s, teamBots: null }, 'bots');
    expect(waiting.done).toBe(false);
    expect(waiting.hint).toContain('Reading');
    expect(onboardingSteps({ ...s, teamBots: { [team.slug]: [{ slug: 'brain' }] } }).brainChat).toBe('/t/engineering/bots/brain/chat');
    expect(onboardingSteps(s).brainChat).toBeNull();
  });

  it('marks the first goal done only when it was sent', () => {
    expect(step({ ...ready, state: empty }, 'launch').done).toBe(false);
    expect(step(ready, 'launch').done).toBe(true);
  });

  it('the optional steps are facts when they can be and decisions when they cannot, and they never hold the checklist open', () => {
    const t = { ...ready, teams: [team] };
    expect(onboardingSteps(t).finished).toBe(true);
    for (const id of ['code', 'infrastructure', 'servers']) {
      expect(step(t, id)).toMatchObject({ optional: true, status: 'todo', done: false });
    }
    expect(step({ ...t, projects: 2 }, 'code').done).toBe(true);
    expect(step({ ...t, runners: 1 }, 'servers').done).toBe(true);
    expect(step({ ...t, secure: true }, 'infrastructure').done).toBe(true);
    const aside = { ...t, state: { ...t.state, marks: [mark('code', 'skipped'), mark('servers', 'skipped')] } };
    expect(step(aside, 'code').status).toBe('skipped');
    expect(step(aside, 'servers').status).toBe('skipped');
    expect(step(aside, 'infrastructure').status).toBe('todo');
    expect(onboardingSteps(aside).handled).toBe(onboardingSteps(t).handled + 2);
  });

  it('a fact beats a mark: an optional step that became true reads as done, not set aside', () => {
    const both = { ...ready, projects: 1, state: { ...ready.state, marks: [mark('code', 'skipped')] } };
    expect(step(both, 'code').status).toBe('done');
  });

  it('a step that is a fact cannot be set aside by a stray mark', () => {
    const forged = { ...base, state: { ...empty, marks: [mark('code', 'skipped')] } };
    // only the three optional steps and sign-in honour a mark; models, teams, bots and the launch have none
    expect(step(forged, 'models').status).toBe('todo');
    expect(step(forged, 'teams').status).toBe('todo');
    expect(step(forged, 'launch').status).toBe('todo');
  });

  it('is finished only when every required step is done and the first goal was sent', () => {
    expect(onboardingSteps(ready).finished).toBe(true);
    expect(onboardingSteps(ready).next).toBeNull();
    expect(onboardingSteps({ ...ready, state: empty }).finished).toBe(false);
    expect(onboardingSteps({ ...ready, state: empty }).next?.id).toBe('launch');
    expect(onboardingSteps({ ...ready, tests: [] }).finished).toBe(false);
    expect(onboardingSteps({ ...ready, teamBots: { [team.slug]: [] } }).finished).toBe(false);
    expect(onboardingSteps({ ...ready, enabledSignInProviders: 0 }).finished).toBe(false);
  });

  it('reports whether the checklist was put away', () => {
    expect(onboardingSteps(ready).dismissed).toBe(false);
    expect(onboardingSteps({ ...ready, state: { ...ready.state, dismissedAt: '2026-10-30T09:00:00.000Z' } }).dismissed).toBe(true);
  });
});
