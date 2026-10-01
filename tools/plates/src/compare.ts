import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';

/** Tolerance classes (PLAN §5 Plate comparison). */
export const CLASS_P = { landmarkPx: 6, maxDiffRatio: 0.06 } as const;
export const CLASS_P_LOOSE = { orderAndPresenceOnly: true, maxDiffRatio: 0.12 } as const;
export const CLASS_W = { orderOnly: true, maxDiffRatio: 0.002 } as const;

export interface Rect { x: number; y: number; w: number; h: number }
export interface Landmark extends Rect { name: string }
export interface CompareOptions { masks?: Rect[]; threshold?: number }
export interface CompareResult { diffRatio: number; diffPixels: number; totalPixels: number; diffPng: Buffer }

function pad(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  // Pad with opaque magenta so size mismatches always count as differences.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 255; out.data[i + 3] = 255;
  }
  PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
  return out;
}

function paintMasks(img: PNG, masks: Rect[]): void {
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x)), y0 = Math.max(0, Math.floor(m.y));
    const x1 = Math.min(img.width, Math.ceil(m.x + m.w)), y1 = Math.min(img.height, Math.ceil(m.y + m.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
      }
    }
  }
}

/** Compare two PNGs; sizes are padded to the larger; masked rects are excluded from the ratio. */
export function comparePngs(a: Buffer, b: Buffer, opts: CompareOptions = {}): CompareResult {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  const w = Math.max(pa.width, pb.width), h = Math.max(pa.height, pb.height);
  const ia = pad(pa, w, h), ib = pad(pb, w, h);
  // Work on copies so callers' buffers are untouched; identical masking on both sides.
  const ca = new PNG({ width: w, height: h }); ca.data = Buffer.from(ia.data);
  const cb = new PNG({ width: w, height: h }); cb.data = Buffer.from(ib.data);
  const masks = opts.masks ?? [];
  paintMasks(ca, masks);
  paintMasks(cb, masks);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: opts.threshold ?? 0.1 });
  let masked = 0;
  if (masks.length) {
    const cover = new Uint8Array(w * h);
    for (const m of masks) {
      for (let y = Math.max(0, Math.floor(m.y)); y < Math.min(h, Math.ceil(m.y + m.h)); y++)
        for (let x = Math.max(0, Math.floor(m.x)); x < Math.min(w, Math.ceil(m.x + m.w)); x++) cover[y * w + x] = 1;
    }
    for (const c of cover) masked += c;
  }
  const totalPixels = Math.max(1, w * h - masked);
  return { diffRatio: diffPixels / totalPixels, diffPixels, totalPixels, diffPng: PNG.sync.write(diff) };
}

/** Collect `[data-landmark]` boxes relative to `[data-testid="app-frame"]` (or the given frame selector). */
export async function landmarks(page: Page, frameSelector = '[data-testid="app-frame"]'): Promise<Landmark[]> {
  return page.evaluate((sel) => {
    const frame = document.querySelector(sel);
    if (!frame) return [];
    const f = frame.getBoundingClientRect();
    return Array.from(frame.querySelectorAll('[data-landmark]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('data-landmark') ?? '', x: r.x - f.x, y: r.y - f.y, w: r.width, h: r.height };
    });
  }, frameSelector);
}

export interface LandmarkIssue { name: string; problem: string }

/** Every expected landmark must exist and each edge must be within tolerancePx. */
export function compareLandmarks(expected: Landmark[], actual: Landmark[], tolerancePx: number): LandmarkIssue[] {
  const issues: LandmarkIssue[] = [];
  for (const e of expected) {
    const a = actual.find((l) => l.name === e.name);
    if (!a) { issues.push({ name: e.name, problem: 'missing' }); continue; }
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      if (Math.abs(a[k] - e[k]) > tolerancePx) {
        issues.push({ name: e.name, problem: `${k}: expected ${e[k].toFixed(1)} got ${a[k].toFixed(1)} (±${tolerancePx})` });
      }
    }
  }
  return issues;
}

/**
 * Order and presence only (P-loose / W). `order` lists names in reading order
 * (left→right, then top→bottom for equal columns); each pair must satisfy a before-relation
 * on its centre: `a` strictly precedes `b` in x OR (overlapping in x and) in y.
 */
export function checkOrder(actual: Landmark[], order: string[]): LandmarkIssue[] {
  const issues: LandmarkIssue[] = [];
  const by = new Map(actual.map((l) => [l.name, l]));
  for (const n of order) if (!by.has(n)) issues.push({ name: n, problem: 'missing' });
  if (issues.length) return issues;
  for (let i = 0; i < order.length - 1; i++) {
    const a = by.get(order[i] as string) as Landmark, b = by.get(order[i + 1] as string) as Landmark;
    const leftOf = a.x + a.w <= b.x + 1;
    const above = a.y + a.h <= b.y + 1;
    if (!leftOf && !above) issues.push({ name: b.name, problem: `does not follow ${a.name}` });
  }
  return issues;
}
