import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { luminance, parseHex, ratio } from '../contrast.ts';
import { failures, judge, resolveColour, tokensFor, type AllowEntry } from '../check.ts';
import { pairs } from '../pairs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const real = readFileSync(join(here, '..', '..', '..', 'clients', 'web', 'src', 'styles', 'tokens.css'), 'utf8');

const SMALL = `
:root { --paper: #FFFFFF; --ink: #000000; --soft: var(--ink); --faint: #777777; --shadow: rgb(0 0 0 / 5%); }
:root[data-theme="dark"] { --paper: #000000; --ink: #FFFFFF; }
:root { --late: #123456; }
`;

describe('ratio', () => {
  it('is 21 for black on white, 1 for the same colour and the same both ways', () => {
    const black = parseHex('#000000')!;
    const white = parseHex('#FFFFFF')!;
    expect(ratio(black, white)).toBeCloseTo(21, 5);
    expect(ratio(white, black)).toBeCloseTo(21, 5);
    expect(ratio(white, white)).toBe(1);
  });
  it('matches a known mid-grey value', () => {
    // #777777 on white is 4.48:1 (the classic just-under-AA grey)
    expect(ratio(parseHex('#777777')!, parseHex('#FFFFFF')!)).toBeCloseTo(4.48, 2);
    expect(luminance(parseHex('#808080')!)).toBeCloseTo(0.2159, 3);
  });
  it('reads short hex and refuses anything that is not a flat colour', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('rgb(0 0 0 / 5%)')).toBeNull();
    expect(parseHex('var(--ink)')).toBeNull();
  });
});

describe('tokensFor', () => {
  it('lays the dark block over the light one and follows var() chains', () => {
    const light = tokensFor(SMALL, 'light');
    const dark = tokensFor(SMALL, 'dark');
    expect(resolveColour(light, 'paper')).toBe('#FFFFFF');
    expect(resolveColour(dark, 'paper')).toBe('#000000');
    expect(resolveColour(dark, 'soft')).toBe('#FFFFFF');
    expect(resolveColour(dark, 'late')).toBe('#123456');
    expect(resolveColour(light, 'shadow')).toBeNull();
    expect(resolveColour(light, 'missing')).toBeNull();
  });
});

describe('failures and judge', () => {
  it('reports a pair under its ratio and lets an allow entry cover it', () => {
    const list = [{ fg: 'faint', bg: 'paper', min: 4.5, kind: 'text' as const }, { fg: 'ink', bg: 'paper', min: 4.5, kind: 'text' as const }];
    const found = failures(SMALL, 'light', list);
    expect(found.map((f) => f.fg)).toEqual(['faint']);
    expect(failures(SMALL, 'dark', list)).toEqual([]);
    const allow: AllowEntry[] = [{ theme: 'light', fg: 'faint', bg: 'paper', reason: 'test' }, { theme: 'dark', fg: 'ink', bg: 'paper', reason: 'old' }];
    const { failing, unused } = judge(found, allow);
    expect(failing).toEqual([]);
    expect(unused.map((a) => a.theme)).toEqual(['dark']);
  });
  it('fails a pair whose token is missing instead of passing it', () => {
    const found = failures(SMALL, 'light', [{ fg: 'nope', bg: 'paper', min: 3, kind: 'mark' }]);
    expect(found).toHaveLength(1);
    expect(found[0]?.got).toBeNull();
  });
});

describe('the real tokens.css', () => {
  it('names every token the pairs use in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const t = tokensFor(real, theme);
      for (const p of pairs()) {
        expect(resolveColour(t, p.fg), `${theme} --${p.fg}`).not.toBeNull();
        expect(resolveColour(t, p.bg), `${theme} --${p.bg}`).not.toBeNull();
      }
    }
  });
  it('has no failing pair in dark', () => {
    expect(failures(real, 'dark')).toEqual([]);
  });
  it('has no failing pair in light except the ones listed in allow.json', () => {
    const allow = JSON.parse(readFileSync(join(here, '..', 'allow.json'), 'utf8')) as AllowEntry[];
    expect(judge(failures(real, 'light'), allow)).toEqual({ failing: [], unused: [] });
  });
});
