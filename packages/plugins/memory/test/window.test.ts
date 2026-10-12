import { describe, expect, it } from 'vitest';
import { SlidingWindow } from '../src/window.ts';

describe('SlidingWindow', () => {
  it('spends up to its limit per key inside the window and recovers as entries age out', () => {
    let now = 1_000_000;
    const w = new SlidingWindow(10, 60_000, () => now);
    expect(w.remaining('a')).toBe(10);
    w.spend('a', 6);
    now += 20_000;
    w.spend('a', 4);
    expect(w.remaining('a')).toBe(0);
    expect(w.retryAfterMs('a')).toBe(40_000); // the first six leave the window in 40 s
    expect(w.remaining('b')).toBe(10); // keys are independent
    now += 40_001;
    expect(w.remaining('a')).toBe(6);
    now += 20_000;
    expect(w.remaining('a')).toBe(10);
    expect(w.retryAfterMs('a')).toBe(0);
  });

  it('ignores a spend of nothing and never goes negative', () => {
    const w = new SlidingWindow(3, 1000, () => 5);
    w.spend('a', 0);
    w.spend('a', 5);
    expect(w.remaining('a')).toBe(0);
  });
});
