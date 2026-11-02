import type { UsageBudget, UsageDay } from '@manythreads/shared';

/** How far back the usage pages can look, in the words a person picks from. */
export const RANGES: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
];

/** Dollars the way a bill reads: cents, and "under 1 cent" instead of a misleading $0.00. */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return 'under $0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A money figure for a reader who may not have it (the server sends null): say so instead of drawing a zero. */
export const usdOrHidden = (n: number | null): string => (n === null ? 'Admins only' : usd(n));

export const count = (n: number): string => n.toLocaleString('en-US');

export function percent(share: number | null): string {
  if (share === null) return 'none yet';
  const p = share * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)} %`;
}

export function perAnswer(n: number | null): string {
  return n === null ? 'none yet' : n.toFixed(1);
}

/** How long an approval waited, in the biggest unit that reads naturally. */
export function waitText(seconds: number | null): string {
  if (seconds === null) return 'none yet';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** A bar's height as a share of the tallest bar, in whole percent; a non-zero value always shows at least a sliver. */
export function barHeight(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(3, Math.round((value / max) * 100));
}

/** The failed part of a bar, as a share of the bar. */
export function failedShare(failed: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.round((failed / total) * 100));
}

/** "Nov 2" for a UTC day (the day is a calendar date, so it is never shifted by the reader's time zone). */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface BudgetView {
  /** 0 to 100, for the bar. */
  fill: number;
  tone: 'ok' | 'warn' | 'alert';
  text: string;
}

/** The budget bar: how full the window is, a colour for the state, and a sentence. */
export function budgetView(b: UsageBudget): BudgetView {
  const share = b.limitUsd > 0 ? b.spentUsd / b.limitUsd : b.spentUsd > 0 ? 1 : 0;
  const tone = share >= 1 ? 'alert' : share >= 0.8 ? 'warn' : 'ok';
  const per = b.window === 'month' ? 'this month' : 'today';
  const text = share >= 1 ? `${usd(b.spentUsd)} of ${usd(b.limitUsd)} ${per}: the limit is used up, so model calls are refused until the window resets.` : `${usd(b.spentUsd)} of ${usd(b.limitUsd)} ${per} (${Math.round(share * 100)} %).`;
  return { fill: Math.min(100, Math.round(share * 100)), tone, text };
}

/** A one-line text for a chart, for people who cannot see it. */
export function chartSummary(days: readonly UsageDay[], pick: (d: UsageDay) => number, unit: string): string {
  const total = days.reduce((n, d) => n + pick(d), 0);
  const busiest = days.reduce<UsageDay | null>((best, d) => (best === null || pick(d) > pick(best) ? d : best), null);
  if (days.length === 0 || total === 0) return `No ${unit} in this range.`;
  return `${count(Math.round(total))} ${unit} over ${days.length} days; the busiest day was ${dayLabel(busiest!.day)}.`;
}
