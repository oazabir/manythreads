import { describe, expect, it } from 'vitest';
import { anchorAt, buildOffsets, indexAt, scrollTopFor, shiftAfter, windowFor } from '../src/channels/virtual';

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `k${i}`);

describe('windowing arithmetic', () => {
  it('offsets use the measured height, else the estimate', () => {
    const o = buildOffsets(['a', 'b', 'c'], new Map([['b', 100]]), () => 50);
    expect(o).toEqual([0, 50, 150, 200]);
  });

  it('a measured row shifts the rows after it, the same as rebuilding from the heights', () => {
    const ks = keys(6);
    const heights = new Map<string, number>();
    const o = buildOffsets(ks, heights, () => 50);
    heights.set('k2', 80);
    shiftAfter(o, 2, 30);
    expect(o).toEqual(buildOffsets(ks, heights, () => 50));
    heights.set('k5', 20);
    shiftAfter(o, 5, -30);
    expect(o).toEqual(buildOffsets(ks, heights, () => 50));
  });

  it('finds the row at a position, clamped at both ends', () => {
    const o = buildOffsets(keys(5), new Map(), () => 10);
    expect([indexAt(o, -5), indexAt(o, 0), indexAt(o, 9), indexAt(o, 10), indexAt(o, 49), indexAt(o, 500)]).toEqual([0, 0, 0, 1, 4, 4]);
    expect(indexAt([0], 5)).toBe(0);
  });

  it('draws only the rows near the viewport: 5,000 rows give a few dozen', () => {
    const o = buildOffsets(keys(5_000), new Map(), () => 60);
    const w = windowFor(o, 100_000, 800, 700);
    expect(w.end - w.start).toBeLessThan(60);
    expect(o[w.start] as number).toBeLessThanOrEqual(100_000 - 700);
    expect(o[w.end] as number).toBeGreaterThanOrEqual(100_000 + 800 + 700);
    // asking for far beyond the end shows the last rows
    const last = windowFor(o, Number.MAX_SAFE_INTEGER, 800, 700);
    expect(last.end).toBe(5_000);
    expect(windowFor(o, 0, 800, 700).start).toBe(0);
    expect(windowFor([0], 0, 800, 700)).toEqual({ start: 0, end: 0 });
  });

  it('keeps the reader on the same row when older rows arrive after a divider (the first row stays first)', () => {
    const before = ['day', 'k0', 'k1', 'k2'];
    const o1 = buildOffsets(before, new Map(), () => 100);
    const listTop = 20;
    // scrolled so k0 starts 70 px above the top of the view (k1 begins 30 px below it)
    const anchor = anchorAt(before, o1, listTop, listTop + o1[2]! - 30);
    expect(anchor).toEqual({ key: 'k0', delta: -70 });
    const after = ['day', 'old1', 'old2', 'old3', 'k0', 'k1', 'k2'];
    const o2 = buildOffsets(after, new Map(), () => 100);
    expect(scrollTopFor(anchor!, after, o2, listTop)).toBe(listTop + o2[4]! + 70);
    expect(scrollTopFor({ key: 'gone', delta: 0 }, after, o2, listTop)).toBeNull();
    expect(anchorAt([], [0], 0, 0)).toBeNull();
    // at the very top the first row is a divider: the first message below it is the anchor
    expect(anchorAt(before, o1, listTop, listTop, (i) => before[i] !== 'day')).toEqual({ key: 'k0', delta: 100 });
  });
});
