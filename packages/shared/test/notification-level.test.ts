import { describe, expect, it } from 'vitest';
import {
  KEYWORD_MAX_LENGTH,
  KEYWORD_MAX_WORDS,
  PutChannelLevelRequest,
  PutNotificationKeywordsRequest,
  defaultLevelFor,
  effectiveLevel,
  firstWordOf,
  levelAllows,
  matchKeywords,
  normalizeKeyword,
  wordsOf,
  type NotificationKind,
  type NotificationLevel,
} from '../src/index.ts';

// P14-09: what each notification level lets through, and what counts as a keyword in a message.

describe('levelAllows', () => {
  const kinds: NotificationKind[] = ['mention', 'reply', 'dm', 'message'];
  const table: Record<NotificationLevel, Record<NotificationKind, boolean>> = {
    all: { mention: true, reply: true, dm: true, message: true },
    mentions: { mention: true, reply: true, dm: false, message: false },
    nothing: { mention: false, reply: false, dm: false, message: false },
  };
  for (const level of Object.keys(table) as NotificationLevel[]) {
    it(`level ${level}`, () => {
      for (const kind of kinds) expect(levelAllows(level, kind), `${level}/${kind}`).toBe(table[level][kind]);
    });
  }
});

describe('the level that applies', () => {
  it('a direct message tells by default whatever the workspace says; a channel follows the workspace', () => {
    expect(defaultLevelFor('dm', 'nothing')).toBe('all');
    expect(defaultLevelFor('channel', 'mentions')).toBe('mentions');
    expect(defaultLevelFor('channel', 'all')).toBe('all');
  });
  it('a person’s own choice wins over the default, in both directions', () => {
    expect(effectiveLevel('nothing', 'channel', 'all')).toBe('nothing');
    expect(effectiveLevel('all', 'channel', 'nothing')).toBe('all');
    expect(effectiveLevel('mentions', 'dm', 'all')).toBe('mentions');
    expect(effectiveLevel(null, 'channel', 'mentions')).toBe('mentions');
  });
});

describe('keywords', () => {
  it('matches whole words in any case, and not parts of words', () => {
    expect(matchKeywords('The Deploy failed!', ['deploy'])).toEqual(['deploy']);
    expect(matchKeywords('DEPLOYMENT is fine', ['deploy'])).toEqual([]);
    expect(matchKeywords('a category of cats', ['cat'])).toEqual([]);
    expect(matchKeywords('Cat!', ['cat'])).toEqual(['cat']);
    expect(matchKeywords('re-deploy it', ['deploy'])).toEqual(['deploy']);
    expect(matchKeywords('snake_case word', ['snake'])).toEqual([]);
    expect(matchKeywords('snake_case word', ['snake_case'])).toEqual(['snake_case']);
  });

  it('matches a phrase only when its words follow one another', () => {
    expect(matchKeywords('the build is red, deploy failed again', ['deploy failed'])).toEqual(['deploy failed']);
    expect(matchKeywords('deploy has failed', ['deploy failed'])).toEqual([]);
    expect(matchKeywords('failed deploy', ['deploy failed'])).toEqual([]);
  });

  it('works for letters beyond ASCII and ignores width and case variants', () => {
    expect(matchKeywords('Straße und Café', ['café'])).toEqual(['café']);
    expect(matchKeywords('ＤＥＰＬＯＹ now', ['deploy'])).toEqual(['deploy']);
    expect(matchKeywords('نشر الآن', ['نشر'])).toEqual(['نشر']);
  });

  it('returns every keyword that is present, nothing for an empty text or list', () => {
    expect(matchKeywords('deploy and rollback', ['deploy', 'rollback', 'billing'])).toEqual(['deploy', 'rollback']);
    expect(matchKeywords('', ['deploy'])).toEqual([]);
    expect(matchKeywords('deploy', [])).toEqual([]);
  });

  it('normalizes what a person types and refuses what cannot be matched', () => {
    expect(normalizeKeyword('  Deploy   Failed ')).toEqual({ keyword: 'deploy failed' });
    expect(normalizeKeyword('prod!')).toEqual({ keyword: 'prod' });
    expect(normalizeKeyword('!!!')).toEqual({ problem: 'empty' });
    expect(normalizeKeyword('a '.repeat(KEYWORD_MAX_WORDS + 1))).toEqual({ problem: 'too_many_words' });
    expect(normalizeKeyword('x'.repeat(KEYWORD_MAX_LENGTH + 1))).toEqual({ problem: 'too_long' });
    expect(firstWordOf('deploy failed')).toBe('deploy');
  });

  it('stays fast on hostile text: a very long message, and one word repeated', () => {
    const long = 'deploy '.repeat(200_000);
    const t0 = performance.now();
    expect(matchKeywords(long, ['deploy failed', 'zzz', 'deploy deploy deploy deploy'])).toEqual(['deploy deploy deploy deploy']);
    expect(matchKeywords('a'.repeat(1_000_000), ['a'])).toEqual([]);
    expect(wordsOf('x '.repeat(100_000)).length).toBeLessThanOrEqual(4_000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('request shapes', () => {
  it('a level is one of three or null; extra keys are refused', () => {
    expect(PutChannelLevelRequest.safeParse({ level: 'all' }).success).toBe(true);
    expect(PutChannelLevelRequest.safeParse({ level: null }).success).toBe(true);
    expect(PutChannelLevelRequest.safeParse({ level: 'loud' }).success).toBe(false);
    expect(PutChannelLevelRequest.safeParse({ level: 'all', extra: 1 }).success).toBe(false);
  });
  it('keywords come as a bounded list', () => {
    expect(PutNotificationKeywordsRequest.safeParse({ keywords: ['deploy'] }).success).toBe(true);
    expect(PutNotificationKeywordsRequest.safeParse({ keywords: Array.from({ length: 41 }, (_, i) => `k${i}`) }).success).toBe(false);
  });
});
