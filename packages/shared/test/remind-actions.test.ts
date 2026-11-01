import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../test-utils/src/linear.ts';
import {
  DND_MAX_MINUTES,
  MUTE_FOR_A_TIME,
  REMINDER_TEXT_MAX,
  TOPIC_MAX,
  parseDndArgs,
  parseInviteArgs,
  parseMuteArgs,
  parseRemindArgs,
  parseStatusArgs,
  parseTopicArgs,
  parseMarkup,
  plainCodeSpan,
  splitFirstWord,
} from '../src/index.ts';

// Wednesday 2026-11-04, 10:00 UTC = 15:00 in Karachi
const NOW = new Date('2026-11-04T10:00:00Z');
const KHI = 'Asia/Karachi';

describe('parseRemindArgs', () => {
  it('lists with nothing or the word list', () => {
    expect(parseRemindArgs('', NOW, KHI)).toEqual({ kind: 'list' });
    expect(parseRemindArgs('  List ', NOW, KHI)).toEqual({ kind: 'list' });
  });

  it('reads a reminder for me', () => {
    const r = parseRemindArgs('me in 20 minutes  call the   bank', NOW, KHI);
    expect(r).toEqual({ kind: 'ok', who: { kind: 'me' }, at: new Date('2026-11-04T10:20:00Z'), text: 'call the bank', phrase: 'in 20 minutes' });
    expect(parseRemindArgs('ME tomorrow at 9 send the report', NOW, KHI)).toMatchObject({ kind: 'ok', who: { kind: 'me' }, text: 'send the report' });
  });

  it('reads a reminder for a person and for a channel', () => {
    expect(parseRemindArgs('@priya monday at 9am review the PR', NOW, KHI)).toMatchObject({
      kind: 'ok',
      who: { kind: 'person', name: 'priya' },
      text: 'review the PR',
      at: new Date('2026-11-09T04:00:00Z'),
    });
    expect(parseRemindArgs('#dev-ops next week plan the sprint', NOW, KHI)).toMatchObject({ kind: 'ok', who: { kind: 'channel', name: 'dev-ops' }, text: 'plan the sprint' });
    expect(parseRemindArgs('@omar.k in 2h x', NOW, KHI)).toMatchObject({ who: { kind: 'person', name: 'omar.k' } });
  });

  it('refuses a missing or unreadable target, time or text, with a sentence', () => {
    const reason = (args: string): string => {
      const r = parseRemindArgs(args, NOW, KHI);
      if (r.kind !== 'error') throw new Error(`expected a refusal for "${args}"`);
      return r.reason;
    };
    expect(reason('in 20 minutes call the bank')).toContain('me, @person or #channel');
    expect(reason('everyone in 20 minutes x')).toContain('me, @person or #channel');
    expect(reason('@ in 20 minutes x')).toContain('not a name');
    expect(reason('@bad/name in 20 minutes x')).toContain('not a name');
    expect(reason(`@${'a'.repeat(60)} in 20 minutes x`)).toContain('not a name');
    expect(reason('me')).toContain('Say when first');
    expect(reason('me sometime x')).toContain('Say when first');
    expect(reason('me in 20 minutes')).toContain('Say what to be reminded of');
    expect(reason('me tomorrow')).toContain('Say what to be reminded of');
    expect(reason('me at 3 call')).toContain('morning or the afternoon');
    expect(reason('me at 08:00 call')).toContain('already passed');
    expect(reason(`me in 5 minutes ${'x'.repeat(REMINDER_TEXT_MAX + 1)}`)).toContain(`at most ${REMINDER_TEXT_MAX}`);
  });

  it('accepts a text of exactly the longest length', () => {
    expect(parseRemindArgs(`me in 5 minutes ${'x'.repeat(REMINDER_TEXT_MAX)}`, NOW, KHI)).toMatchObject({ kind: 'ok' });
  });

  it('applies the same limits as the Later menu: not more than a year ahead', () => {
    const r = parseRemindArgs('me on 2028-01-01 x', NOW, KHI);
    expect(r.kind).toBe('error');
  });

  it('puts lines of the text on one line', () => {
    const r = parseRemindArgs('me in 5 minutes first\nsecond\tthird', NOW, KHI);
    expect(r).toMatchObject({ kind: 'ok', text: 'first second third' });
  });

  it('reads hostile text in linear time', () => {
    for (const [name, build] of Object.entries({
      'a long name': (n: number) => `@${'a'.repeat(n)} in 5 minutes x`,
      'many blanks': (n: number) => `me${' '.repeat(n)}in 5 minutes${' '.repeat(n)}x`,
      'a long text': (n: number) => `me in 5 minutes ${'ab '.repeat(n)}`,
      'a long text of blanks': (n: number) => `me in 5 minutes x${'\n '.repeat(n)}`,
      'a long word at the start': (n: number) => 'z'.repeat(n),
    })) {
      expectLinear(build, (input) => parseRemindArgs(input, NOW, KHI), { n: 50_000, label: name, ceilingMs: 1500 });
    }
  });
});

describe('splitFirstWord', () => {
  it('cuts the first word from the rest', () => {
    expect(splitFirstWord('  one two  three ')).toEqual({ word: 'one', rest: 'two  three' });
    expect(splitFirstWord('')).toEqual({ word: '', rest: '' });
    expect(splitFirstWord('solo')).toEqual({ word: 'solo', rest: '' });
  });
});

describe('parseStatusArgs', () => {
  it('sets a status from text, with an emoji first when there is one', () => {
    expect(parseStatusArgs('in a meeting')).toEqual({ kind: 'set', emoji: null, text: 'in a meeting' });
    expect(parseStatusArgs('🌴 on holiday')).toEqual({ kind: 'set', emoji: '🌴', text: 'on holiday' });
    expect(parseStatusArgs('  🌴   on   holiday ')).toEqual({ kind: 'set', emoji: '🌴', text: 'on holiday' });
    expect(parseStatusArgs('🎧')).toEqual({ kind: 'set', emoji: '🎧', text: '' });
  });

  it('does not take a word as an emoji', () => {
    expect(parseStatusArgs('hello 🌴')).toEqual({ kind: 'set', emoji: null, text: 'hello 🌴' });
    expect(parseStatusArgs('2pm lunch')).toEqual({ kind: 'set', emoji: null, text: '2pm lunch' });
  });

  it('clears with the word clear, and refuses nothing and too long', () => {
    expect(parseStatusArgs('clear')).toEqual({ kind: 'clear' });
    expect(parseStatusArgs(' CLEAR ')).toEqual({ kind: 'clear' });
    expect(parseStatusArgs('').kind).toBe('error');
    expect(parseStatusArgs('   ').kind).toBe('error');
    const long = parseStatusArgs('x'.repeat(101));
    expect(long.kind).toBe('error');
    expect(parseStatusArgs('x'.repeat(100)).kind).toBe('set');
  });
});

describe('parseDndArgs', () => {
  it('pauses for a length of time and ends with off', () => {
    expect(parseDndArgs('2h')).toEqual({ kind: 'pause', minutes: 120 });
    expect(parseDndArgs('30 minutes')).toEqual({ kind: 'pause', minutes: 30 });
    expect(parseDndArgs('1d')).toEqual({ kind: 'pause', minutes: 1440 });
    expect(parseDndArgs('off')).toEqual({ kind: 'off' });
    expect(parseDndArgs(' OFF ')).toEqual({ kind: 'off' });
  });

  it('refuses nothing, a nonsense length and more than seven days', () => {
    expect(parseDndArgs('').kind).toBe('error');
    expect(parseDndArgs('soon').kind).toBe('error');
    expect(parseDndArgs('2h extra').kind).toBe('error');
    expect(parseDndArgs('1w')).toEqual({ kind: 'pause', minutes: DND_MAX_MINUTES });
    const over = parseDndArgs('2 weeks');
    expect(over).toMatchObject({ kind: 'error' });
    expect(over.kind === 'error' && over.reason).toContain('7 days');
  });
});

describe('parseMuteArgs', () => {
  it('mutes, and lets the conversation notify again with off', () => {
    expect(parseMuteArgs('')).toEqual({ kind: 'mute' });
    expect(parseMuteArgs('off')).toEqual({ kind: 'unmute' });
    expect(parseMuteArgs('OFF')).toEqual({ kind: 'unmute' });
  });

  it('says plainly that a muting for a length of time is not available, and does not mute', () => {
    expect(parseMuteArgs('2h')).toEqual({ kind: 'error', reason: MUTE_FOR_A_TIME });
    expect(parseMuteArgs('30 minutes')).toEqual({ kind: 'error', reason: MUTE_FOR_A_TIME });
    expect(parseMuteArgs('whenever').kind).toBe('error');
  });
});

describe('parseInviteArgs', () => {
  it('reads one name, with or without the at sign', () => {
    expect(parseInviteArgs('@priya')).toEqual({ kind: 'ok', handle: 'priya' });
    expect(parseInviteArgs('  priya ')).toEqual({ kind: 'ok', handle: 'priya' });
  });

  it('refuses nothing, a bare at sign and more than one name', () => {
    expect(parseInviteArgs('').kind).toBe('error');
    expect(parseInviteArgs('@').kind).toBe('error');
    expect(parseInviteArgs('@priya @rafi').kind).toBe('error');
    expect(parseInviteArgs(`@${'a'.repeat(100)}`).kind).toBe('error');
  });
});

describe('parseTopicArgs', () => {
  it('sets the topic on one line, and clears it with the word clear', () => {
    expect(parseTopicArgs('Release   planning\nfor Q4')).toEqual({ kind: 'ok', text: 'Release planning for Q4' });
    expect(parseTopicArgs('clear')).toEqual({ kind: 'ok', text: '' });
  });

  it('refuses nothing and a topic over the limit', () => {
    expect(parseTopicArgs('').kind).toBe('error');
    expect(parseTopicArgs('x'.repeat(TOPIC_MAX)).kind).toBe('ok');
    expect(parseTopicArgs('x'.repeat(TOPIC_MAX + 1)).kind).toBe('error');
  });
});

describe('parseRemindArgs: words of the language itself', () => {
  it('does not take a name of the language as a weekday', () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parseRemindArgs(`me ${word} review`, NOW, KHI).kind).toBe('error');
    }
  });
});

describe('plainCodeSpan', () => {
  it('shows what someone wrote for someone else as plain words: no link, no mention, no emphasis', () => {
    const text = 'see https://evil.example/x?a=1 and [here](https://evil.example/y), ask @rafi **now**';
    const body = `Reminder from Nadia: ${plainCodeSpan(text)}`;
    const types = new Set(parseMarkup(body).tokens.map((t) => t.type));
    expect(types.has('url')).toBe(false);
    expect(types.has('mention')).toBe(false);
    expect(body).toContain(text);
  });

  it('uses a delimiter longer than any run of backticks inside, and pads a text that starts or ends with one', () => {
    expect(plainCodeSpan('a')).toBe('`a`');
    expect(plainCodeSpan('a`b')).toBe('``a`b``');
    expect(plainCodeSpan('a``b`c')).toBe('```a``b`c```');
    expect(plainCodeSpan('`a')).toBe('`` `a ``');
    expect(plainCodeSpan('a`')).toBe('`` a` ``');
    for (const text of ['a`b https://e.example', '``` https://e.example', 'x` https://e.example `y']) {
      const types = new Set(parseMarkup(`Reminder from N: ${plainCodeSpan(text)}`).tokens.map((t) => t.type));
      expect(types.has('url')).toBe(false);
    }
  });

  it('reads a hostile text in linear time', () => {
    expectLinear((n) => '`a'.repeat(n), (input) => plainCodeSpan(input), { n: 50_000, label: 'backticks', ceilingMs: 1500 });
  });
});
