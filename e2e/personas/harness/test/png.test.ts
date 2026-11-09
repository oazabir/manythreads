import { describe, expect, it } from 'vitest';
import { inspectPng, pictureProblem } from '../png.ts';
import { blankPng, busyPng, fewColoursPng, makePng } from './fixtures.ts';

describe('pictures', () => {
  it('accepts a busy screen', () => {
    expect(pictureProblem(busyPng())).toBeNull();
    expect(inspectPng(busyPng())).toMatchObject({ valid: true, width: 40, height: 40 });
  });

  it('refuses a blank page and says so', () => {
    expect(pictureProblem(blankPng())).toMatch(/blank|colour/i);
  });

  it('refuses a page of a handful of colours', () => {
    expect(pictureProblem(fewColoursPng())).toMatch(/colour/i);
  });

  it('refuses a file that is not a PNG, an empty file and a cut-off file', () => {
    expect(pictureProblem(Buffer.from('hello world, this is not a picture at all, no'))).toMatch(/not a PNG/);
    expect(pictureProblem(Buffer.alloc(0))).toMatch(/empty/);
    expect(pictureProblem(busyPng().subarray(0, 60))).not.toBeNull();
  });

  it('counts colours past the line (200) as a real screen', () => {
    const png = makePng(30, 30, (x, y) => [x * 8, y * 8, 0]);
    expect(inspectPng(png).distinctColours).toBeGreaterThan(200);
    expect(pictureProblem(png)).toBeNull();
  });
});
