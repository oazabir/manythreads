import { describe, expect, it } from 'vitest';
import {
  CustomStatusInput,
  DEFAULT_DND_SETTINGS,
  DndSchedule,
  OutOfOfficeInput,
  UpdateDndRequest,
  UpdateMyPresenceRequest,
  WorkingHours,
  dndState,
  isValidTimeZone,
  liveOutOfOffice,
  liveStatus,
  localClock,
  localDate,
  localTimeText,
  withinWorkingHours,
  type DndSettings,
  type DndWindow,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

const at = (iso: string): Date => new Date(iso);
const schedule = (...windows: DndWindow[]): DndSettings => ({ ...DEFAULT_DND_SETTINGS, schedule: { enabled: true, windows } });
const night = (days: number[]): DndWindow => ({ days, start: '22:00', end: '07:00' });
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

describe('the clock in another time zone', () => {
  it('reads the weekday and minutes at the same instant differently per zone', () => {
    const instant = at('2026-06-10T17:30:00Z');                    // a Wednesday
    expect(localClock(instant, 'Asia/Karachi')).toEqual({ weekday: 3, minutes: 22 * 60 + 30 });
    expect(localClock(instant, 'America/New_York')).toEqual({ weekday: 3, minutes: 13 * 60 + 30 });
    expect(localClock(instant, 'Asia/Kolkata')).toEqual({ weekday: 3, minutes: 23 * 60 });          // +05:30
    expect(localClock(instant, 'Pacific/Kiritimati')).toEqual({ weekday: 4, minutes: 7 * 60 + 30 }); // +14, already Thursday
    expect(localTimeText(instant, 'Asia/Karachi')).toBe('22:30');
    expect(localTimeText(at('2026-06-10T22:05:00Z'), 'UTC')).toBe('22:05');
    expect(localTimeText(at('2026-06-10T00:00:00Z'), 'UTC')).toBe('00:00');          // midnight is 00:00, never 24:00
  });

  it('validates names from the time zone database', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
  });

  it('knows the calendar date there', () => {
    expect(localDate(at('2026-06-10T19:00:00Z'), 'Asia/Karachi')).toBe('2026-06-11');
    expect(localDate(at('2026-06-10T19:00:00Z'), 'America/New_York')).toBe('2026-06-10');
  });
});

describe('working hours', () => {
  const hours = WorkingHours.parse({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' });

  it('start inclusive, end exclusive, on working days only, in the person\'s zone', () => {
    expect(withinWorkingHours(hours, 'Asia/Karachi', at('2026-06-10T04:00:00Z'))).toBe(true);      // Wed 09:00 in Karachi
    expect(withinWorkingHours(hours, 'Asia/Karachi', at('2026-06-10T03:59:00Z'))).toBe(false);     // 08:59
    expect(withinWorkingHours(hours, 'Asia/Karachi', at('2026-06-10T11:59:00Z'))).toBe(true);      // 16:59
    expect(withinWorkingHours(hours, 'Asia/Karachi', at('2026-06-10T12:00:00Z'))).toBe(false);     // 17:00
    expect(withinWorkingHours(hours, 'Asia/Karachi', at('2026-06-13T07:00:00Z'))).toBe(false);     // a Saturday
    // the same instant is the middle of the morning in New York
    expect(withinWorkingHours(hours, 'America/New_York', at('2026-06-10T14:00:00Z'))).toBe(true);
  });

  it('must end after it starts, each day once', () => {
    expect(WorkingHours.safeParse({ days: [1], start: '17:00', end: '09:00' }).success).toBe(false);
    expect(WorkingHours.safeParse({ days: [1], start: '09:00', end: '09:00' }).success).toBe(false);
    expect(WorkingHours.safeParse({ days: [1, 1], start: '09:00', end: '17:00' }).success).toBe(false);
    expect(WorkingHours.safeParse({ days: [], start: '09:00', end: '17:00' }).success).toBe(false);
    expect(WorkingHours.safeParse({ days: [7], start: '09:00', end: '17:00' }).success).toBe(false);
    expect(WorkingHours.safeParse({ days: [1], start: '9:00', end: '17:00' }).success).toBe(false);
    expect(WorkingHours.safeParse({ days: [1], start: '09:00', end: '24:00' }).success).toBe(false);
  });
});

describe('Do not disturb: by hand, paused, scheduled', () => {
  it('is off by default', () => {
    expect(dndState(DEFAULT_DND_SETTINGS, null, at('2026-06-10T12:00:00Z'))).toEqual({ active: false, reason: null, until: null });
  });

  it('by hand it stays on with no end, whatever else is set', () => {
    const s: DndSettings = { enabled: true, pausedUntil: '2026-06-10T13:00:00Z', schedule: { enabled: false, windows: [] } };
    expect(dndState(s, 'UTC', at('2026-06-10T12:00:00Z'))).toEqual({ active: true, reason: 'manual', until: null });
  });

  it('a pause runs to its end and not a second longer', () => {
    const s: DndSettings = { ...DEFAULT_DND_SETTINGS, pausedUntil: '2026-06-10T13:00:00.000Z' };
    expect(dndState(s, 'UTC', at('2026-06-10T12:59:59.999Z'))).toEqual({ active: true, reason: 'paused', until: '2026-06-10T13:00:00.000Z' });
    expect(dndState(s, 'UTC', at('2026-06-10T13:00:00.000Z')).active).toBe(false);
  });

  it('a same-day window runs from its start (inclusive) to its end (exclusive)', () => {
    const s = schedule({ days: [1, 2, 3, 4, 5], start: '12:00', end: '13:00' });
    expect(dndState(s, 'UTC', at('2026-06-10T11:59:00Z')).active).toBe(false);
    expect(dndState(s, 'UTC', at('2026-06-10T12:00:00Z'))).toEqual({ active: true, reason: 'schedule', until: '2026-06-10T13:00:00.000Z' });
    expect(dndState(s, 'UTC', at('2026-06-10T13:00:00Z')).active).toBe(false);
    expect(dndState(s, 'UTC', at('2026-06-13T12:30:00Z')).active).toBe(false);               // Saturday is not listed
  });

  it('an overnight window belongs to the day it starts on', () => {
    const s = schedule(night([3]));                                                           // Wednesday night
    expect(dndState(s, 'UTC', at('2026-06-10T21:59:00Z')).active).toBe(false);               // Wed 21:59
    expect(dndState(s, 'UTC', at('2026-06-10T22:00:00Z')).active).toBe(true);                // Wed 22:00
    expect(dndState(s, 'UTC', at('2026-06-11T06:59:00Z'))).toMatchObject({ active: true, until: '2026-06-11T07:00:00.000Z' });   // Thu morning
    expect(dndState(s, 'UTC', at('2026-06-11T07:00:00Z')).active).toBe(false);
    expect(dndState(s, 'UTC', at('2026-06-10T06:00:00Z')).active).toBe(false);               // Wed morning belongs to Tuesday night
  });

  it('the same instant is quiet in one zone and not in another', () => {
    const s = schedule(night([3]));
    const instant = at('2026-06-10T17:30:00Z');                                               // Wed 22:30 in Karachi, 13:30 in New York
    expect(dndState(s, 'Asia/Karachi', instant).active).toBe(true);
    expect(dndState(s, 'America/New_York', instant).active).toBe(false);
    expect(dndState(s, null, instant).active).toBe(false);                                    // no zone reads UTC: 17:30
    // and its end is the person's 07:00, not ours
    expect(dndState(s, 'Asia/Karachi', instant).until).toBe('2026-06-11T02:00:00.000Z');
  });

  it('a window that touches the next one runs through to the end of the last', () => {
    const s = schedule({ days: [3], start: '20:00', end: '23:00' }, { days: [3], start: '23:00', end: '23:30' });
    expect(dndState(s, 'UTC', at('2026-06-10T20:30:00Z')).until).toBe('2026-06-10T23:30:00.000Z');
  });

  it('a schedule that never stops reports no end; a disabled one does nothing', () => {
    const always = schedule({ days: ALL_DAYS, start: '00:00', end: '23:59' }, { days: ALL_DAYS, start: '23:59', end: '00:00' });
    expect(dndState(always, 'UTC', at('2026-06-10T12:00:00Z'))).toEqual({ active: true, reason: 'schedule', until: null });
    const off: DndSettings = { ...schedule(night(ALL_DAYS)), schedule: { enabled: false, windows: [night(ALL_DAYS)] } };
    expect(dndState(off, 'UTC', at('2026-06-10T23:00:00Z')).active).toBe(false);
  });

  it('can skip finding the end', () => {
    expect(dndState(schedule(night(ALL_DAYS)), 'UTC', at('2026-06-10T23:00:00Z'), false)).toEqual({ active: true, reason: 'schedule', until: null });
  });

  describe('daylight saving', () => {
    // New York: clocks went forward at 02:00 on Sunday 8 March 2026 (EST -5 to EDT -4) and back at 02:00 on Sunday 1 November (EDT to EST).
    const saturdayNight = schedule(night([6]));

    it('spring forward: the night is an hour shorter, so the window ends 07:00 summer time', () => {
      expect(dndState(saturdayNight, 'America/New_York', at('2026-03-08T05:00:00Z'))).toMatchObject({ active: true, until: '2026-03-08T11:00:00.000Z' });
      // 06:59 EDT is quiet, 07:00 EDT is not; a fixed winter offset (-5) would still call 11:30Z 06:30 and keep the person muted.
      expect(dndState(saturdayNight, 'America/New_York', at('2026-03-08T10:59:00Z')).active).toBe(true);
      expect(dndState(saturdayNight, 'America/New_York', at('2026-03-08T11:30:00Z')).active).toBe(false);
    });

    it('fall back: the night is an hour longer, so the window ends 07:00 winter time', () => {
      expect(dndState(saturdayNight, 'America/New_York', at('2026-11-01T05:00:00Z'))).toMatchObject({ active: true, until: '2026-11-01T12:00:00.000Z' });
      expect(dndState(saturdayNight, 'America/New_York', at('2026-11-01T11:30:00Z')).active).toBe(true);
      expect(dndState(saturdayNight, 'America/New_York', at('2026-11-01T12:00:00Z')).active).toBe(false);
    });

    it('a window that starts inside the hour that does not exist begins when the clock reaches it', () => {
      const s = schedule({ days: ALL_DAYS, start: '02:30', end: '04:00' });
      expect(dndState(s, 'America/New_York', at('2026-03-08T06:59:00Z')).active).toBe(false);   // 01:59 EST
      expect(dndState(s, 'America/New_York', at('2026-03-08T07:00:00Z'))).toMatchObject({ active: true, until: '2026-03-08T08:00:00.000Z' });   // 03:00 EDT
    });

    it('Europe changes on another date than the US: 29 March 2026', () => {
      const s = schedule(night([6]));
      expect(dndState(s, 'Europe/Berlin', at('2026-03-29T04:59:00Z')).active).toBe(true);       // 06:59 CEST
      expect(dndState(s, 'Europe/Berlin', at('2026-03-29T05:00:00Z')).active).toBe(false);      // 07:00 CEST
    });
  });
});

describe('what is shown beside a name', () => {
  const status = { emoji: '🍽️', text: 'Lunch', clearsAt: '2026-06-10T13:00:00.000Z' };

  it('a status is dropped at its clear time, kept before it, kept for ever without one', () => {
    expect(liveStatus(status, at('2026-06-10T12:59:59.999Z'))).toEqual(status);
    expect(liveStatus(status, at('2026-06-10T13:00:00.000Z'))).toBeNull();
    expect(liveStatus({ ...status, clearsAt: null }, at('2030-01-01T00:00:00Z'))).not.toBeNull();
    expect(liveStatus(null, at('2026-06-10T12:00:00Z'))).toBeNull();
  });

  it('an out-of-office note ends on the first day back in the person\'s own zone', () => {
    const note = { active: true, returnsOn: '2026-06-11', delegatePersonId: null, message: '' };
    expect(liveOutOfOffice(note, 'Asia/Karachi', at('2026-06-10T18:59:00Z'))).not.toBeNull();   // 23:59 on the 10th in Karachi
    expect(liveOutOfOffice(note, 'Asia/Karachi', at('2026-06-10T19:00:00Z'))).toBeNull();       // midnight: back
    expect(liveOutOfOffice(note, 'America/New_York', at('2026-06-10T19:00:00Z'))).not.toBeNull();
    expect(liveOutOfOffice({ ...note, returnsOn: null }, null, at('2030-01-01T00:00:00Z'))).not.toBeNull();
    expect(liveOutOfOffice({ ...note, active: false }, null, at('2026-06-01T00:00:00Z'))).toBeNull();
  });
});

describe('what a client may send', () => {
  it('a status needs an emoji or words, trimmed, within the limits', () => {
    expect(CustomStatusInput.parse({ emoji: '🎧', text: '  ', clearsAt: null })).toEqual({ emoji: '🎧', text: '', clearsAt: null });
    expect(CustomStatusInput.safeParse({ emoji: null, text: '  ', clearsAt: null }).success).toBe(false);
    expect(CustomStatusInput.safeParse({ emoji: null, text: 'x'.repeat(101), clearsAt: null }).success).toBe(false);
    expect(CustomStatusInput.safeParse({ emoji: 'x'.repeat(17), text: '', clearsAt: null }).success).toBe(false);
    expect(CustomStatusInput.safeParse({ emoji: '🎧', text: '', clearsAt: 'tomorrow' }).success).toBe(false);
    expect(CustomStatusInput.safeParse({ emoji: '🎧', text: '', clearsAt: null, extra: 1 }).success).toBe(false);
  });

  it('a schedule has at most seven windows that each start and end at different times', () => {
    expect(DndSchedule.safeParse({ enabled: true, windows: Array.from({ length: 8 }, () => night([1])) }).success).toBe(false);
    expect(DndSchedule.safeParse({ enabled: true, windows: [{ days: [1], start: '07:00', end: '07:00' }] }).success).toBe(false);
    expect(DndSchedule.safeParse({ enabled: true, windows: [night([1, 2])] }).success).toBe(true);
  });

  it('the update requests are strict', () => {
    expect(UpdateMyPresenceRequest.safeParse({ personId: uuid(1) }).success).toBe(false);
    expect(UpdateMyPresenceRequest.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(UpdateMyPresenceRequest.safeParse({ timeZone: 'Asia/Karachi', status: null, workingHours: null, outOfOffice: null }).success).toBe(true);
    expect(UpdateDndRequest.safeParse({ pauseMinutes: 60 }).success).toBe(true);
    expect(UpdateDndRequest.safeParse({ pauseMinutes: null }).success).toBe(true);
    expect(UpdateDndRequest.safeParse({ pauseMinutes: 0 }).success).toBe(false);
    expect(UpdateDndRequest.safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(OutOfOfficeInput.safeParse({ active: true, returnsOn: '2026-06-11', delegatePersonId: uuid(1), message: 'Back soon' }).success).toBe(true);
    expect(OutOfOfficeInput.safeParse({ active: true, returnsOn: '11/06/2026', delegatePersonId: null, message: '' }).success).toBe(false);
  });
});
