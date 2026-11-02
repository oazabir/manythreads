import { describe, expect, it } from 'vitest';
import type { UsageBudget, UsageDay } from '@manythreads/shared';
import { barHeight, budgetView, chartSummary, dayLabel, failedShare, percent, perAnswer, usd, usdOrHidden, waitText } from '../src/screens/usage/format';

const day = (d: string, runs: number): UsageDay => ({ day: d, runs, failedRuns: 0, toolCalls: 0, answers: 0, spendUsd: null });
const budget = (over: Partial<UsageBudget> = {}): UsageBudget => ({ scope: 'workspace', window: 'month', limitUsd: 10, spentUsd: 2, since: '2026-11-01T00:00:00.000Z', ...over });

describe('usage formatting', () => {
  it('writes money like a bill, and says "Admins only" instead of a zero a reader may not have', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(0.004)).toBe('under $0.01');
    expect(usdOrHidden(null)).toBe('Admins only');
    expect(usdOrHidden(2)).toBe('$2.00');
  });

  it('writes shares and averages, and "none yet" when there is nothing to divide', () => {
    expect(percent(null)).toBe('none yet');
    expect(percent(0.25)).toBe('25 %');
    expect(percent(0.034)).toBe('3.4 %');
    expect(perAnswer(null)).toBe('none yet');
    expect(perAnswer(2.25)).toBe('2.3');
  });

  it('writes a wait in the unit a person reads', () => {
    expect(waitText(null)).toBe('none yet');
    expect(waitText(45)).toBe('45 s');
    expect(waitText(600)).toBe('10 min');
    expect(waitText(7200)).toBe('2.0 h');
  });

  it('sizes bars against the busiest day, and never hides a day that had something', () => {
    expect(barHeight(0, 10)).toBe(0);
    expect(barHeight(10, 10)).toBe(100);
    expect(barHeight(5, 10)).toBe(50);
    expect(barHeight(1, 1000)).toBe(3);
    expect(barHeight(3, 0)).toBe(0);
    expect(failedShare(1, 4)).toBe(25);
    expect(failedShare(0, 0)).toBe(0);
  });

  it('names a UTC day without shifting it by the reader\'s time zone', () => {
    expect(dayLabel('2026-11-02')).toBe('Nov 2');
    expect(dayLabel('2026-01-01')).toBe('Jan 1');
  });

  it('shows how full a budget is, in a colour and a sentence', () => {
    expect(budgetView(budget())).toMatchObject({ fill: 20, tone: 'ok' });
    expect(budgetView(budget({ spentUsd: 8.5 }))).toMatchObject({ fill: 85, tone: 'warn' });
    const full = budgetView(budget({ spentUsd: 12 }));
    expect(full).toMatchObject({ fill: 100, tone: 'alert' });
    expect(full.text).toContain('used up');
    expect(budgetView(budget({ window: 'day', limitUsd: 0, spentUsd: 0 })).fill).toBe(0);
    expect(budgetView(budget({ window: 'day' })).text).toContain('today');
  });

  it('describes a chart for people who cannot see it', () => {
    expect(chartSummary([], (d) => d.runs, 'bot runs')).toBe('No bot runs in this range.');
    expect(chartSummary([day('2026-11-01', 0)], (d) => d.runs, 'bot runs')).toBe('No bot runs in this range.');
    expect(chartSummary([day('2026-11-01', 2), day('2026-11-02', 5)], (d) => d.runs, 'bot runs')).toBe('7 bot runs over 2 days; the busiest day was Nov 2.');
  });
});
