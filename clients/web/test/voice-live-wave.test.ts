import { describe, expect, it } from 'vitest';
import { MIN_BAR, barOf, liveBars } from '../src/channels/voice/liveWave';
import { KEEP_PLAYED, isPlayed, markPlayed, parsePlayed, resetPlayed, withPlayed } from '../src/channels/voice/played';

// P32-05 / P32-06: the live waveform's bars and the played-state list behind the microphone badge.

describe('the live waveform bars', () => {
  it('draws silence as a stub and loud sound as a tall bar, never above the row', () => {
    expect(barOf(0)).toBe(MIN_BAR);
    expect(barOf(Number.NaN)).toBe(MIN_BAR);
    expect(barOf(-1)).toBe(MIN_BAR);
    expect(barOf(0.25)).toBeCloseTo(0.5);
    expect(barOf(1)).toBe(1);
    expect(barOf(5)).toBe(1);
  });

  it('scrolling: the newest reading is the last bar, older ones move left, an unfilled row starts with stubs', () => {
    expect(liveBars([1, 0.25], 2, 4, true)).toEqual([MIN_BAR, MIN_BAR, 1, 0.5]);
    expect(liveBars([0.25, 1, 0.25, 1, 1], 5, 3, true)).toEqual([0.5, 1, 1]);
    expect(liveBars([], 0, 3, true)).toEqual([MIN_BAR, MIN_BAR, MIN_BAR]);
    expect(liveBars([1], 1, 0, true)).toEqual([]);
  });

  it('not scrolling (reduced motion): each reading has a fixed place, so only the newest bars change', () => {
    const before = liveBars([1, 1, 1], 3, 4, false);
    expect(before).toEqual([1, 1, 1, MIN_BAR]);
    // one more reading arrives: every earlier bar stays where it was
    const after = liveBars([1, 1, 1, 0.25], 4, 4, false);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(after[3]).toBe(0.5);
    // the row is full: the next reading takes the oldest place instead of everything sliding
    expect(liveBars([1, 1, 0.25, 0.25, 1], 5, 4, false)).toEqual([1, 1, 0.5, 0.5]);
  });
});

describe('the played list', () => {
  it('moves a played id to the end and keeps only the newest ones', () => {
    expect(withPlayed(['a', 'b'], 'a')).toEqual(['b', 'a']);
    expect(withPlayed(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
    const many = Array.from({ length: KEEP_PLAYED }, (_, i) => `m${i}`);
    const next = withPlayed(many, 'new');
    expect(next).toHaveLength(KEEP_PLAYED);
    expect(next[0]).toBe('m1');
    expect(next.at(-1)).toBe('new');
  });

  it('reads only a list of strings from storage', () => {
    expect(parsePlayed(null)).toEqual([]);
    expect(parsePlayed('not json')).toEqual([]);
    expect(parsePlayed('{"a":1}')).toEqual([]);
    expect(parsePlayed('["a",1,"b"]')).toEqual(['a', 'b']);
  });

  it('remembers a played message in the store it is given, and survives a store that throws', () => {
    resetPlayed();
    const kept = new Map<string, string>();
    const good = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) } as unknown as Storage;
    expect(isPlayed('x')).toBe(false);
    markPlayed('x', good);
    expect(isPlayed('x')).toBe(true);
    expect(JSON.parse(kept.get('mt.voice.played') ?? '[]')).toEqual(['x']);
    resetPlayed();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(() => markPlayed('y', broken)).not.toThrow();
    expect(isPlayed('y')).toBe(true);
    resetPlayed();
  });
});
