import { describe, expect, it } from 'vitest';
import { cronRunsBetween } from '../src/common/cron.ts';

// P36-04: the Schedule screen draws a team's routines from their schedule.
describe('cronRunsBetween', () => {
  it('lists the runs in a window, in UTC, at most the limit; a bad expression has none', () => {
    const from = new Date('2026-11-23T00:00:00Z');
    const to = new Date('2026-11-30T00:00:00Z');
    expect(cronRunsBetween('0 9 * * 1-5', from, to).map((d) => d.toISOString())).toEqual([
      '2026-11-23T09:00:00.000Z',
      '2026-11-24T09:00:00.000Z',
      '2026-11-25T09:00:00.000Z',
      '2026-11-26T09:00:00.000Z',
      '2026-11-27T09:00:00.000Z',
    ]);
    expect(cronRunsBetween('*/5 * * * *', from, to, 10)).toHaveLength(10);
    expect(cronRunsBetween('not a cron', from, to)).toEqual([]);
  });
});
