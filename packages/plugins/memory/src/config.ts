import { BACKOFF_BASE_MS, DEBOUNCE_MS, DEFER_MS } from './constants.ts';

// The feed's three clocks, read per use from the environment so an operator (or a test) can move them without a build. A value that is not a
// whole number of milliseconds between 0 and one hour is ignored and the default applies. Defaults are in constants.ts.

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || !/^\d{1,7}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n <= 3_600_000 ? n : fallback;
};

export const feedTuning = (): { debounceMs: number; deferMs: number; backoffBaseMs: number } => ({
  /** `MANYTHREADS_MEMORY_DEBOUNCE_MS`: how long a change waits before the drain reads it. */
  debounceMs: envMs('MANYTHREADS_MEMORY_DEBOUNCE_MS', DEBOUNCE_MS),
  /** `MANYTHREADS_MEMORY_DEFER_MS`: how long a source waits for a run that has not closed. */
  deferMs: envMs('MANYTHREADS_MEMORY_DEFER_MS', DEFER_MS),
  /** `MANYTHREADS_MEMORY_BACKOFF_MS`: the first back-off after the engine fails; it doubles to 30 minutes. */
  backoffBaseMs: envMs('MANYTHREADS_MEMORY_BACKOFF_MS', BACKOFF_BASE_MS),
});
