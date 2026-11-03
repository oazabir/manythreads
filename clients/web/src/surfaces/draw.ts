// The small calculations behind the Chart and DiffView drawings (PLAN P9-05). Pure, so a test can read them without a browser.

export const CHART_W = 320;
export const CHART_H = 140;
const PAD_X = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

const r2 = (n: number): number => Math.round(n * 100) / 100;

export interface ChartBar {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ChartShape {
  /** The y position of the zero line. */
  zeroY: number;
  bars: ChartBar[];
  /** The `points` of a line, `x,y x,y ...`. */
  line: string;
  dots: Array<{ x: number; y: number }>;
  /** The width of the room each number has, along the bottom. */
  slot: number;
  /** The centre x of each number, and the y where its value is written (above a rise, below a fall). */
  marks: Array<{ x: number; valueY: number }>;
  /** The y of the category names under the drawing. */
  labelY: number;
}

const CHAR_W = 5;

/** A name or value cut to what fits in `room` units wide (about 5 per character at the drawing's text size); empty when not even two characters fit. */
export function fitText(text: string, room: number): string {
  const chars = Math.floor(room / CHAR_W);
  if (chars < 2) return '';
  const glyphs = [...text];
  return glyphs.length <= chars ? text : `${glyphs.slice(0, chars - 1).join('')}…`;
}

/** A number as it is written beside a bar: grouped thousands, at most two decimals. */
export const formatValue = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Where each number goes in the drawing. Values are already finite and within +-1e12 (the part's schema). */
export function chartShape(values: readonly number[]): ChartShape {
  const lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 1;
  const innerH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const innerW = CHART_W - PAD_X * 2;
  const y = (v: number): number => r2(PAD_TOP + ((hi - v) / (hi - lo)) * innerH);
  const zeroY = y(0);
  const slot = innerW / values.length;
  const barW = r2(Math.max(1, slot * 0.7));
  const bars: ChartBar[] = [];
  const dots: Array<{ x: number; y: number }> = [];
  const marks: Array<{ x: number; valueY: number }> = [];
  values.forEach((v, i) => {
    const cx = r2(PAD_X + slot * i + slot / 2);
    const top = y(v);
    const bar = { x: r2(cx - barW / 2), y: Math.min(top, zeroY), w: barW, h: r2(Math.max(1, Math.abs(zeroY - top))) };
    bars.push(bar);
    dots.push({ x: cx, y: top });
    marks.push({ x: cx, valueY: r2(v < 0 ? bar.y + bar.h + 10 : bar.y - 3) });
  });
  return { zeroY, bars, line: dots.map((d) => `${d.x},${d.y}`).join(' '), dots, slot: r2(slot), marks, labelY: CHART_H - 6 };
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * A unified diff, line by line. A line before the first `@@` is a header (`diff --git`, `index`, `---`, `+++`); inside a hunk the first character decides:
 * `+` added, `-` removed, anything else context. (So a removed line whose text starts with `--` is still a removed line.) Lines are never joined or trimmed.
 */
export function classifyDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.startsWith('@@')) {
      inHunk = true;
      out.push({ kind: 'hunk', text });
    } else if (text.startsWith('diff ')) {
      // A new file starts: back to the header lines.
      inHunk = false;
      out.push({ kind: 'meta', text });
    } else if (!inHunk) out.push({ kind: 'meta', text });
    else if (text.startsWith('+')) out.push({ kind: 'add', text });
    else if (text.startsWith('-')) out.push({ kind: 'del', text });
    else out.push({ kind: 'ctx', text });
  }
  // A trailing newline leaves one empty last line that is not part of the diff.
  if (out.length > 1 && out[out.length - 1]!.text === '') out.pop();
  return out;
}
