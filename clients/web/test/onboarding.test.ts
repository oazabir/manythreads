import { describe, expect, it } from 'vitest';
import { onboardingSteps, type OnboardingInput } from '../src/screens/onboarding/Onboarding';

/*
 * PLAN P5-22: the minimal onboarding slice is steps 0, 1, 2, 4, 5 and 6 (SPEC §16 numbers kept,
 * so the phase-10 wizard extends the list in place). The derivation is pure, so the gate pins it
 * here; the screen itself is proven in Playwright like every other screen.
 */

const base: OnboardingInput = {
  workspaceName: 'Kahf Software',
  enabledSignInProviders: 0,
  llmProviders: 0,
  teams: [],
  firstTeamBots: [],
};

describe('the onboarding checklist', () => {
  it('starts with only the bootstrap step done, and points at the page that does each step', () => {
    const s = onboardingSteps(base);
    expect(s.steps.map((x) => x.n)).toEqual([0, 1, 2, 4, 5, 6]);
    expect(s.steps.filter((x) => x.done).map((x) => x.id)).toEqual(['bootstrap']);
    expect(s.allDone).toBe(false);
    expect(s.brainChat).toBeNull();
    const to = Object.fromEntries(s.steps.map((x) => [x.id, x.to]));
    expect(to).toEqual({
      bootstrap: '/settings/workspace/general',
      signin: '/settings/workspace/sign-in',
      models: '/settings/workspace/llm',
      https: '/settings/workspace/https',
      teams: '/teams',
      bots: '/teams',
    });
  });

  it('marks sign-in done with one enabled provider, and models done with one provider', () => {
    const s = onboardingSteps({ ...base, enabledSignInProviders: 1, llmProviders: 2 });
    expect(s.steps.find((x) => x.id === 'signin')?.done).toBe(true);
    expect(s.steps.find((x) => x.id === 'models')?.done).toBe(true);
    expect(s.steps.find((x) => x.id === 'models')?.hint).toContain('2 model providers');
  });

  it('marks teams done with one team, and sends the bots step to that team', () => {
    const s = onboardingSteps({ ...base, teams: [{ slug: 'engineering', name: 'Engineering' }], firstTeamBots: [] });
    expect(s.steps.find((x) => x.id === 'teams')?.done).toBe(true);
    expect(s.steps.find((x) => x.id === 'teams')?.hint).toContain('Engineering');
    expect(s.steps.find((x) => x.id === 'bots')?.to).toBe('/t/engineering/bots');
    expect(s.steps.find((x) => x.id === 'bots')?.done).toBe(false);
  });

  it('marks bots done only with Brain, and then offers the Brain chat', () => {
    const teams = [{ slug: 'engineering', name: 'Engineering' }];
    const without = onboardingSteps({ ...base, teams, firstTeamBots: [{ slug: 'coder' }] });
    expect(without.steps.find((x) => x.id === 'bots')?.done).toBe(false);
    expect(without.allDone).toBe(false);

    const withBrain = onboardingSteps({
      ...base,
      enabledSignInProviders: 1,
      llmProviders: 1,
      teams,
      firstTeamBots: [{ slug: 'brain' }, { slug: 'coder' }],
    });
    expect(withBrain.steps.find((x) => x.id === 'bots')?.done).toBe(true);
    expect(withBrain.allDone).toBe(true);
    expect(withBrain.brainChat).toBe('/t/engineering/bots/brain/chat');
  });

  it('waits for the roster instead of marking bots done while it loads', () => {
    const s = onboardingSteps({
      ...base,
      teams: [{ slug: 'engineering', name: 'Engineering' }],
      firstTeamBots: null,
    });
    expect(s.steps.find((x) => x.id === 'bots')?.done).toBe(false);
    expect(s.steps.find((x) => x.id === 'bots')?.hint).toContain('Reading');
  });

  it('treats Domain & HTTPS as optional: it never blocks allDone, and it is done only over HTTPS', () => {
    const all = { ...base, enabledSignInProviders: 1, llmProviders: 1, teams: [{ slug: 'e', name: 'E' }], firstTeamBots: [{ slug: 'brain' }] };
    const plain = onboardingSteps(all);
    const https = plain.steps.find((x) => x.id === 'https');
    expect(https).toMatchObject({ n: 4, title: 'Domain & HTTPS', done: false, optional: true });
    expect(plain.allDone).toBe(true);
    expect(onboardingSteps({ ...all, secure: true }).steps.find((x) => x.id === 'https')?.done).toBe(true);
  });
});
