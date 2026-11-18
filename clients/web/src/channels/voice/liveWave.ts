/**
 * The bars of the live waveform in the recording bar (P32-05), as plain functions. The meter hands over the newest level readings (0 to 1); a bar's
 * height is a gentle curve of its reading (speech is rarely louder than half of full scale, a straight line would leave the bars short), with a
 * stub for silence so the row never looks empty.
 */

/** The shortest bar, as a share of the row's height. */
export const MIN_BAR = 0.1;

/** The height (MIN_BAR to 1) of the bar for a reading. */
export function barOf(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return MIN_BAR;
  return Math.min(1, Math.max(MIN_BAR, Math.sqrt(level)));
}

/**
 * The heights of `count` bars. Scrolling: the newest reading is the last bar and older ones move left (a row not yet filled starts with stubs).
 * Not scrolling (reduced motion): every reading has a fixed place (`its number` modulo `count`), so only the newest bars change and nothing slides;
 * `total` is how many readings were taken in all, which tells where the newest one goes.
 */
export function liveBars(tail: readonly number[], total: number, count: number, scroll: boolean): number[] {
  const bars: number[] = Array.from({ length: count }, () => MIN_BAR);
  if (count <= 0) return bars;
  if (scroll) {
    const shown = tail.slice(-count);
    const offset = count - shown.length;
    shown.forEach((v, i) => void (bars[offset + i] = barOf(v)));
    return bars;
  }
  const first = total - tail.length;
  tail.forEach((v, i) => void (bars[(first + i) % count] = barOf(v)));
  return bars;
}
