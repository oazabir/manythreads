import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  LLM_TESTABLE_ALIASES,
  LaunchOnboardingRequest,
  ListLlmAliasTestsResponse,
  LlmAliasTest,
  OnboardingState,
  SetOnboardingMarkRequest,
  eventRegistry,
  parseEvent,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P10-01 (`pnpm test:events`): the three setup events, the alias test event, and the shapes of the setup state and the alias test result.

const AT = '2026-10-30T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('onboarding.step.marked', () => {
  const valid = { type: 'onboarding.step.marked', schemaVersion: 1, workspaceId: uuid(1), step: 'code', kind: 'skipped', markedBy: uuid(2), at: AT };
  it('is registered at version 1 and round-trips, and a taken-back mark has no kind', () => {
    expect(Object.keys(eventRegistry['onboarding.step.marked'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, kind: null })).toEqual({ ...valid, kind: null });
  });
  it.each([
    ['step', { step: 'models' }],
    ['kind', { kind: 'done' }],
    ['markedBy', { markedBy: 'omar' }],
  ])('refuses a bad %s', (field, over) => expect(failsAt({ ...valid, ...over })).toContain(field));
});

describe('onboarding.goal.launched and onboarding.checklist.dismissed', () => {
  const launched = { type: 'onboarding.goal.launched', schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), channelId: uuid(3), launchedBy: uuid(4), at: AT };
  const dismissed = { type: 'onboarding.checklist.dismissed', schemaVersion: 1, workspaceId: uuid(1), dismissedBy: uuid(4), at: AT };
  it('are registered at version 1 and round-trip', () => {
    expect(Object.keys(eventRegistry['onboarding.goal.launched'])).toEqual(['1']);
    expect(Object.keys(eventRegistry['onboarding.checklist.dismissed'])).toEqual(['1']);
    expect(parseEvent(launched)).toEqual(launched);
    expect(parseEvent(dismissed)).toEqual(dismissed);
  });
  it.each([
    ['teamId', { teamId: 'engineering' }],
    ['channelId', { channelId: '' }],
    ['launchedBy', { launchedBy: null }],
  ])('refuses a bad %s', (field, over) => expect(failsAt({ ...launched, ...over })).toContain(field));
});

describe('llm.alias.tested', () => {
  const valid = { type: 'llm.alias.tested', schemaVersion: 1, workspaceId: uuid(1), alias: 'smart', outcome: 'failed', cause: 'auth', testedBy: uuid(2), at: AT };
  it('is registered at version 1 and round-trips', () => {
    expect(Object.keys(eventRegistry['llm.alias.tested'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, outcome: 'ok', cause: null })).toMatchObject({ outcome: 'ok', cause: null });
  });
  it.each([
    ['alias', { alias: 'gpt-4' }],
    ['outcome', { outcome: 'passed' }],
    ['cause', { cause: 'the key was wrong' }],
  ])('refuses a bad %s', (field, over) => expect(failsAt({ ...valid, ...over })).toContain(field));
});

describe('the setup and alias test shapes', () => {
  it('a state is marks, a launch (ids only) and the dismissal', () => {
    const state = { marks: [{ step: 'servers', kind: 'skipped', markedAt: AT, markedBy: uuid(2) }], launch: { at: AT, by: uuid(2), teamId: uuid(3), channelId: uuid(4) }, dismissedAt: null, dismissedBy: null };
    expect(OnboardingState.parse(state)).toEqual(state);
    expect(() => OnboardingState.parse({ ...state, marks: [{ step: 'models', kind: 'skipped', markedAt: AT, markedBy: null }] })).toThrow();
  });

  it('requests are strict: no extra field rides along, and a launch carries no text', () => {
    expect(() => SetOnboardingMarkRequest.parse({ kind: 'skipped', note: 'x' })).toThrow();
    expect(() => LaunchOnboardingRequest.parse({ teamId: uuid(1), channelId: uuid(2), goal: 'hello' })).toThrow();
    expect(LaunchOnboardingRequest.parse({ teamId: uuid(1), channelId: uuid(2) })).toEqual({ teamId: uuid(1), channelId: uuid(2) });
  });

  it('an alias test result has a cause exactly when it failed to be ok in the stored sense, and the untestable list is the rest of the closed set', () => {
    const test = { alias: 'smart', outcome: 'ok', cause: null, message: 'The model answered.', model: 'gpt-4o', latencyMs: 12, testedAt: AT, testedBy: uuid(2), current: true };
    expect(LlmAliasTest.parse(test)).toEqual(test);
    expect(() => LlmAliasTest.parse({ ...test, message: '' })).toThrow();
    expect(() => LlmAliasTest.parse({ ...test, latencyMs: -1 })).toThrow();
    expect(ListLlmAliasTestsResponse.parse({ tests: [test], untestable: ['embed', 'image', 'transcribe'] }).untestable).toHaveLength(3);
    expect([...LLM_TESTABLE_ALIASES].sort()).toEqual(['code', 'fast', 'local', 'smart', 'vision']);
  });
});
