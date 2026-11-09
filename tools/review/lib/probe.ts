// The computed-style probe (PLAN P13-02, decision E36): reads the colours, radii and font families the live page really uses and compares them with the
// tokens. It REPORTS; whether a finding fails a run is decided by precheck.ts (only with --strict).
import { allowedFonts, allowedRadii, colourSets, parseColour, readTokens, toHex, type Theme, type Tokens } from '../tokens.ts';
import type { PageLike } from './e2e-require.ts';

/** One distinct value seen on the page, with how often and where (up to three selectors). */
export interface Sighting {
  value: string;
  /** For colours: `color`, `background-color`, `border-color`, `outline-color`. */
  property?: string;
  count: number;
  samples: string[];
}

export interface RawProbe {
  theme: Theme;
  elements: number;
  colours: Sighting[];
  radii: Sighting[];
  fonts: Sighting[];
}

/**
 * Runs inside the page. Kept as a string on purpose: a TypeScript build step may add helper calls to a function that Playwright then cannot find in the
 * page. Plain JavaScript only. Arguments: `{ limit }`.
 */
export const COLLECTOR_SOURCE = String.raw`(opts) => {
  const colours = new Map();
  const radii = new Map();
  const fonts = new Map();
  const note = (map, key, extra, el) => {
    let hit = map.get(key);
    if (!hit) {
      hit = Object.assign({ value: key, count: 0, samples: [] }, extra);
      map.set(key, hit);
    }
    hit.count += 1;
    if (hit.samples.length < 3) {
      const id = el.getAttribute('data-testid');
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      const text = el.tagName.toLowerCase() + (id ? '[data-testid=' + id + ']' : '') + (cls ? '.' + cls : '');
      if (!hit.samples.includes(text)) hit.samples.push(text);
    }
  };
  const ownText = (el) => {
    for (const node of el.childNodes) if (node.nodeType === 3 && node.nodeValue.trim() !== '') return true;
    return false;
  };
  const html = document.documentElement;
  const theme = html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const all = document.body ? document.body.querySelectorAll('*') : [];
  let seen = 0;
  for (const el of all) {
    if (seen >= opts.limit) break;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0) continue;
    seen += 1;
    note(colours, cs.backgroundColor, { property: 'background-color' }, el);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (cs['border' + side + 'Style'] !== 'none' && parseFloat(cs['border' + side + 'Width']) > 0) note(colours, cs['border' + side + 'Color'], { property: 'border-color' }, el);
    }
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) note(colours, cs.outlineColor, { property: 'outline-color' }, el);
    const text = ownText(el);
    if (text) {
      note(colours, cs.color, { property: 'color' }, el);
      const first = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
      note(fonts, first, {}, el);
    }
    const box = el.getBoundingClientRect();
    const half = Math.min(box.width, box.height) / 2;
    for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
      const raw = cs['border' + corner + 'Radius'].split(' ')[0];
      if (raw.endsWith('%')) continue;
      const px = parseFloat(raw);
      if (!(px > 0) || px >= half) continue;
      note(radii, String(Math.round(px * 100) / 100), {}, el);
    }
  }
  const list = (map) => Array.from(map.values());
  return { theme: theme, elements: seen, colours: list(colours), radii: list(radii), fonts: list(fonts) };
}`;

export async function probePage(page: PageLike, limit = 6000): Promise<RawProbe> {
  return page.evaluate<RawProbe>(`(${COLLECTOR_SOURCE})(${JSON.stringify({ limit })})`);
}

export interface Findings {
  /** Colours that are not a colour token of the page's theme. */
  colours: Sighting[];
  /** Radii in px that no `--radius-*` token has. */
  radii: Sighting[];
  /** First font families that are not `--sans` or `--mono`. */
  fonts: Sighting[];
}

/** Compares what the page used with the tokens. Pure: no browser needed. */
export function judgeProbe(raw: RawProbe, tokens: Tokens = readTokens()): Findings {
  const sets = colourSets(tokens, raw.theme);
  const radii = allowedRadii(tokens);
  const fonts = allowedFonts(tokens);
  const colourFindings: Sighting[] = [];
  for (const s of raw.colours) {
    const c = parseColour(s.value);
    if (!c || c.a === 0) continue;
    const hex = toHex(c);
    const ok = c.a >= 1 ? sets.opaque.has(hex) : sets.base.has(hex);
    if (!ok) colourFindings.push({ ...s, value: c.a >= 1 ? hex : `${hex} at ${Math.round(c.a * 100)}%` });
  }
  return {
    colours: colourFindings,
    radii: raw.radii.filter((s) => !radii.includes(Number(s.value))).map((s) => ({ ...s, value: `${s.value}px` })),
    fonts: raw.fonts.filter((s) => !fonts.includes(s.value)),
  };
}

export const countFindings = (f: Findings): number => f.colours.length + f.radii.length + f.fonts.length;
