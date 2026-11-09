import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowedFonts, allowedRadii, colourSets, generateTokensTxt, parseColour, parseTokens, readTokens, toHex, TOKENS_TXT } from '../tokens.ts';

describe('tokens.txt generator', () => {
  const tokens = readTokens();

  it('reads both palettes, the aliases and the look block of tokens.css', () => {
    expect(tokens.light['paper']).toBe('#EDEEF0');
    expect(tokens.dark['paper']).toBe('#0F1216');
    expect(tokens.alias['you']).toBe('var(--human)');
    expect(tokens.look['radius-md']).toBe('10px');
  });

  it('knows the radii and the font families the tokens allow', () => {
    expect(allowedRadii(tokens)).toEqual([6, 10, 14, 999]);
    expect(allowedFonts(tokens)).toEqual(['inter', 'jetbrains mono']);
  });

  it('keeps tokens.txt equal to what the generator writes today', () => {
    expect(readFileSync(TOKENS_TXT, 'utf8')).toBe(generateTokensTxt());
  });

  it('lists a colour from each theme and the radii for a reviewer', () => {
    const text = generateTokensTxt();
    expect(text).toContain('--human: #2E5C8A');
    expect(text).toContain('--human: #7FB0E3');
    expect(text).toContain('--radius-sm: 6px');
  });

  it('separates opaque colours from the bases of see-through ones', () => {
    const light = colourSets(tokens, 'light');
    expect(light.opaque.has('#FFFFFF')).toBe(true);
    expect(light.opaque.has('#7FB0E3')).toBe(false);
    expect(light.base.has('#1B2430')).toBe(true);
    expect(colourSets(tokens, 'dark').opaque.has('#7FB0E3')).toBe(true);
  });

  it('parses the colour notations tokens.css and Chromium use', () => {
    expect(parseColour('#1b2430')).toEqual({ r: 27, g: 36, b: 48, a: 1 });
    expect(parseColour('rgb(255 255 255 / 35%)')).toEqual({ r: 255, g: 255, b: 255, a: 0.35 });
    expect(parseColour('rgba(27, 36, 48, 0.06)')).toEqual({ r: 27, g: 36, b: 48, a: 0.06 });
    expect(parseColour('var(--x)')).toBeNull();
    expect(toHex({ r: 1, g: 2, b: 255 })).toBe('#0102FF');
  });

  it('ignores comments and density variants', () => {
    const t = parseTokens('/* { --x: 1; } */ :root { --a: 1px; } :root[data-density="compact"] { --a: 2px; }');
    expect(t.look).toEqual({ a: '1px' });
  });
});
