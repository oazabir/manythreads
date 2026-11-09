// tokens.txt: the design tokens as a short plain list for reviewers, and the same data for the computed-style probe (PLAN P13-02, P13-04).
// Generated from clients/web/src/styles/tokens.css:  tsx tools/review/tokens.ts --write   (or --check, which fails when tokens.txt is out of date).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib/e2e-require.ts';

export const TOKENS_CSS = join(REPO_ROOT, 'clients', 'web', 'src', 'styles', 'tokens.css');
export const TOKENS_TXT = join(dirname(fileURLToPath(import.meta.url)), 'tokens.txt');

export type Theme = 'light' | 'dark';

export interface Tokens {
  /** Custom properties that only the light palette declares. */
  light: Record<string, string>;
  dark: Record<string, string>;
  /** Built from the palette (`--you: var(--human)`), the same in both themes. */
  alias: Record<string, string>;
  /** Not theme dependent: sizes, radii, fonts, motion. */
  look: Record<string, string>;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** Reads the four kinds of block tokens.css has. A selector list that names both scopes is the alias block; `:root` alone is the look block. */
export function parseTokens(css: string): Tokens {
  const tokens: Tokens = { light: {}, dark: {}, alias: {}, look: {} };
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.replace(/\s+/g, ' ').trim();
    const decls = declarations(m[2]!);
    if (Object.keys(decls).length === 0) continue;
    const light = selector.includes('.theme-light-scope');
    const dark = selector.includes('.theme-dark-scope') || selector.includes('[data-theme="dark"]');
    if (light && dark) Object.assign(tokens.alias, decls);
    else if (light) Object.assign(tokens.light, decls);
    else if (dark) Object.assign(tokens.dark, decls);
    else if (selector === ':root') Object.assign(tokens.look, decls);
    // `:root[data-density="compact"]` and the like are density variants: not read here.
  }
  return tokens;
}

export function readTokens(file = TOKENS_CSS): Tokens {
  return parseTokens(readFileSync(file, 'utf8'));
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#RRGGBB`, `#RGB`, `rgb(1 2 3)`, `rgb(1 2 3 / 35%)`, `rgba(1, 2, 3, 0.5)`; anything else is null. */
export function parseColour(value: string): Rgba | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(v);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[5] === '%' ? Number(fn[4]) / 100 : Number(fn[4]);
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: alpha };
  }
  return null;
}

export const toHex = (c: Pick<Rgba, 'r' | 'g' | 'b'>): string => `#${[c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Every token of a theme once aliases are not followed: palette first, then the theme-independent block. */
export function themeTokens(tokens: Tokens, theme: Theme): Record<string, string> {
  return { ...(theme === 'dark' ? tokens.dark : tokens.light) };
}

export interface ColourSets {
  /** `#RRGGBB` of every opaque colour token of the theme. */
  opaque: Set<string>;
  /** `#RRGGBB` bases that tokens use with an alpha (hover, scrims, shadows, on-color-line): a see-through colour may use these. */
  base: Set<string>;
}

export function colourSets(tokens: Tokens, theme: Theme): ColourSets {
  const opaque = new Set<string>();
  const base = new Set<string>();
  const palette = themeTokens(tokens, theme);
  for (const value of Object.values(palette)) {
    const c = parseColour(value);
    if (c) (c.a >= 1 ? opaque : base).add(toHex(c));
    else if (/^\d+ \d+ \d+$/.test(value)) {
      const [r, g, b] = value.split(' ').map(Number) as [number, number, number];
      base.add(toHex({ r, g, b }));
    }
  }
  for (const value of Object.values(tokens.alias)) {
    for (const m of value.matchAll(/rgb\(\s*(\d+) (\d+) (\d+)/g)) base.add(toHex({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }));
  }
  for (const h of opaque) base.add(h);
  return { opaque, base };
}

/** Radii in px that tokens allow (`--radius-sm/md/lg`; the pill token is 999 and means "fully round"). */
export function allowedRadii(tokens: Tokens): number[] {
  const out: number[] = [];
  for (const [name, value] of Object.entries(tokens.look)) {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
    if (name.startsWith('radius-') && m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** First family of each font token, lower case, quotes removed. */
export function allowedFonts(tokens: Tokens): string[] {
  const out: string[] = [];
  for (const name of ['sans', 'mono']) {
    const value = tokens.look[name];
    if (value) out.push(value.split(',')[0]!.trim().replace(/^["']|["']$/g, '').toLowerCase());
  }
  return out;
}

const section = (title: string, rows: string[]): string[] => ['', title, ...rows];

/** The text a reviewer gets. */
export function renderTokensTxt(tokens: Tokens): string {
  const lines: string[] = [
    'manythreads design tokens',
    'Generated from clients/web/src/styles/tokens.css by tools/review/tokens.ts. Do not edit; run `tsx tools/review/tokens.ts --write`.',
    'A colour, radius or font that is not on this list is a C04 finding. The agent colour (purple) belongs to bots, the human colour (blue) to people.',
  ];
  const colourRows = (rec: Record<string, string>): string[] =>
    Object.entries(rec)
      .filter(([, v]) => parseColour(v) !== null)
      .map(([k, v]) => `  --${k}: ${v}`);
  lines.push(...section('Colours, light theme', colourRows(tokens.light)));
  lines.push(...section('Colours, dark theme', colourRows(tokens.dark)));
  lines.push(
    ...section(
      'Meanings (the same in both themes)',
      Object.entries(tokens.alias)
        .filter(([, v]) => v.startsWith('var(--'))
        .map(([k, v]) => `  --${k}: ${v}`),
    ),
  );
  lines.push(
    ...section(
      'Radii',
      Object.entries(tokens.look)
        .filter(([k]) => k.startsWith('radius-'))
        .map(([k, v]) => `  --${k}: ${v}`),
    ),
  );
  lines.push(
    ...section(
      'Fonts',
      Object.entries(tokens.look)
        .filter(([k]) => k === 'sans' || k === 'mono')
        .map(([k, v]) => `  --${k}: ${v}`),
    ),
  );
  lines.push(
    ...section(
      'Type sizes and weights',
      Object.entries(tokens.look)
        .filter(([k]) => k.startsWith('fs-') || k.startsWith('fw-') || k === 'lh-body')
        .map(([k, v]) => `  --${k}: ${v}`),
    ),
  );
  lines.push('', 'Spacing: multiples of 4 px (message rows use the --msg-* and --gutter-w tokens).', '');
  return lines.join('\n');
}

export function generateTokensTxt(file = TOKENS_CSS): string {
  return renderTokensTxt(readTokens(file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = generateTokensTxt();
  if (process.argv.includes('--write')) {
    writeFileSync(TOKENS_TXT, text);
    console.log(`tokens: wrote ${TOKENS_TXT}`);
  } else if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(TOKENS_TXT, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== text) {
      console.error('tokens: tools/review/tokens.txt is out of date; run `tsx tools/review/tokens.ts --write`');
      process.exit(1);
    }
    console.log('tokens: tokens.txt is current');
  } else process.stdout.write(text);
}
