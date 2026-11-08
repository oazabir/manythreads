import { describe, expect, it } from 'vitest';
import { buildCreateRequest, calendarConnectPath, chipText, invitedWords, isoWithOffset, localInstant, parseAddresses, proposedStart, whenWords, type ScheduleForm } from '../src/meetings/schedule/model';
import { gateSentence } from '../src/screens/meetings/JoinScheduled';

// P16-05: the pure parts of the "Schedule a room" dialog, the header chip and the join page's sentences.

const NOW = new Date(2026, 10, 9, 10, 0, 0); // Mon 9 Nov 2026, 10:00 in the test's own zone
const FORM: ScheduleForm = {
  title: '  Design   review ',
  date: '2026-11-09',
  time: '15:00',
  lengthMinutes: 30,
  attendeePersonIds: ['11111111-1111-4111-8111-111111111111'],
  outsideText: 'X@Outside.test, x@outside.test; y@outside.test',
  agenda: ' 1. Roadmap ',
  calendar: { provider: 'google', calendarId: 'primary' },
};

describe('the schedule dialog', () => {
  it('proposes the next half hour, at least five minutes away', () => {
    expect(proposedStart(new Date(2026, 10, 9, 10, 0, 0)).getHours()).toBe(10);
    expect(proposedStart(new Date(2026, 10, 9, 10, 0, 0)).getMinutes()).toBe(30);
    expect(proposedStart(new Date(2026, 10, 9, 10, 27, 0)).getMinutes()).toBe(0);
    expect(proposedStart(new Date(2026, 10, 9, 10, 27, 0)).getHours()).toBe(11);
  });

  it('reads a day and a time in the browser zone, and refuses a day that is not on the calendar', () => {
    const d = localInstant('2026-11-09', '15:00');
    expect(d?.getHours()).toBe(15);
    expect(localInstant('2026-02-31', '15:00')).toBeNull();
    expect(localInstant('', '15:00')).toBeNull();
    expect(localInstant('2026-11-09', '')).toBeNull();
  });

  it('refuses an hour the clocks skip, instead of quietly starting an hour later', () => {
    const before = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2026-03-08 02:30 does not exist in New York: the clocks go from 02:00 to 03:00
      expect(localInstant('2026-03-08', '02:30')).toBeNull();
      expect(localInstant('2026-03-08', '03:30')?.getHours()).toBe(3);
      const b = buildCreateRequest({ ...FORM, date: '2026-03-08', time: '02:30' }, new Date(2026, 2, 1, 10, 0, 0));
      expect(b.ok ? '' : b.error).toMatch(/do not exist/);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('points the connect button at Settings, Connections with the calendar service ticked', () => {
    expect(calendarConnectPath([])).toBe('/settings/connections?tick=calendar_write');
    expect(calendarConnectPath(['microsoft'])).toBe('/settings/connections?tick=calendar_write&only=microsoft');
    expect(calendarConnectPath(['google', 'microsoft'])).toBe('/settings/connections?tick=calendar_write');
  });

  it('writes the time with its offset', () => {
    expect(isoWithOffset(new Date(2026, 10, 9, 15, 0, 0))).toMatch(/^2026-11-09T15:00:00[+-]\d{2}:\d{2}$/);
  });

  it('collects the outside addresses once each and names the one that is not an address', () => {
    expect(parseAddresses('X@Outside.test, x@outside.test; y@outside.test\nz@o.test')).toEqual({ valid: ['x@outside.test', 'y@outside.test', 'z@o.test'], invalid: [] });
    expect(parseAddresses('a@b.test not-an-address').invalid).toEqual(['not-an-address']);
    expect(parseAddresses('  ')).toEqual({ valid: [], invalid: [] });
  });

  it('builds the request the server takes', () => {
    const built = buildCreateRequest(FORM, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.title).toBe('Design review');
    expect(built.body.lengthMinutes).toBe(30);
    expect(built.body.agendaMd).toBe('1. Roadmap');
    expect(built.body.outsideAddresses).toEqual(['x@outside.test', 'y@outside.test']);
    expect(built.body.attendeePersonIds).toHaveLength(1);
    expect(built.body.calendarProvider).toBe('google');
    expect(built.body.startsAt).toMatch(/T15:00:00[+-]\d{2}:\d{2}$/);
  });

  it('says what to fix', () => {
    const say = (patch: Partial<ScheduleForm>): string => {
      const b = buildCreateRequest({ ...FORM, ...patch }, NOW);
      return b.ok ? '' : b.error;
    };
    expect(say({ title: '   ' })).toBe('Give the meeting a title.');
    expect(say({ title: 'x'.repeat(121) })).toMatch(/at most 120/);
    expect(say({ date: '' })).toBe('Choose a date and a start time.');
    expect(say({ date: '2026-11-08' })).toMatch(/already passed/);
    expect(say({ lengthMinutes: 20 })).toBe('Choose how long the meeting lasts.');
    expect(say({ outsideText: 'nope' })).toMatch(/“nope” is not an email address/);
    expect(say({ calendar: null })).toBe('Connect a calendar first.');
    expect(say({ outsideText: Array.from({ length: 50 }, (_, i) => `p${i}@o.test`).join(' ') })).toMatch(/At most 50 people/);
    expect(say({ agenda: 'a'.repeat(8001) })).toMatch(/at most 8000/);
  });

  it('allows a time that has just passed (the server gives two minutes of grace)', () => {
    expect(buildCreateRequest({ ...FORM, time: '09:59' }, NOW).ok).toBe(true);
    expect(buildCreateRequest({ ...FORM, time: '09:57' }, NOW).ok).toBe(false);
  });
});

describe('the chip and the join page', () => {
  const plan = { title: 'Design review', startsAt: new Date(2026, 10, 9, 15, 0, 0).toISOString(), status: 'scheduled' as const };

  it('says today, tomorrow or the day', () => {
    expect(whenWords(plan.startsAt, NOW, 'en-GB')).toBe('today 15:00');
    expect(whenWords(new Date(2026, 10, 10, 9, 30, 0).toISOString(), NOW, 'en-GB')).toBe('tomorrow 09:30');
    expect(whenWords(new Date(2026, 10, 12, 9, 30, 0).toISOString(), NOW, 'en-GB')).toMatch(/Thu.*12.*Nov.*09:30/);
  });

  it('words the chip, shorter for a long title, and live once the room is open', () => {
    expect(chipText(plan, NOW, 'en-GB')).toBe('Design review, today 15:00');
    expect(chipText({ ...plan, status: 'started' }, NOW, 'en-GB')).toBe('Design review, live now');
    expect(chipText({ ...plan, title: 'x'.repeat(60) }, NOW, 'en-GB')).toContain('…');
  });

  it('counts the invited, outside people apart', () => {
    expect(invitedWords({ attendeeCount: 0, outsideCount: 0 })).toBe('Nobody invited yet');
    expect(invitedWords({ attendeeCount: 3, outsideCount: 0 })).toBe('3 invited');
    expect(invitedWords({ attendeeCount: 3, outsideCount: 1 })).toBe('3 invited, 1 outside');
  });

  it('gives a person who is not in the channel one sentence, and a cancelled plan another', () => {
    expect(gateSentence({ readable: false, status: 'scheduled', channelName: 'design', organizerName: 'Nadia' })).toBe('You are not in #design. Ask Nadia to add you.');
    expect(gateSentence({ readable: false, status: 'scheduled', channelName: null, organizerName: null })).toBe('You are not in this channel. Ask the organizer to add you.');
    expect(gateSentence({ readable: true, status: 'cancelled', channelName: 'design', organizerName: 'Nadia' })).toBe('This meeting was cancelled.');
    expect(gateSentence({ readable: true, status: 'scheduled', channelName: 'design', organizerName: 'Nadia' })).toBeNull();
  });
});
