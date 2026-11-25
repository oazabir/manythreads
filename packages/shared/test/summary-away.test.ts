import { describe, expect, it } from 'vitest';
import { AWAY_MAX_DAYS, CHANNEL_SUMMARY_RANGES, MyPresence, SummariseRequest, THREAD_SUMMARY_RANGES, recentAway } from '../src/index.ts';

// P18-05 step 2: "Since I was away", the summary range that starts when the person went out of office.

const DAY = 86_400_000;
const now = new Date('2026-11-25T10:00:00Z');
const ago = (days: number): Date => new Date(now.getTime() - days * DAY);
const base = { since: ago(5), endedAt: null, active: true, returnsOn: null, timeZone: 'Europe/Berlin' };

describe('the last out-of-office period', () => {
  it('starts when out of office was switched on, while it is on', () => {
    expect(recentAway(base, now)).toEqual({ since: ago(5), back: false });
  });

  it('is offered for two weeks after the person switched it off or their first day back came', () => {
    expect(recentAway({ ...base, active: false, endedAt: ago(13) }, now)).toEqual({ since: ago(5), back: true });
    expect(recentAway({ ...base, since: ago(20), active: false, endedAt: ago(15) }, now)).toBeNull();
    expect(recentAway({ ...base, returnsOn: '2026-11-24' }, now)).toEqual({ since: ago(5), back: true });
    expect(recentAway({ ...base, since: ago(30), returnsOn: '2026-11-01' }, now)).toBeNull();
    // the return day is still ahead: away
    expect(recentAway({ ...base, returnsOn: '2026-11-30' }, now)).toEqual({ since: ago(5), back: false });
  });

  it('reads at most 30 days back, and nothing without a start', () => {
    expect(recentAway({ ...base, since: ago(90) }, now)).toEqual({ since: ago(AWAY_MAX_DAYS), back: false });
    expect(recentAway({ ...base, since: null }, now)).toBeNull();
    expect(recentAway({ ...base, active: false, endedAt: null }, now)).toBeNull();
    expect(recentAway({ ...base, since: new Date(now.getTime() + DAY) }, now)).toBeNull();
  });
});

describe('the range on the wire', () => {
  it('is a channel range, not a thread one', () => {
    expect(CHANNEL_SUMMARY_RANGES).toContain('away');
    expect(THREAD_SUMMARY_RANGES).not.toContain('away');
    expect(SummariseRequest.parse({ threadRootId: null, range: 'away' })).toEqual({ threadRootId: null, range: 'away' });
    expect(() => SummariseRequest.parse({ threadRootId: null, range: 'away', since: '2026-11-01T00:00:00Z' })).toThrow();
  });

  it('MyPresence from an older server reads with no away period', () => {
    const me = MyPresence.parse({
      status: null,
      timeZone: null,
      workingHours: null,
      outOfOffice: null,
      dnd: { enabled: false, pausedUntil: null, schedule: { enabled: false, windows: [] } },
      dndState: { active: false, reason: null, until: null },
    });
    expect(me.away).toBeNull();
  });
});
