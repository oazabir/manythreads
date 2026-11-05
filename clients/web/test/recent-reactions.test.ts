import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REACTIONS, loadReactions, parseReactions, pushReaction, rememberReaction } from '../src/channels/recentReactions';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('recent reactions (P21-02)', () => {
  it('starts with thumbs up, check mark and eyes', () => {
    expect([...DEFAULT_REACTIONS]).toEqual(['👍', '✅', '👀']);
    expect(parseReactions(null)).toEqual(['👍', '✅', '👀']);
  });

  it('moves a used emoji to the front and keeps the rest in order', () => {
    expect(pushReaction(['👍', '✅', '👀'], '👀')).toEqual(['👀', '👍', '✅']);
    expect(pushReaction(['👍', '✅', '👀'], '🎉')).toEqual(['🎉', '👍', '✅']);
  });

  it('never holds more than three and never repeats one', () => {
    let l: string[] = ['👍', '✅', '👀'];
    for (const e of ['🎉', '🔥', '🎉', '❤️']) l = pushReaction(l, e);
    expect(l).toEqual(['❤️', '🎉', '🔥']);
    expect(new Set(l).size).toBe(3);
  });

  it('fills a short stored list from the defaults', () => {
    expect(parseReactions('["🎉"]')).toEqual(['🎉', '👍', '✅']);
    expect(parseReactions('["🎉","🎉","🔥","❤️","😀"]')).toEqual(['🎉', '🔥', '❤️']);
  });

  it('ignores a broken or empty stored value', () => {
    for (const raw of ['', '{', '"x"', '{"a":1}', '[]', '[1,2]', '[""]']) expect(parseReactions(raw)).toEqual(['👍', '✅', '👀']);
  });

  it('survives storage that throws on read or write', () => {
    const boom = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', boom);
    expect(loadReactions()).toEqual(['👍', '✅', '👀']);
    expect(() => rememberReaction('🎉')).not.toThrow();
  });

  it('remembers across calls through storage', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    rememberReaction('🎉');
    rememberReaction('✅');
    expect(loadReactions()).toEqual(['✅', '🎉', '👍']);
  });
});
