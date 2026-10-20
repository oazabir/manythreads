import { cronMatches, nextCronRun, parseCron } from '../src/common/cron.ts';
import { describe, expect, it } from 'vitest';

const at = (iso: string): Date => new Date(iso);

describe('parseCron', () => {
  it('parses stars, steps, ranges, lists and names', () => {
    expect([...parseCron('* * * * *').minute].length).toBe(60);
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9 * * mon-fri').dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 1 jan,jul *').month]).toEqual([1, 7]);
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]); // 7 is Sunday too
  });

  it('refuses malformed or out-of-range fields', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '*/0 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });
});

describe('cronMatches', () => {
  it('matches a whole minute in UTC', () => {
    const spec = parseCron('30 9 * * *');
    expect(cronMatches(spec, at('2026-10-20T09:30:00Z'))).toBe(true);
    expect(cronMatches(spec, at('2026-10-20T09:30:30Z'))).toBe(true);
    expect(cronMatches(spec, at('2026-10-20T09:31:00Z'))).toBe(false);
  });

  it('uses Vixie cron day rules: two restricted day fields mean either may match', () => {
    const spec = parseCron('0 0 1 * mon');
    expect(cronMatches(spec, at('2026-06-01T00:00:00Z'))).toBe(true); // the 1st, a Monday
    expect(cronMatches(spec, at('2026-06-08T00:00:00Z'))).toBe(true); // a Monday
    expect(cronMatches(spec, at('2026-07-01T00:00:00Z'))).toBe(true); // the 1st, a Wednesday
    expect(cronMatches(spec, at('2026-06-02T00:00:00Z'))).toBe(false); // neither
  });
});

describe('nextCronRun', () => {
  it('finds the next whole minute strictly after the given time', () => {
    expect(nextCronRun('* * * * *', at('2026-10-20T09:30:00Z'))?.toISOString()).toBe('2026-10-20T09:31:00.000Z');
    expect(nextCronRun('0 9 * * *', at('2026-10-20T09:00:00Z'))?.toISOString()).toBe('2026-10-21T09:00:00.000Z');
    expect(nextCronRun('0 9 * * mon-fri', at('2026-10-23T10:00:00Z'))?.toISOString()).toBe('2026-10-26T09:00:00.000Z'); // Friday -> Monday
  });

  it('is idempotent for the same input and never returns the input minute', () => {
    const from = at('2026-10-20T09:30:00Z');
    const first = nextCronRun('30 9 * * *', from);
    expect(first?.toISOString()).toBe('2026-10-21T09:30:00.000Z');
    expect(nextCronRun('30 9 * * *', from)?.getTime()).toBe(first?.getTime());
  });

  it('answers null for an expression that never fires (Feb 30)', () => {
    expect(nextCronRun('0 0 30 2 *', at('2026-01-01T00:00:00Z'))).toBeNull();
  });
});
