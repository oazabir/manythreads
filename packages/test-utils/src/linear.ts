import { expect } from 'vitest';

// Hostile-input timing without a flat millisecond limit. A test that says "40,000 characters in under 50 ms" measures the machine as much as the
// code: three workers beside it and it reads 150 ms. What the test is for is the SHAPE of the cost — linear, never quadratic — so it times the same
// hostile construction at n and at factor × n in the same process (best of a few runs each, so a scheduling hiccup is not a measurement), and
// asserts that the large one costs about factor times the small one, plus a generous absolute ceiling that only a real blow-up reaches.
//
// A quadratic cost at factor 4 is 16 times, a linear one 4: `maxRatio` 8 sits between. The small time is floored at `noiseFloorMs` before the
// division, so a case that is too fast to measure cannot fail on a ratio of two timer ticks (the ceiling still bounds it).

export interface LinearOptions {
  /** The base size (characters, items...). */
  n: number;
  /** How much larger the second measurement is. Default 4. */
  factor?: number;
  /** Runs of each size; the best counts. Default 3. */
  runs?: number;
  /** The most the large time may be, relative to the small one (floored). Default 8 (linear is `factor`, quadratic `factor` squared). */
  maxRatio?: number;
  /** The base size's best time must be under this many ms (the large one under `ceilingMs × factor × 2`). Default 1000. */
  ceilingMs?: number;
  /** Below this the small time is not trusted as a divisor. Default 5. */
  noiseFloorMs?: number;
  /** Named in a failure. */
  label?: string;
}

export interface LinearMeasure {
  smallMs: number;
  largeMs: number;
  ratio: number;
}

const best = (run: () => void, runs: number): number => {
  let out = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    run();
    out = Math.min(out, performance.now() - started);
  }
  return out;
};

/** Measures `run(prepare(n))` and `run(prepare(factor × n))`; `prepare` is not timed. One warm-up at the small size first. */
export function measureLinear<T>(prepare: (n: number) => T, run: (input: T) => unknown, options: LinearOptions): LinearMeasure {
  const factor = options.factor ?? 4;
  const runs = options.runs ?? 3;
  const floor = options.noiseFloorMs ?? 5;
  const small = prepare(options.n);
  const large = prepare(options.n * factor);
  run(small); // warm up (JIT, caches)
  const smallMs = best(() => void run(small), runs);
  const largeMs = best(() => void run(large), runs);
  return { smallMs, largeMs, ratio: largeMs / Math.max(smallMs, floor) };
}

/** Asserts that the cost of `run` over `prepare(n)` scales linearly and stays far from a blow-up. Returns the measurement. */
export function expectLinear<T>(prepare: (n: number) => T, run: (input: T) => unknown, options: LinearOptions): LinearMeasure {
  const factor = options.factor ?? 4;
  const ceiling = options.ceilingMs ?? 1000;
  const maxRatio = options.maxRatio ?? 8;
  const m = measureLinear(prepare, run, options);
  const what = `${options.label ?? 'hostile input'}: ${options.n} -> ${options.n * factor}: ${m.smallMs.toFixed(1)} ms -> ${m.largeMs.toFixed(1)} ms (x${m.ratio.toFixed(1)})`;
  expect(m.smallMs, `${what} (ceiling at the base size)`).toBeLessThan(ceiling);
  expect(m.largeMs, `${what} (ceiling at the large size)`).toBeLessThan(ceiling * factor * 2);
  expect(m.ratio, `${what} (growth)`).toBeLessThan(maxRatio);
  return m;
}
