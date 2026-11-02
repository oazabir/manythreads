import { ANALYTICS_EVENT_MONTHS } from '@manythreads/shared';

// The deployment's say over analytics. Read per use from the environment (an operator, or a test, can move it without a build).

/**
 * `MANYTHREADS_ANALYTICS` = `off` stops the sweeps and the live writers (the pages then show what was already kept); anything else is on. Counting
 * what happened changes nothing about it, so unlike retention this is on unless an operator says otherwise.
 */
export function analyticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['MANYTHREADS_ANALYTICS'] ?? '').trim().toLowerCase() !== 'off';
}

/**
 * `MANYTHREADS_ANALYTICS_EVENT_MONTHS` (default 14, 2 to 120): how many calendar months of detailed events stay in the table, the current one included.
 * An older month is detached by the daily `analytics.retain` job; the daily numbers are never removed.
 */
export function eventMonths(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env['MANYTHREADS_ANALYTICS_EVENT_MONTHS']);
  return Number.isSafeInteger(v) && v >= ANALYTICS_EVENT_MONTHS.min && v <= ANALYTICS_EVENT_MONTHS.max ? v : ANALYTICS_EVENT_MONTHS.default;
}

/** The first day (UTC) of the oldest month that is kept, for `now`. */
export function oldestKeptMonth(now: Date, months: number = eventMonths()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  return d.toISOString().slice(0, 10);
}

/** How far back the first sweep of a source reads on a deployment that already has history (days). */
export const BACKFILL_DAYS = 35;

/** A sweep reads this far before where it stopped last time, so a row whose transaction committed late is not missed (rows already counted are skipped by their id). */
export const SWEEP_OVERLAP_MS = 10 * 60 * 1000;
