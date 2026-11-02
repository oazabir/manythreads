import { describe, expect, it, vi } from 'vitest';

// P7-07 live-check fix: pressing "See what a full replay costs" must move focus to the estimate heading. The old code set a timer beside the state, which could fire before
// the heading rendered (the ref was still empty). Focus now runs in an effect keyed on the state that makes the heading appear. There is no DOM in the unit project, so the
// effect is captured and run by hand, the way React runs it after the render.

const effects: { run: () => void; deps: unknown[] }[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (run: () => void, deps: unknown[]) => { effects.push({ run, deps }); },
}));

const { useFocusWhen } = await import('../src/screens/workshop/focus-when');

const last = () => effects[effects.length - 1]!;

describe('useFocusWhen', () => {
  it('focuses the element once the state that shows it is set, from an effect that depends on that state', () => {
    const el = { focus: vi.fn() };
    const ref = { current: null as { focus: () => void } | null };
    const estimate = { runId: 'r1' };

    // before the estimate exists the heading is not in the page: nothing to focus, and nothing breaks
    useFocusWhen(ref as never, null);
    last().run();
    expect(el.focus).not.toHaveBeenCalled();

    // the estimate is set; React renders the heading (the ref fills) and then runs the effect: focus lands
    useFocusWhen(ref as never, estimate);
    expect(last().deps).toContain(estimate);
    ref.current = el;
    last().run();
    expect(el.focus).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the element is still missing at that point', () => {
    const ref = { current: null };
    useFocusWhen(ref as never, { runId: 'r2' });
    expect(() => last().run()).not.toThrow();
  });

  it('a new estimate is a new dependency, so asking about another run takes focus again', () => {
    const ref = { current: { focus: vi.fn() } };
    useFocusWhen(ref as never, { runId: 'a' });
    const first = last().deps;
    useFocusWhen(ref as never, { runId: 'b' });
    expect(first).not.toEqual(last().deps);
  });
});
