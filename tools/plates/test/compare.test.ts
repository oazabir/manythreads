import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { checkOrder, compareLandmarks, comparePngs, CLASS_P, CLASS_P_LOOSE, CLASS_W } from '../src/compare.ts';

function solid(w: number, h: number, rgb = [255, 255, 255]): PNG {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = rgb[0]!; p.data[i + 1] = rgb[1]!; p.data[i + 2] = rgb[2]!; p.data[i + 3] = 255; }
  return p;
}
const buf = (p: PNG) => PNG.sync.write(p);

describe('comparePngs', () => {
  it('identical images give 0', () => {
    expect(comparePngs(buf(solid(20, 20)), buf(solid(20, 20))).diffRatio).toBe(0);
  });
  it('one changed pixel gives ratio > 0', () => {
    const b = solid(20, 20); b.data[0] = 0; b.data[1] = 0; b.data[2] = 0;
    const r = comparePngs(buf(solid(20, 20)), buf(b));
    expect(r.diffPixels).toBe(1);
    expect(r.diffRatio).toBeGreaterThan(0);
  });
  it('mask excludes the changed region', () => {
    const b = solid(20, 20); b.data[0] = 0; b.data[1] = 0; b.data[2] = 0;
    const r = comparePngs(buf(solid(20, 20)), buf(b), { masks: [{ x: 0, y: 0, w: 5, h: 5 }] });
    expect(r.diffRatio).toBe(0);
  });
  it('pads different sizes and counts the padding as different', () => {
    expect(comparePngs(buf(solid(10, 10)), buf(solid(20, 10))).diffRatio).toBeGreaterThan(0);
  });
});

describe('landmarks', () => {
  const e = [{ name: 'a', x: 0, y: 0, w: 100, h: 50 }];
  it('passes within tolerance', () => {
    expect(compareLandmarks(e, [{ name: 'a', x: 5, y: -6, w: 104, h: 50 }], 6)).toEqual([]);
  });
  it('fails beyond tolerance and when missing', () => {
    expect(compareLandmarks(e, [{ name: 'a', x: 7, y: 0, w: 100, h: 50 }], 6)).toHaveLength(1);
    expect(compareLandmarks(e, [], 6)[0]?.problem).toBe('missing');
  });
  it('order check', () => {
    const l = [
      { name: 'rail', x: 0, y: 0, w: 100, h: 100 },
      { name: 'header', x: 100, y: 0, w: 300, h: 40 },
      { name: 'content', x: 100, y: 40, w: 300, h: 60 },
    ];
    expect(checkOrder(l, ['rail', 'header', 'content'])).toEqual([]);
    expect(checkOrder(l, ['content', 'header'])).toHaveLength(1);
    expect(checkOrder(l, ['rail', 'nope'])[0]?.problem).toBe('missing');
  });
  it('exports class constants', () => {
    expect(CLASS_P).toEqual({ landmarkPx: 6, maxDiffRatio: 0.06 });
    expect(CLASS_P_LOOSE.maxDiffRatio).toBe(0.12);
    expect(CLASS_W.maxDiffRatio).toBe(0.002);
  });
});
