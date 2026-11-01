import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS, RECENT_LIMIT, emojiForShortcode, leadingShortcode, SKIN_TONES, parseRecent, parseTone, pushRecent, searchEmoji, takesTone, withTone } from '../src/channels/emoji';

describe('withTone', () => {
  it('puts the tone after a hand, dropping the variation selector it replaces', () => {
    expect(withTone('👍', 3)).toBe('👍\u{1F3FD}');
    expect(withTone('✌️', 1)).toBe('✌\u{1F3FB}');
  });

  it('puts the tone on the person of a joined emoji and keeps the rest', () => {
    expect(withTone('🧑‍💻', 5)).toBe('🧑\u{1F3FF}‍💻');
  });

  it('leaves the default tone and emoji without tones alone', () => {
    expect(withTone('👍', 0)).toBe('👍');
    expect(withTone('😀', 4)).toBe('😀');
    expect(withTone('❤️', 2)).toBe('❤️');
  });

  it('does not know a tone it was not given', () => {
    expect(withTone('👍', 99)).toBe('👍');
  });
});

describe('the built-in set', () => {
  it('has no emoji twice and a name for each', () => {
    const all = EMOJI_GROUPS.flatMap((g) => g.items);
    expect(new Set(all.map((e) => e.char)).size).toBe(all.length);
    expect(all.every((e) => e.name.length > 1 && e.char.length > 0)).toBe(true);
  });

  it('has tone-taking emoji and the six tones', () => {
    expect(takesTone('👍')).toBe(true);
    expect(takesTone('😀')).toBe(false);
    expect(SKIN_TONES).toHaveLength(6);
  });
});

describe('searchEmoji', () => {
  it('finds by any word of the name, all words required', () => {
    expect(searchEmoji('rocket').map((e) => e.char)).toContain('🚀');
    expect(searchEmoji('thumbs up').map((e) => e.char)).toEqual(['👍']);
    expect(searchEmoji('THUMBS').length).toBeGreaterThan(1);
  });

  it('answers nothing for an empty query or a word nobody has', () => {
    expect(searchEmoji('   ')).toEqual([]);
    expect(searchEmoji('zzzzqq')).toEqual([]);
  });

  it('stops at the limit', () => {
    expect(searchEmoji('face', 5)).toHaveLength(5);
  });
});

describe('recent emoji', () => {
  it('puts the newest first, moves a repeat to the front, and keeps a short list', () => {
    expect(pushRecent(['👍', '🎉'], '🎉')).toEqual(['🎉', '👍']);
    const many = Array.from({ length: RECENT_LIMIT + 4 }, (_, i) => `e${i}`);
    expect(pushRecent(many, 'new')).toHaveLength(RECENT_LIMIT);
    expect(pushRecent(many, 'new')[0]).toBe('new');
  });

  it('reads storage defensively', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent(JSON.stringify(['👍', 3, '', 'x'.repeat(40), '🎉']))).toEqual(['👍', '🎉']);
    expect(parseTone('3')).toBe(3);
    expect(parseTone('9')).toBe(0);
    expect(parseTone('abc')).toBe(0);
    expect(parseTone(null)).toBe(0);
  });
});

describe('shortcodes (:coffee:)', () => {
  it('finds an emoji by the whole name, its first word, two first words run together, or any word', () => {
    expect(emojiForShortcode('palm_tree')).toBe('🌴');
    expect(emojiForShortcode(':palm_tree:')).toBe('🌴');
    expect(emojiForShortcode('smile')).toBe('😄');
    expect(emojiForShortcode('thumbsup')).toBe('👍');
    expect(emojiForShortcode('+1')).toBe('👍');
    expect(emojiForShortcode('coffee')).toBe('☕');
    expect(emojiForShortcode('Coffee')).toBe('☕');
  });

  it('answers null for a word no emoji has, and for nothing', () => {
    expect(emojiForShortcode('nosuchemoji')).toBeNull();
    expect(emojiForShortcode('')).toBeNull();
    expect(emojiForShortcode('::')).toBeNull();
  });

  it('takes a leading :code: off a text and leaves the rest', () => {
    expect(leadingShortcode(':coffee: on a break')).toEqual({ emoji: '☕', rest: 'on a break' });
    expect(leadingShortcode(':coffee:')).toEqual({ emoji: '☕', rest: '' });
    expect(leadingShortcode(':coffee:on a break')).toBeNull();
    expect(leadingShortcode('on a break :coffee:')).toBeNull();
    expect(leadingShortcode(':nosuch: x')).toBeNull();
  });
});
