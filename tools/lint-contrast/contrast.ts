/** WCAG 2.x contrast of two sRGB colours, and the small parser that turns `#RRGGBB` into numbers. */

export type Rgb = readonly [number, number, number];

/** `#RGB` or `#RRGGBB` as 0-255 channels, or null for anything else (an `rgb()` with an alpha is not a flat colour). */
export function parseHex(text: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text.trim());
  if (!m) return null;
  let h = m[1] as string;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Relative luminance (WCAG): 0 for black, 1 for white. */
export function luminance(c: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** Contrast ratio between 1 (same colour) and 21 (black on white). */
export function ratio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
