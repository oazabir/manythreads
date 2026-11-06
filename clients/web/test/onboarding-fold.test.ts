import { describe, expect, it } from 'vitest';
import { collapsedAtStart, isStepOpen } from '../src/screens/onboarding/fold';

const steps = [
  { id: 'bootstrap', status: 'done' },
  { id: 'signin', status: 'todo' },
  { id: 'servers', status: 'skipped' },
  { id: 'launch', status: 'todo' },
] as const;

describe('folding the finished steps of Setup', () => {
  it('folds what was done or set aside when the page opened, and keeps the rest open', () => {
    const folded = collapsedAtStart(steps);
    expect([...folded].sort()).toEqual(['bootstrap', 'servers']);
    expect(isStepOpen('bootstrap', folded, {})).toBe(false);
    expect(isStepOpen('signin', folded, {})).toBe(true);
    expect(isStepOpen('launch', folded, {})).toBe(true);
  });

  it('keeps a step open that turns done while the page is open, so its result stays on screen', () => {
    const folded = collapsedAtStart(steps);
    // the set is read once, when the page opens: a step that was to do then is not in it, whatever it becomes
    expect(isStepOpen('signin', folded, {})).toBe(true);
  });

  it("lets a person's own fold or unfold win over the start", () => {
    const folded = collapsedAtStart(steps);
    expect(isStepOpen('bootstrap', folded, { bootstrap: true })).toBe(true);
    expect(isStepOpen('signin', folded, { signin: false })).toBe(false);
  });

  it('opens a folded step by itself when it is to do again', () => {
    const folded = collapsedAtStart(steps);
    expect(isStepOpen('bootstrap', folded, {}, 'todo')).toBe(true);
    expect(isStepOpen('bootstrap', folded, {}, 'done')).toBe(false);
    expect(isStepOpen('bootstrap', folded, { bootstrap: false }, 'todo')).toBe(false);
  });

  it('folds nothing on a fresh install where every step is still to do', () => {
    expect(collapsedAtStart(steps.map((s) => ({ ...s, status: 'todo' as const }))).size).toBe(0);
  });
});
