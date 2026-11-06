import { describe, expect, it } from 'vitest';
import type { UsageDay } from '@manythreads/shared';
import { barLabel, dayMonth, fillDays } from '../src/screens/usage/format';

const day = (d: string, runs = 0, spendUsd: number | null = 0): UsageDay => ({ day: d, runs, failedRuns: 0, toolCalls: 0, answers: 0, spendUsd });

describe('usage chart days', () => {
  it('always draws the whole range, with a missing day as 0', () => {
    const out = fillDays([day('2026-11-01', 4), day('2026-11-04', 9)], 7, '2026-11-05');
    expect(out.map((d) => d.day)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    expect(out.map((d) => d.runs)).toEqual([0, 0, 4, 0, 0, 9, 0]);
  });

  it('draws 30 days from nothing at all', () => {
    const out = fillDays([], 30, '2026-11-30');
    expect(out).toHaveLength(30);
    expect(out[0]!.day).toBe('2026-11-01');
    expect(out.every((d) => d.runs === 0)).toBe(true);
  });

  it('ends on the last day it was given when no end day is named, and drops days outside the range', () => {
    const out = fillDays([day('2026-10-01', 1), day('2026-11-02', 2), day('2026-11-03', 3)], 2);
    expect(out.map((d) => [d.day, d.runs])).toEqual([['2026-11-02', 2], ['2026-11-03', 3]]);
  });

  it('does not throw for a malformed last day, and counts days in UTC across a clock change', () => {
    expect(fillDays([day('not-a-day', 1)], 3)).toHaveLength(3);
    // 27 and 28 Oct 2026 straddle the end of daylight saving in Europe; a day is still exactly one UTC day
    expect(fillDays([], 3, '2026-10-28').map((d) => d.day)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect(fillDays([], 3, '2026-03-30').map((d) => d.day)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(fillDays([], 365, '2026-11-05')).toHaveLength(365);
  });

  it('keeps money hidden for a reader who may not see it', () => {
    const out = fillDays([day('2026-11-03', 1, null)], 3);
    expect(out.map((d) => d.spendUsd)).toEqual([null, null, null]);
  });

  it('writes a bar as day, number and unit', () => {
    expect(dayMonth('2026-11-03')).toBe('3 Nov');
    expect(barLabel('2026-11-03', '18', 'runs')).toBe('3 Nov: 18 runs');
    expect(barLabel('2026-11-03', '18', 'runs', 2)).toBe('3 Nov: 18 runs (2 failed)');
  });
});
