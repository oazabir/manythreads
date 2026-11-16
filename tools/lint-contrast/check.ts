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

/** The palettes of the app, in the order they are drawn: `classic` is tokens.css itself, the others are generated into themes/<id>.css. */
export const PALETTES = ['classic', 'graphite', 'linen', 'harbor'] as const;
export type Palette = (typeof PALETTES)[number];

/** How strongly a selector binds: attributes, classes and pseudo-classes (`:root` counts as one). */
function specificity(selector: string): number {
  return (selector.match(/\[[^\]]+\]|\.[\w-]+|:[\w-]+/g) ?? []).length;
}

/** Does `selector` (spaces removed) match the page itself, drawn in `palette` and `theme`? Only selectors that start at `:root` can; a scope box does not. */
function matchesPage(selector: string, theme: Theme, palette: string): boolean {
  if (!selector.startsWith(':root')) return false;
  const rest = selector.slice(':root'.length);
  if (/:[a-z-]+\(/.test(rest)) return false; // :not(...) and the like never describe the page itself
  const attrs = [...rest.matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
  if (attrs.length === 0 && rest !== '') return false;
  return attrs.every(([, name, value]) => (name === 'data-theme' ? value === theme : name === 'data-palette' ? value === palette : false));
}

/**
 * The custom properties a palette ends with in a theme: every block that matches the page, applied by specificity and then file order, as the browser does.
 * `css` is tokens.css followed by the palette files; a palette with no block of its own ends with the classic values.
 */
export function tokensFor(css: string, theme: Theme, palette: string = 'classic'): Map<string, string> {
  const hits: { spec: number; order: number; decls: Map<string, string> }[] = [];
  parseBlocks(css).forEach((b, order) => {
    const spec = Math.max(-1, ...b.selectors.filter((s) => matchesPage(s, theme, palette)).map(specificity));
    if (spec >= 0) hits.push({ spec, order, decls: b.decls });
  });
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const out = new Map<string, string>();
  for (const h of hits) for (const [k, v] of h.decls) out.set(k, v);
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
  palette: string;
  theme: Theme;
  fg: string;
  bg: string;
  min: number;
  got: number | null;
  kind: Pair['kind'];
}

export interface AllowEntry {
  /** Omitted means `classic`. */
  palette?: string;
  theme: Theme;
  fg: string;
  bg: string;
  reason: string;
}

/** Every pair under its ratio in the theme. A pair whose token is missing or not a flat colour fails with `got: null`. */
export function failures(css: string, theme: Theme, list: Pair[] = pairs(), palette: string = 'classic'): Failure[] {
  const tokens = tokensFor(css, theme, palette);
  const out: Failure[] = [];
  for (const p of list) {
    if (p.except?.includes(palette)) continue;
    const fg = resolveColour(tokens, p.fg);
    const bg = resolveColour(tokens, p.bg);
    const a = fg ? parseHex(fg) : null;
    const b = bg ? parseHex(bg) : null;
    if (!a || !b) {
      out.push({ palette, theme, ...p, got: null });
      continue;
    }
    const got = ratio(a, b);
    if (got < p.min) out.push({ palette, theme, ...p, got });
  }
  return out;
}

/** The failures nobody allowed, and the allow entries that no longer match a failure (so the list shrinks as the palette is fixed). */
export function judge(found: Failure[], allow: AllowEntry[]): { failing: Failure[]; unused: AllowEntry[] } {
  const same = (f: Failure, a: AllowEntry): boolean => f.palette === (a.palette ?? 'classic') && f.theme === a.theme && f.fg === a.fg && f.bg === a.bg;
  return {
    failing: found.filter((f) => !allow.some((a) => same(f, a))),
    unused: allow.filter((a) => !found.some((f) => same(f, a))),
  };
}

export function describe(f: Failure): string {
  const got = f.got === null ? 'not a flat colour' : `${f.got.toFixed(2)}:1`;
  return `${f.palette}/${f.theme}: --${f.fg} on --${f.bg} is ${got}, needs ${f.min}:1 (${f.kind})`;
}

/** Every failure of every palette in both themes, for the CLI and the tests. */
export function allFailures(css: string, list: Pair[] = pairs()): Failure[] {
  return PALETTES.flatMap((p) => (['light', 'dark'] as const).flatMap((t) => failures(css, t, list, p)));
}
