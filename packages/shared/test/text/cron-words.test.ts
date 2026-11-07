import { describe, expect, it } from 'vitest';
import { cronToWords, inQuietHours, isTimeZone, localScheduleToCron, localTimeOfNextRun, minGapMinutes, quietHoursEnd, wordsToSchedule, zoneOffsetMinutes, zonedTimeToUtc } from '../../src/text/cron-words.ts';

const WINTER = new Date('2026-01-15T12:00:00Z');
const SUMMER = new Date('2026-07-15T12:00:00Z');

describe('time zones', () => {
  it('knows real zones and refuses made-up ones', () => {
    expect(isTimeZone('Asia/Dubai')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('reads the offset on the day, daylight saving included', () => {
    expect(zoneOffsetMinutes('Asia/Dubai', WINTER)).toBe(240);
    expect(zoneOffsetMinutes('America/New_York', WINTER)).toBe(-300);
    expect(zoneOffsetMinutes('America/New_York', SUMMER)).toBe(-240);
    expect(zoneOffsetMinutes('Asia/Kolkata', SUMMER)).toBe(330);
  });

  it('finds the instant of a wall-clock time, including across a clock change', () => {
    expect(zonedTimeToUtc('America/New_York', 2026, 3, 7, 7, 0).toISOString()).toBe('2026-03-07T12:00:00.000Z');
    expect(zonedTimeToUtc('America/New_York', 2026, 3, 9, 7, 0).toISOString()).toBe('2026-03-09T11:00:00.000Z');
  });
});

describe('a local schedule as a UTC cron', () => {
  it('moves the hour by the zone offset', () => {
    expect(localScheduleToCron({ hour: 7, minute: 0, dow: [1, 2, 3, 4, 5] }, 'Asia/Dubai', WINTER)).toBe('0 3 * * 1-5');
    expect(localScheduleToCron({ hour: 7, minute: 0, dow: null }, 'America/New_York', WINTER)).toBe('0 12 * * *');
    expect(localScheduleToCron({ hour: 7, minute: 0, dow: null }, 'America/New_York', SUMMER)).toBe('0 11 * * *');
  });

  it('moves the day when the offset crosses midnight', () => {
    // 01:00 on Mondays in Dubai is 21:00 on Sundays in UTC
    expect(localScheduleToCron({ hour: 1, minute: 0, dow: [1] }, 'Asia/Dubai', WINTER)).toBe('0 21 * * 0');
    // 22:00 on weekdays in Los Angeles is 06:00 the next UTC day
    expect(localScheduleToCron({ hour: 22, minute: 0, dow: [1, 2, 3, 4, 5] }, 'America/Los_Angeles', WINTER)).toBe('0 6 * * 2,3,4,5,6');
  });
});

describe('a cron in plain words', () => {
  it('says weekdays, one day, every day, and rolls the day back from UTC', () => {
    expect(cronToWords('0 3 * * 1-5', 'Asia/Dubai', WINTER)).toBe('Weekdays at 7:00 AM');
    expect(cronToWords('0 21 * * 0', 'Asia/Dubai', WINTER)).toBe('Every Monday at 1:00 AM');
    expect(cronToWords('30 15 * * *', 'UTC')).toBe('Every day at 3:30 PM');
    expect(cronToWords('0 9 * * 6,0', 'UTC')).toBe('Weekends at 9:00 AM');
  });

  it('says intervals and falls back to "Custom schedule" instead of a wrong sentence', () => {
    expect(cronToWords('*/30 * * * *', 'UTC')).toBe('Every 30 minutes');
    expect(cronToWords('0 * * * *', 'UTC')).toBe('Every hour');
    expect(cronToWords('0 */4 * * *', 'UTC')).toBe('Every 4 hours');
    expect(cronToWords('0 9 1 * *', 'UTC')).toBe('On day 1 of each month at 9:00 AM');
    expect(cronToWords('0 9 1 6 *', 'UTC')).toBe('Custom schedule');
    expect(cronToWords('nonsense', 'UTC')).toBe('Custom schedule');
  });

  it('follows daylight saving for a stored schedule', () => {
    expect(cronToWords('0 12 * * *', 'America/New_York', WINTER)).toBe('Every day at 7:00 AM');
    expect(cronToWords('0 12 * * *', 'America/New_York', SUMMER)).toBe('Every day at 8:00 AM');
  });

  it('shows the next run in local time', () => {
    expect(localTimeOfNextRun('0 3 * * 1-5', 'Asia/Dubai', new Date('2026-01-14T00:00:00Z'))).toBe('Wed 7:00 AM');
  });
});

describe('a sentence to a schedule', () => {
  it.each([
    ['every weekday at 7, summarise my unread mail', '0 3 * * 1-5', 'Weekdays at 7:00 AM'],
    ['Every Monday at 9am send me the week plan', '0 5 * * 1', 'Every Monday at 9:00 AM'],
    ['daily at 18:30 list what I did', '30 14 * * *', 'Every day at 6:30 PM'],
    ['every Friday at 4 pm', '0 12 * * 5', 'Every Friday at 4:00 PM'],
    ['each weekday at noon', '0 8 * * 1-5', 'Weekdays at 12:00 PM'],
  ])('%s', (sentence, cron, words) => {
    const parsed = wordsToSchedule(sentence, 'Asia/Dubai', WINTER);
    expect(parsed?.cron).toBe(cron);
    expect(parsed?.words).toBe(words);
  });

  it('reads intervals and notes what it assumed', () => {
    expect(wordsToSchedule('every 30 minutes check my cards', 'UTC')?.cron).toBe('*/30 * * * *');
    expect(wordsToSchedule('every hour', 'UTC')?.cron).toBe('0 * * * *');
    const noTime = wordsToSchedule('every weekday', 'UTC');
    expect(noTime?.cron).toBe('0 9 * * 1-5');
    expect(noTime?.notes[0]).toMatch(/9:00 AM/);
    expect(wordsToSchedule('every morning', 'UTC')?.cron).toBe('0 8 * * *');
  });

  it('returns nothing for a sentence with no schedule', () => {
    expect(wordsToSchedule('summarise my mail', 'UTC')).toBeNull();
  });
});

describe('how often a schedule runs', () => {
  it('finds the smallest gap', () => {
    expect(minGapMinutes('*/5 * * * *')).toBe(5);
    expect(minGapMinutes('0 9 * * 1-5')).toBe(24 * 60);
    expect(minGapMinutes('0 9,9 * * *')).toBe(24 * 60);
    expect(minGapMinutes('0 9,10 * * *')).toBe(60);
  });
});

describe('quiet hours', () => {
  const quiet = { from: '22:00', to: '07:00' };
  it('covers a window that crosses midnight, including its start and excluding its end', () => {
    expect(inQuietHours(new Date('2026-01-15T18:00:00Z'), 'Asia/Dubai', quiet)).toBe(true); // 22:00 in Dubai
    expect(inQuietHours(new Date('2026-01-15T02:59:00Z'), 'Asia/Dubai', quiet)).toBe(true); // 06:59
    expect(inQuietHours(new Date('2026-01-15T03:00:00Z'), 'Asia/Dubai', quiet)).toBe(false); // 07:00
    expect(inQuietHours(new Date('2026-01-15T12:00:00Z'), 'Asia/Dubai', quiet)).toBe(false);
    expect(inQuietHours(new Date('2026-01-15T12:00:00Z'), 'Asia/Dubai', null)).toBe(false);
  });

  it('covers a same-day window', () => {
    expect(inQuietHours(new Date('2026-01-15T10:00:00Z'), 'UTC', { from: '09:00', to: '17:00' })).toBe(true);
    expect(inQuietHours(new Date('2026-01-15T17:00:00Z'), 'UTC', { from: '09:00', to: '17:00' })).toBe(false);
  });

  it('finds when the quiet ends, today or tomorrow', () => {
    expect(quietHoursEnd(new Date('2026-01-15T02:00:00Z'), 'Asia/Dubai', quiet).toISOString()).toBe('2026-01-15T03:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-01-15T19:00:00Z'), 'Asia/Dubai', quiet).toISOString()).toBe('2026-01-16T03:00:00.000Z');
    const open = new Date('2026-01-15T12:00:00Z');
    expect(quietHoursEnd(open, 'Asia/Dubai', quiet).getTime()).toBe(open.getTime());
  });
});
