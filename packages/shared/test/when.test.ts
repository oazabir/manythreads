import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../test-utils/src/linear.ts';
import { AMBIGUOUS_HOUR, DURATION_USAGE, WHEN_USAGE, parseDurationOnly, parseWhen } from '../src/index.ts';

// Wednesday 2026-11-04, 10:00 UTC = 15:00 in Karachi (UTC+5, no clock changes) = 05:00 in New York (UTC-5 after the change of 2026-11-01).
const NOW = new Date('2026-11-04T10:00:00Z');
const KHI = 'Asia/Karachi';
const NYC = 'America/New_York';

function ok(input: string, now = NOW, zone = KHI) {
  const r = parseWhen(input, now, zone);
  if (!r.ok) throw new Error(`expected a time for "${input}", got: ${r.reason}`);
  return r;
}
function refused(input: string, now = NOW, zone = KHI): string {
  const r = parseWhen(input, now, zone);
  if (r.ok) throw new Error(`expected a refusal for "${input}", got ${r.at.toISOString()}`);
  return r.reason;
}
const iso = (input: string, now = NOW, zone = KHI): string => ok(input, now, zone).at.toISOString();

describe('parseWhen: after a length of time', () => {
  it('reads minutes, hours, days and weeks in their spellings', () => {
    expect(iso('in 20 minutes call the bank')).toBe('2026-11-04T10:20:00.000Z');
    expect(iso('in 20m x')).toBe('2026-11-04T10:20:00.000Z');
    expect(iso('in 20 min x')).toBe('2026-11-04T10:20:00.000Z');
    expect(iso('in 2h x')).toBe('2026-11-04T12:00:00.000Z');
    expect(iso('in 2 hours x')).toBe('2026-11-04T12:00:00.000Z');
    expect(iso('in an hour x')).toBe('2026-11-04T11:00:00.000Z');
    expect(iso('in a minute x')).toBe('2026-11-04T10:01:00.000Z');
    expect(iso('in three days x')).toBe('2026-11-07T10:00:00.000Z');
    expect(iso('in 3 days x')).toBe('2026-11-07T10:00:00.000Z');
    expect(iso('in 1 week x')).toBe('2026-11-11T10:00:00.000Z');
    expect(iso('IN 2 WEEKS x')).toBe('2026-11-18T10:00:00.000Z');
  });

  it('returns the text that follows and the words that were read', () => {
    const r = ok('in 20 minutes   call  the bank');
    expect(r.rest).toBe('call  the bank');
    expect(r.phrase).toBe('in 20 minutes');
    const short = ok('in 2h');
    expect(short.rest).toBe('');
    expect(short.phrase).toBe('in 2h');
  });

  it('counts days as 24 hours, needing no time zone', () => {
    expect(parseWhen('in 3 days x', NOW, 'Not/AZone').ok).toBe(true);
    expect(iso('in 3 days x', new Date('2026-03-07T12:00:00Z'), NYC)).toBe('2026-03-10T12:00:00.000Z');
  });

  it('refuses seconds, nothing, too much and unreadable counts with a sentence', () => {
    expect(refused('in 20 seconds x')).toContain('whole minutes');
    expect(refused('in 0 minutes x')).toContain('at least one minute');
    expect(refused('in 2000 days x')).toContain('a year');
    expect(refused('in x')).toBe(refused('in'));
    expect(refused('in a while x')).toContain('length of time');
    expect(refused('in 2h30m x')).toContain('length of time');
    expect(refused('in 1.5 hours x')).toContain('length of time');
  });
});

describe('parseWhen: a clock time today', () => {
  it('reads 24-hour, am/pm, noon and a bare hour', () => {
    expect(iso('at 15:30 x')).toBe('2026-11-04T10:30:00.000Z');
    expect(iso('at 18:00 x')).toBe('2026-11-04T13:00:00.000Z');
    expect(iso('at 6pm x')).toBe('2026-11-04T13:00:00.000Z');
    expect(iso('at 6:15 pm x')).toBe('2026-11-04T13:15:00.000Z');
    expect(iso('at 6 p.m. x')).toBe('2026-11-04T13:00:00.000Z');
    expect(iso('at 11pm x')).toBe('2026-11-04T18:00:00.000Z');
    expect(iso('at 20 x')).toBe('2026-11-04T15:00:00.000Z');
    expect(iso('today at 9pm x')).toBe('2026-11-04T16:00:00.000Z');
  });

  it('knows noon and midnight', () => {
    // 12:00 in Karachi is 07:00 UTC, already past at 15:00 there: noon tomorrow is the way
    expect(iso('tomorrow at noon x')).toBe('2026-11-05T07:00:00.000Z');
    expect(iso('tomorrow at 12am x')).toBe('2026-11-04T19:00:00.000Z');
    expect(iso('tomorrow at 12pm x')).toBe('2026-11-05T07:00:00.000Z');
  });

  it('allows the minute that is now (a small skew) and refuses a time already gone today', () => {
    expect(iso('at 15:00 x')).toBe('2026-11-04T10:00:00.000Z');
    expect(refused('at 14:00 x')).toContain('already passed today');
    expect(refused('at 9am x')).toContain('already passed today');
    expect(refused('today at 08:00 x')).toContain('already passed today');
  });

  it('refuses an hour that could be morning or afternoon, and says how to write it', () => {
    expect(refused('at 3 x')).toBe(AMBIGUOUS_HOUR('3'));
    expect(refused('at 3:30 x')).toBe(AMBIGUOUS_HOUR('3:30'));
    expect(refused('tomorrow at 7 x')).toContain('morning or the afternoon');
    // a leading zero with minutes is plainly the morning
    expect(iso('tomorrow at 07:30 x')).toBe('2026-11-05T02:30:00.000Z');
    expect(iso('tomorrow at 7am x')).toBe('2026-11-05T02:00:00.000Z');
  });

  it('refuses things that are not clock times', () => {
    expect(refused('at 25:00 x')).toContain('Write the time');
    expect(refused('at 10:75 x')).toContain('Write the time');
    expect(refused('at 13pm x')).toContain('Write the time');
    expect(refused('at 0pm x')).toContain('Write the time');
    expect(refused('at 0 x')).toContain('Write the time');
    expect(refused('at 9:5 x')).toContain('Write the time');
    expect(refused('at 123 x')).toContain('Write the time');
    expect(refused('at lunch')).toContain('Write the time');
    expect(refused('at')).toContain('Write the time');
    expect(refused('today x')).toContain('what time today');
  });
});

describe('parseWhen: days', () => {
  it('reads tomorrow, with the default of 9:00 or a time', () => {
    expect(iso('tomorrow send the report')).toBe('2026-11-05T04:00:00.000Z');
    expect(ok('tomorrow send the report').rest).toBe('send the report');
    expect(ok('tomorrow send the report').phrase).toBe('tomorrow');
    expect(iso('tomorrow at 9 send')).toBe('2026-11-05T04:00:00.000Z');
    expect(iso('tomorrow at 9:30 send')).toBe('2026-11-05T04:30:00.000Z');
    expect(iso('tomorrow 9:30 send')).toBe('2026-11-05T04:30:00.000Z');
    expect(iso('tomorrow 3pm send')).toBe('2026-11-05T10:00:00.000Z');
    expect(ok('tomorrow at 9 send').rest).toBe('send');
    expect(ok('tomorrow at 9 send').phrase).toBe('tomorrow at 9');
  });

  it('keeps a number that is not a clock in the text of the reminder', () => {
    const r = ok('tomorrow 2 apples');
    expect(r.rest).toBe('2 apples');
    expect(r.at.toISOString()).toBe('2026-11-05T04:00:00.000Z');
    expect(ok('tomorrow noon lunch').rest).toBe('lunch');
  });

  it('reads a weekday as the next one after today, never today', () => {
    expect(iso('monday standup')).toBe('2026-11-09T04:00:00.000Z');
    expect(iso('mon standup')).toBe('2026-11-09T04:00:00.000Z');
    expect(iso('friday standup')).toBe('2026-11-06T04:00:00.000Z');
    // today is a Wednesday: "wednesday" is next week's
    expect(iso('wednesday standup')).toBe('2026-11-11T04:00:00.000Z');
    expect(iso('next wednesday standup')).toBe('2026-11-11T04:00:00.000Z');
    expect(iso('next friday at 5pm standup')).toBe('2026-11-06T12:00:00.000Z');
    expect(iso('monday at 9am standup')).toBe('2026-11-09T04:00:00.000Z');
    expect(iso('sunday at 20:00 x')).toBe('2026-11-08T15:00:00.000Z');
    expect(ok('monday standup').rest).toBe('standup');
  });

  it('reads next week as the coming Monday', () => {
    expect(iso('next week plan')).toBe('2026-11-09T04:00:00.000Z');
    expect(iso('next week at 14:00 plan')).toBe('2026-11-09T09:00:00.000Z');
    expect(ok('next week plan').phrase).toBe('next week');
    // on a Monday, next week is seven days on, not today
    expect(iso('next week plan', new Date('2026-11-09T01:00:00Z'))).toBe('2026-11-16T04:00:00.000Z');
  });

  it('reads a date, with or without on, and a time', () => {
    expect(iso('on 2026-12-01 at 10:00 review')).toBe('2026-12-01T05:00:00.000Z');
    expect(iso('2026-12-01 review')).toBe('2026-12-01T04:00:00.000Z');
    expect(iso('2026-12-01 10:00 review')).toBe('2026-12-01T05:00:00.000Z');
    expect(iso('on 2027-02-28 at 9pm x')).toBe('2027-02-28T16:00:00.000Z');
    expect(ok('on 2026-12-01 at 10:00 review').rest).toBe('review');
    expect(ok('on 2026-12-01 at 10:00 review').phrase).toBe('on 2026-12-01 at 10:00');
  });

  it('refuses dates that do not exist or have passed', () => {
    expect(refused('on 2026-02-30 x')).toContain('year-month-day');
    expect(refused('on 2026-13-01 x')).toContain('year-month-day');
    expect(refused('on tomorrow x')).toContain('year-month-day');
    expect(refused('on 2026-11-03 at 10:00 x')).toContain('already passed');
    expect(refused('2026-01-01 x')).toContain('already passed');
    expect(refused('2026/12/01 x')).toBe(WHEN_USAGE);
  });
});

describe('parseWhen: refusals', () => {
  it('says what to write when no time can be read', () => {
    expect(refused('')).toBe(WHEN_USAGE);
    expect(refused('   ')).toBe(WHEN_USAGE);
    expect(refused('sometime soon')).toBe(WHEN_USAGE);
    expect(refused('call the bank in 20 minutes')).toBe(WHEN_USAGE);
    expect(refused('next month x')).toBe(WHEN_USAGE);
  });

  it('does not read a word of the language itself as a weekday, a number or a unit', () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(refused(word)).toBe(WHEN_USAGE);
      expect(refused(`${word} review`)).toBe(WHEN_USAGE);
      expect(refused(`next ${word}`)).toBe(WHEN_USAGE);
      expect(refused(`in ${word} minutes`)).toBe(DURATION_USAGE);
      expect(refused(`in 5 ${word}`)).toBe(DURATION_USAGE);
      expect(refused(`tomorrow at ${word}`)).not.toContain('NaN');
    }
    expect(parseDurationOnly('constructor').ok).toBe(false);
    expect(parseDurationOnly('2 __proto__').ok).toBe(false);
  });

  it('refuses an unreadable clock of the page and an unknown time zone', () => {
    expect(refused('tomorrow x', new Date(Number.NaN))).toContain('not readable');
    expect(refused('tomorrow x', NOW, 'Mars/Base')).toContain('time zone');
    expect(refused('tomorrow x', NOW, '')).toContain('time zone');
  });
});

describe('parseWhen: the wall clock of the person, with clock changes', () => {
  // Saturday 2026-03-07 12:00 UTC (07:00 in New York, UTC-5); on Sunday 2026-03-08 at 02:00 the clocks jump to 03:00
  const SPRING = new Date('2026-03-07T12:00:00Z');
  // Friday 2026-10-30 12:00 UTC; on Sunday 2026-11-01 at 02:00 the clocks go back to 01:00, so 01:30 happens twice
  const FALL = new Date('2026-10-30T12:00:00Z');

  it('uses the offset in force on the day asked for, not today’s', () => {
    expect(iso('tomorrow at 9 x', SPRING, NYC)).toBe('2026-03-08T13:00:00.000Z'); // 09:00 EDT
    expect(iso('at 9am x', SPRING, NYC)).toBe('2026-03-07T14:00:00.000Z'); // 09:00 EST
    expect(iso('on 2026-11-01 at 9 x', FALL, NYC)).toBe('2026-11-01T14:00:00.000Z'); // 09:00 EST
    expect(iso('on 2026-10-31 at 9 x', FALL, NYC)).toBe('2026-10-31T13:00:00.000Z'); // 09:00 EDT
  });

  it('refuses a time the clocks skip', () => {
    expect(refused('tomorrow at 2:30am x', SPRING, NYC)).toContain('does not exist');
    expect(iso('tomorrow at 3am x', SPRING, NYC)).toBe('2026-03-08T07:00:00.000Z');
    expect(iso('tomorrow at 1:59am x', SPRING, NYC)).toBe('2026-03-08T06:59:00.000Z');
  });

  it('refuses a time the clocks repeat', () => {
    expect(refused('on 2026-11-01 at 1:30am x', FALL, NYC)).toContain('happens twice');
    expect(iso('on 2026-11-01 at 12:59am x', FALL, NYC)).toBe('2026-11-01T04:59:00.000Z');
    expect(iso('on 2026-11-01 at 2am x', FALL, NYC)).toBe('2026-11-01T07:00:00.000Z');
  });

  it('works in a zone ahead of UTC across midnight', () => {
    // 2026-11-04 21:00 UTC is already Thursday 02:00 in Karachi: "tomorrow" is Friday there
    expect(iso('tomorrow x', new Date('2026-11-04T21:00:00Z'), KHI)).toBe('2026-11-06T04:00:00.000Z');
    // and the same instant in New York is still Wednesday 16:00
    expect(iso('tomorrow x', new Date('2026-11-04T21:00:00Z'), NYC)).toBe('2026-11-05T14:00:00.000Z');
  });
});

describe('parseDurationOnly', () => {
  it('reads one length of time and nothing else', () => {
    expect(parseDurationOnly('30m')).toEqual({ ok: true, minutes: 30 });
    expect(parseDurationOnly('2h')).toEqual({ ok: true, minutes: 120 });
    expect(parseDurationOnly('2 hours')).toEqual({ ok: true, minutes: 120 });
    expect(parseDurationOnly('1 day')).toEqual({ ok: true, minutes: 1440 });
    expect(parseDurationOnly('an hour')).toEqual({ ok: true, minutes: 60 });
    expect(parseDurationOnly('  2 weeks  ')).toEqual({ ok: true, minutes: 20160 });
  });

  it('refuses anything more or less', () => {
    expect(parseDurationOnly('').ok).toBe(false);
    expect(parseDurationOnly('2h and a bit').ok).toBe(false);
    expect(parseDurationOnly('2').ok).toBe(false);
    expect(parseDurationOnly('h').ok).toBe(false);
    expect(parseDurationOnly('0m').ok).toBe(false);
    expect(parseDurationOnly('90s').ok).toBe(false);
    expect(parseDurationOnly('off').ok).toBe(false);
  });
});

describe('hostile text is read in linear time', () => {
  const blanks = (n: number) => ' '.repeat(n);
  const cases: Record<string, (n: number) => string> = {
    'a very long word': (n) => 'a'.repeat(n),
    'a very long number': (n) => '9'.repeat(n),
    'a very long clock-like word': (n) => `${'1'.repeat(n)}:${'3'.repeat(n)}`,
    'colons': (n) => ':'.repeat(n),
    'dashes': (n) => '-'.repeat(n),
    'blanks then a word': (n) => `${blanks(n)}tomorrow${blanks(n)}x`,
    'many short words': (n) => 'a '.repeat(n),
    'in with a long count': (n) => `in ${'9'.repeat(n)} minutes x`,
    'in with a long unit': (n) => `in 2 ${'m'.repeat(n)}`,
    'at with a long clock': (n) => `at ${'1'.repeat(n)}pm x`,
    'a date shaped word': (n) => `on ${'2026-'.repeat(n)}`,
    'tomorrow and a long text': (n) => `tomorrow at 9 ${'word '.repeat(n)}`,
    'unicode blanks': (n) => '\u00a0\t\n\r'.repeat(n) + 'monday x',
  };
  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      expectLinear(build, (input) => [parseWhen(input, NOW, KHI), parseWhen(input, NOW, NYC), parseDurationOnly(input)], { n: 50_000, label: name, ceilingMs: 1500 });
    });
  }
});
