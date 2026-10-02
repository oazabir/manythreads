/*
 * Windowing arithmetic for the message list (PLAN criterion 9: 5,000 messages at p95 frame time under 20 ms). Only the rows near
 * the viewport are in the DOM; every other row is a number. Pure functions, so they are unit tested without a browser.
 */

/** `offsets[i]` is the top of row `i`; `offsets[n]` is the total height. Unmeasured rows use their estimate. */
export function buildOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate: (index: number) => number): number[] {
  const offsets = new Array<number>(keys.length + 1);
  let y = 0;
  for (let i = 0; i < keys.length; i += 1) {
    offsets[i] = y;
    y += heights.get(keys[i] as string) ?? estimate(i);
  }
  offsets[keys.length] = y;
  return offsets;
}

/** The row that contains vertical position `y` (clamped to the first and last row). */
export function indexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] as number) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The rows to draw for a viewport: `start` inclusive, `end` exclusive, with `overscan` pixels of margin on both sides. */
export function windowFor(offsets: readonly number[], top: number, viewport: number, overscan: number): { start: number; end: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const total = offsets[n] as number;
  const y = Math.min(Math.max(0, top), Math.max(0, total - viewport));
  const start = indexAt(offsets, Math.max(0, y - overscan));
  let end = indexAt(offsets, y + viewport + overscan) + 1;
  end = Math.min(n, Math.max(end, start + 1));
  return { start, end };
}

/** The row at the top of the viewport and how far its top edge is from the viewport's top (negative: it starts above). */
export type Anchor = { key: string; delta: number };

/** Remember what the reader is looking at: the row at `scrollTop`. `listTop` is where the first row starts inside the scroll area. */
export function anchorAt(
  keys: readonly string[],
  offsets: readonly number[],
  listTop: number,
  scrollTop: number,
  /** Rows that make a good anchor (a message, not a day divider that stays first while older rows arrive after it). */
  usable: (index: number) => boolean = () => true,
): Anchor | null {
  if (keys.length === 0) return null;
  let i = indexAt(offsets, scrollTop - listTop);
  for (let j = i; j < keys.length; j += 1) {
    if (usable(j)) {
      i = j;
      break;
    }
  }
  return { key: keys[i] as string, delta: listTop + (offsets[i] as number) - scrollTop };
}

/**
 * Where to scroll so the anchored row is where it was on screen, after rows were added or removed above it (older messages
 * loaded in front, a message deleted). Null when the row is gone.
 */
export function scrollTopFor(anchor: Anchor, keys: readonly string[], offsets: readonly number[], listTop: number): number | null {
  const i = keys.indexOf(anchor.key);
  return i < 0 ? null : listTop + (offsets[i] as number) - anchor.delta;
}
