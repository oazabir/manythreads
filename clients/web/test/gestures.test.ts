import { describe, expect, it } from 'vitest';
import { HOLD_SLOP_PX, SWIPE_MAX_DRIFT_PX, SWIPE_MAX_SHIFT_PX, SWIPE_REPLY_PX, SWIPE_START_PX, leftTheSpot, movePress, releasePress, startPress } from '../src/channels/gestures';

/** Walks a finger through the given points and returns the press and the last shift. */
function drag(points: ReadonlyArray<readonly [number, number]>) {
  let press = startPress(100, 300);
  let shift = 0;
  for (const [x, y] of points) {
    const next = movePress(press, x, y);
    press = next.press;
    shift = next.shift;
  }
  return { press, shift };
}

describe('row gestures on a touch screen (P21-23)', () => {
  it('a finger that goes mostly right is a swipe; the row follows it', () => {
    const { press, shift } = drag([[110, 301], [130, 302], [150, 304]]);
    expect(press.mode).toBe('swipe');
    expect(shift).toBe(50);
  });

  it('the row stops following at its rubber-band limit', () => {
    expect(drag([[130, 300], [400, 300]]).shift).toBe(SWIPE_MAX_SHIFT_PX);
  });

  it('a finger that goes up or down is a scroll: the row never moves, even if it later drifts right', () => {
    const { press, shift } = drag([[102, 330], [160, 332], [260, 335]]);
    expect(press.mode).toBe('scroll');
    expect(shift).toBe(0);
  });

  it('a drag to the left is not a swipe to reply', () => {
    const { press, shift } = drag([[80, 300], [40, 300]]);
    expect(press.mode).toBe('scroll');
    expect(shift).toBe(0);
  });

  it('nothing is decided before the finger has gone a few pixels', () => {
    const { press } = drag([[100 + SWIPE_START_PX - 2, 300]]);
    expect(press.mode).toBe('idle');
  });

  it('letting go after a long enough, straight swipe asks for the reply', () => {
    const { press } = drag([[130, 300], [100 + SWIPE_REPLY_PX, 310]]);
    expect(releasePress(press, 100 + SWIPE_REPLY_PX, 310)).toBe('reply');
  });

  it('a swipe that stops short does nothing', () => {
    const { press } = drag([[130, 300], [100 + SWIPE_REPLY_PX - 1, 300]]);
    expect(releasePress(press, 100 + SWIPE_REPLY_PX - 1, 300)).toBe('none');
  });

  it('a swipe that wandered up or down by the end does nothing', () => {
    const { press } = drag([[130, 300], [180, 310]]);
    expect(releasePress(press, 200, 300 + SWIPE_MAX_DRIFT_PX + 1)).toBe('none');
  });

  it('a press that never moved, or a scroll, never asks for a reply', () => {
    expect(releasePress(startPress(100, 300), 100, 300)).toBe('none');
    const { press } = drag([[100, 360], [300, 360]]);
    expect(releasePress(press, 300, 360)).toBe('none');
  });

  it('a hold is cancelled once the finger leaves the spot, and not by a tremble', () => {
    const p = startPress(100, 300);
    expect(leftTheSpot(p, 103, 304)).toBe(false);
    expect(leftTheSpot(p, 100 + HOLD_SLOP_PX + 1, 300)).toBe(true);
    expect(leftTheSpot(p, 100, 300 - HOLD_SLOP_PX - 1)).toBe(true);
  });
});
