import { parseHex, ratio } from './contrast.ts';
import { pairs, type Pair } from './pairs.ts';

export type Theme = 'light' | 'dark';

interface Block {
  selectors: string[];
  decls: Map<string, string>;
}

/** The flat `{ selector list { --name: value } }` blocks of tokens.css (it has no nesting and no media queries). */
export function parseBlocks(css: string): Block[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Block[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const decls = new Map<string, string>();
    for (const d of (m[2] as string).split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const name = d.slice(0, i).trim();
      if (name.startsWith('--')) decls.set(name, d.slice(i + 1).trim());
    }
    blocks.push({ selectors: (m[1] as string).split(',').map((s) => s.trim().replace(/\s+/g, '')), decls });
  }
  return blocks;
}

const LIGHT = [':root', '.theme-light-scope'];
const DARK = [':root[data-theme="dark"]', '.theme-dark-scope'];

/** The custom properties a theme ends with: the light blocks in file order, then (for dark) the dark blocks on top. */
export function tokensFor(css: string, theme: Theme): Map<string, string> {
  const blocks = parseBlocks(css);
  const out = new Map<string, string>();
  const apply = (names: string[]): void => {
    for (const b of blocks) if (b.selectors.some((s) => names.includes(s))) for (const [k, v] of b.decls) out.set(k, v);
  };
  apply(LIGHT);
  if (theme === 'dark') apply(DARK);
  return out;
}

/** A token's value with `var(--x)` chains followed; null when it ends in something that is not a flat hex colour. */
export function resolveColour(tokens: ReadonlyMap<string, string>, name: string, depth = 0): string | null {
  const raw = tokens.get(`--${name}`);
  if (raw === undefined || depth > 8) return null;
  const ref = /^var\(\s*--([a-z0-9-]+)\s*(?:,[^)]*)?\)$/.exec(raw);
  if (ref) return resolveColour(tokens, ref[1] as string, depth + 1);
  return parseHex(raw) ? raw : null;
}

export interface Failure {
  theme: Theme;
  fg: string;
  bg: string;
  min: number;
  got: number | null;
  kind: Pair['kind'];
}

export interface AllowEntry {
  theme: Theme;
  fg: string;
  bg: string;
  reason: string;
}

/** Every pair under its ratio in the theme. A pair whose token is missing or not a flat colour fails with `got: null`. */
export function failures(css: string, theme: Theme, list: Pair[] = pairs()): Failure[] {
  const tokens = tokensFor(css, theme);
  const out: Failure[] = [];
  for (const p of list) {
    const fg = resolveColour(tokens, p.fg);
    const bg = resolveColour(tokens, p.bg);
    const a = fg ? parseHex(fg) : null;
    const b = bg ? parseHex(bg) : null;
    if (!a || !b) {
      out.push({ theme, ...p, got: null });
      continue;
    }
    const got = ratio(a, b);
    if (got < p.min) out.push({ theme, ...p, got });
  }
  return out;
}

/** The failures nobody allowed, and the allow entries that no longer match a failure (so the list shrinks as the palette is fixed). */
export function judge(found: Failure[], allow: AllowEntry[]): { failing: Failure[]; unused: AllowEntry[] } {
  const same = (f: Failure, a: AllowEntry): boolean => f.theme === a.theme && f.fg === a.fg && f.bg === a.bg;
  return {
    failing: found.filter((f) => !allow.some((a) => same(f, a))),
    unused: allow.filter((a) => !found.some((f) => same(f, a))),
  };
}

export function describe(f: Failure): string {
  const got = f.got === null ? 'not a flat colour' : `${f.got.toFixed(2)}:1`;
  return `${f.theme}: --${f.fg} on --${f.bg} is ${got}, needs ${f.min}:1 (${f.kind})`;
}
