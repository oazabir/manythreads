import { describe, expect, it } from 'vitest';
import { LIMIT_NOTE, formatClock, reachedLimit, warningAt } from '../src/channels/voice/clock';

describe('voice clock', () => {
  it('writes minutes and seconds, never rounding up', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(12_999)).toBe('0:12');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(300_000)).toBe('5:00');
    expect(formatClock(-5)).toBe('0:00');
  });

  it('knows when the limit is reached and says why', () => {
    expect(reachedLimit(299_999)).toBe(false);
    expect(reachedLimit(300_000)).toBe(true);
    expect(LIMIT_NOTE).toBe('Voice messages stop at 5 minutes.');
  });

  it('warns once at one minute and once at thirty seconds left', () => {
    expect(warningAt(100_000, 0)).toBeNull();
    const first = warningAt(240_000, 0);
    expect(first).toEqual({ text: 'One minute left', said: 1 });
    expect(warningAt(250_000, 1)).toBeNull();
    expect(warningAt(270_000, 1)).toEqual({ text: '30 seconds left', said: 2 });
    expect(warningAt(290_000, 2)).toBeNull();
  });
});
