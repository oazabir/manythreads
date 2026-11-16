import { describe, expect, it } from 'vitest';
import { isStepOpen, stepOpenAtStart } from '../src/screens/onboarding/fold';

const steps = [
  { id: 'bootstrap', status: 'done', optional: false },
  { id: 'theme', status: 'todo', optional: true },
  { id: 'models', status: 'todo', optional: false },
  { id: 'servers', status: 'skipped', optional: true },
  { id: 'launch', status: 'todo', optional: false },
] as const;

describe('which step of the setup wizard is open', () => {
  it('opens the first required step that is still to do, so a person lands where they stopped', () => {
    expect(stepOpenAtStart(steps, null)).toBe('models');
  });

  it('opens the step the address names, even a done one', () => {
    expect(stepOpenAtStart(steps, 'bootstrap')).toBe('bootstrap');
    expect(stepOpenAtStart(steps, 'launch')).toBe('launch');
  });

  it('ignores a name that is no step, and falls back to an optional step when every required one is done', () => {
    expect(stepOpenAtStart(steps, 'nonsense')).toBe('models');
    const rest = steps.map((s) => (s.optional ? s : { ...s, status: 'done' as const }));
    expect(stepOpenAtStart(rest, null)).toBe('theme');
    expect(stepOpenAtStart(rest.map((s) => ({ ...s, status: 'done' as const })), null)).toBeNull();
  });

  it("keeps one step open at the start and lets a person's own fold or unfold win", () => {
    expect(isStepOpen('models', 'models', {})).toBe(true);
    expect(isStepOpen('theme', 'models', {})).toBe(false);
    expect(isStepOpen('theme', 'models', { theme: true })).toBe(true);
    expect(isStepOpen('models', 'models', { models: false })).toBe(false);
  });
});
