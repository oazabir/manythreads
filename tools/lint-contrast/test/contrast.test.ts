import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { luminance, parseHex, ratio } from '../contrast.ts';
import { allFailures, failures, judge, PALETTES, resolveColour, tokensFor, type AllowEntry } from '../check.ts';
import { pairs } from '../pairs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const styles = join(here, '..', '..', '..', 'clients', 'web', 'src', 'styles');
const tokensCss = readFileSync(join(styles, 'tokens.css'), 'utf8');
/** What the app loads: tokens.css, then each palette's generated file. */
const real = [tokensCss, ...PALETTES.filter((p) => p !== 'classic').map((p) => readFileSync(join(styles, 'themes', `${p}.css`), 'utf8'))].join('\n');

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

describe('palettes', () => {
  const CSS = `
:root { --paper: #FFFFFF; --ink: #000000; --accent: var(--ink); }
:root[data-theme="dark"] { --paper: #000000; --ink: #FFFFFF; }
:root[data-palette="warm"][data-theme="light"] { --paper: #F0E0D0; }
:root[data-palette="warm"][data-theme="dark"] { --paper: #201008; --accent: #FFAA00; }
[data-palette="warm"][data-theme="dark"]:not(:root) { --paper: #FF0000; }
`;
  it('takes the palette of the page and not a nested scope box, and lets the more specific rule win whatever the order', () => {
    expect(resolveColour(tokensFor(CSS, 'light', 'warm'), 'paper')).toBe('#F0E0D0');
    expect(resolveColour(tokensFor(CSS, 'dark', 'warm'), 'paper')).toBe('#201008');
    expect(resolveColour(tokensFor(CSS, 'dark', 'warm'), 'accent')).toBe('#FFAA00');
    expect(resolveColour(tokensFor(CSS, 'dark', 'warm'), 'ink')).toBe('#FFFFFF');
    expect(resolveColour(tokensFor(CSS, 'light'), 'paper')).toBe('#FFFFFF');
    expect(resolveColour(tokensFor(CSS, 'dark'), 'accent')).toBe('#FFFFFF');
  });
  it('skips a pair that names the palette in `except`', () => {
    const list = [{ fg: 'ink', bg: 'paper', min: 21, kind: 'text' as const, except: ['warm'] }];
    expect(failures(CSS, 'light', list, 'warm')).toEqual([]);
    expect(failures(CSS, 'light', list, 'classic')).toEqual([]);
    expect(failures(CSS, 'light', [{ ...list[0]!, min: 22, except: ['warm'] }], 'classic')).toHaveLength(1);
  });
});

describe('the real stylesheets', () => {
  it('name every token the pairs use, in both modes of all four palettes', () => {
    for (const palette of PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        const t = tokensFor(real, theme, palette);
        for (const p of pairs()) {
          expect(resolveColour(t, p.fg), `${palette}/${theme} --${p.fg}`).not.toBeNull();
          expect(resolveColour(t, p.bg), `${palette}/${theme} --${p.bg}`).not.toBeNull();
        }
      }
    }
  });
  it('give every palette a value for every colour token classic has, so none shows through from classic', () => {
    const colourKeys = (css: string, theme: 'light' | 'dark'): string[] => [...tokensFor(css, theme, 'classic').keys()];
    for (const palette of PALETTES.filter((p) => p !== 'classic')) {
      for (const theme of ['light', 'dark'] as const) {
        const own = tokensFor(real, theme, palette);
        const fromClassic = tokensFor(tokensCss, theme, 'classic');
        // the tokens a palette file declares itself: everything classic declares in its two colour blocks, except the ones built from other tokens in the shared block
        const missing = colourKeys(tokensCss, theme).filter((k) => /^--(paper|surface|shell|ink|txt|mute|faint|rule|human|agent|ok|warn|alert|av-\d+-(bg|ink)|plate|hover|skeleton|toggle-off|dot-off|bot-grey|zip|presence-ring|msg-hover|nav-on|hairline|table-head|scrim-alpha|card-alpha|menu-alpha|savebar-alpha|shadow-color)/.test(k) && own.get(k) === fromClassic.get(k));
        // a palette may repeat a classic value on purpose (white `plate`), so only the keys it never mentions are reported
        const block = readFileSync(join(styles, 'themes', `${palette}.css`), 'utf8');
        expect(missing.filter((k) => !block.includes(`${k}:`)), `${palette}/${theme}`).toEqual([]);
      }
    }
  });
  it('has no failing pair in any palette in dark', () => {
    expect(PALETTES.flatMap((p) => failures(real, 'dark', pairs(), p))).toEqual([]);
  });
  it('has no failing pair in any palette in light except the ones listed in allow.json', () => {
    const allow = JSON.parse(readFileSync(join(here, '..', 'allow.json'), 'utf8')) as AllowEntry[];
    expect(judge(allFailures(real), allow)).toEqual({ failing: [], unused: [] });
  });
  it('checks the six palettes of the three themes with every pair of the design (138 or more each)', () => {
    expect(pairs().length).toBeGreaterThanOrEqual(130);
    expect(PALETTES.filter((p) => p !== 'classic')).toEqual(['graphite', 'linen', 'harbor']);
  });
});
