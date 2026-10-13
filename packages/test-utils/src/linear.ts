import { expect } from 'vitest';
import { measureLinear, type LinearMeasure, type LinearOptions } from './linear-measure.ts';

// The asserting half of the hostile-input timing helpers (see linear-measure.ts for the method). Import it as `@manythreads/test-utils/linear`
// from a test file: it needs vitest, so it is NOT part of this package's main entry (which the e2e web server and the seed load at runtime,
// where vitest's internal state does not exist; `test/entry-no-vitest.test.ts` keeps it that way).

export { measureLinear, type LinearMeasure, type LinearOptions };

/** Asserts that the cost of `run` over `prepare(n)` scales linearly and stays far from a blow-up. Returns the measurement. */
export function expectLinear<T>(prepare: (n: number) => T, run: (input: T) => unknown, options: LinearOptions): LinearMeasure {
  const factor = options.factor ?? 4;
  const ceiling = options.ceilingMs ?? 1000;
  const maxRatio = options.maxRatio ?? 10;
  const m = measureLinear(prepare, run, options);
  const what = `${options.label ?? 'hostile input'}: ${options.n} -> ${options.n * factor}: ${m.smallMs.toFixed(1)} ms -> ${m.largeMs.toFixed(1)} ms (x${m.ratio.toFixed(1)})`;
  expect(m.smallMs, `${what} (ceiling at the base size)`).toBeLessThan(ceiling);
  expect(m.largeMs, `${what} (ceiling at the large size)`).toBeLessThan(ceiling * factor * 2);
  expect(m.ratio, `${what} (growth)`).toBeLessThan(maxRatio);
  return m;
}
