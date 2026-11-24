import { describe, expect, it } from 'vitest';
import { freeName } from '../src/screens/onboarding/SubscriptionSignIn';

describe('the onboarding Claude/Codex set-up', () => {
  it('names a new runner with the first free name', () => {
    expect(freeName('claude', [])).toBe('claude');
    expect(freeName('claude', ['claude', 'claude-2'])).toBe('claude-3');
  });
});
