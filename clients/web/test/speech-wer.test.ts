import { describe, expect, it } from 'vitest';
import { editDistance, realTimeFactor, wordErrorRate, words } from '../src/speech/wer';

describe('word error rate', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(words("  Hello, WORLD!  It's   fine. ")).toEqual(['hello', 'world', "it's", 'fine']);
    expect(wordErrorRate('Hello world', 'hello,   WORLD.')).toBe(0);
  });

  it('counts swaps, drops and additions against the real words', () => {
    expect(wordErrorRate('this is a test', 'this is the test')).toBe(0.25);
    expect(wordErrorRate('this is a test', 'this is a')).toBe(0.25);
    expect(wordErrorRate('one two', 'one two three four')).toBe(1);
    expect(editDistance(['a', 'b', 'c'], [])).toBe(3);
    expect(editDistance([], ['a'])).toBe(1);
  });

  it('has no rate without a reference', () => {
    expect(wordErrorRate('', 'anything')).toBeNull();
    expect(wordErrorRate('  ... ', 'anything')).toBeNull();
  });

  it('keeps letters of other alphabets', () => {
    expect(words('আমি ভাত খাই।')).toEqual(['আমি', 'ভাত', 'খাই']);
    expect(wordErrorRate('আমি ভাত খাই', 'আমি ভাত খাই')).toBe(0);
  });

  it('works out the real-time factor', () => {
    expect(realTimeFactor(5000, 10_000)).toBe(0.5);
    expect(realTimeFactor(5000, 0)).toBeNull();
  });
});
