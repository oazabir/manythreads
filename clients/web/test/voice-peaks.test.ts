import { describe, expect, it } from 'vitest';
import { PEAK_BARS, levelOf, reducePeaks } from '../src/channels/voice/peaks';

describe('voice peaks', () => {
  it('reads silence as 0 and a full swing as 1', () => {
    expect(levelOf(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(levelOf(new Uint8Array([128, 0, 255]))).toBe(1);
    expect(levelOf(new Uint8Array([128, 192]))).toBe(0.5);
    expect(levelOf([])).toBe(0);
  });

  it('keeps one bar per reading when there are few', () => {
    expect(reducePeaks([0.5, 1])).toEqual([128, 255]);
  });

  it('folds many readings into 64 bars, loudest bar 255', () => {
    const levels = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 0.8 : 0.1));
    const bars = reducePeaks(levels);
    expect(bars).toHaveLength(PEAK_BARS);
    expect(Math.max(...bars)).toBe(255);
    expect(bars.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
    expect(bars.filter((b) => b === 255)).toHaveLength(1);
  });

  it('gives nothing for no readings and zeros for silence', () => {
    expect(reducePeaks([])).toEqual([]);
    expect(reducePeaks([0, 0, 0])).toEqual([0, 0, 0]);
    expect(reducePeaks([Number.NaN, 0.5])).toEqual([0, 255]);
  });

  it('honours another bar count', () => {
    expect(reducePeaks(Array.from({ length: 100 }, () => 1), 32)).toHaveLength(32);
  });
});
