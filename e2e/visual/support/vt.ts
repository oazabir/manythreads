import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, request, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  CLASS_P,
  CLASS_P_LOOSE,
  CLASS_W,
  MOCKUPS_URL,
  checkOrder,
  comparePngs,
  useLocalFonts,
  compareLandmarks,
  landmarks,
  type Landmark,
  type SectionId,
} from '../../../tools/plates/src/index.ts';
import { PERSONA_PASSWORD, personaEmail, type PersonaKey } from '../../support/env.ts';
import type { Stack } from '../../fixtures/stack.ts';

/*
 * Shared helpers of the visual specs (PLAN section 5, Plate comparison).
 *
 *  - W (wireframe)   own committed baseline through toHaveScreenshot (<= 0.2% differing pixels, data-vt-mask masked) and the
 *                    landmarks of the live screen in reading order.
 *  - P-loose / P     the live screen against a plate of docs/spec/mockups-all.html. A plate is an onboarding step or a
 *                    settings pane with its own chrome (stepper rail, nav), so the comparison is of the pane: the content box of the
 *                    plate's pane (`paneSelector`) against the live content region, both cut to the same size from their top left corner.
 *                    The plate is rendered at the viewport width that gives its pane the live region's width.
 *
 * Every visual spec runs on its own server + web origin (fixtures/stack.ts) on a fresh seeded database, so what is on screen
 * does not depend on what other specs changed, and signs in through the real password route (the same call global-setup makes
 * for e2e/.auth), because a session of the shared servers is not valid on another database.
 */

export const DESKTOP = { width: 1440, height: 900 } as const;
export const MOBILE = { width: 390, height: 844 } as const;

export const W_OPTIONS = { maxDiffPixelRatio: CLASS_W.maxDiffRatio, animations: 'disabled', caret: 'hide' } as const;

/** Storage state of a persona signed in through POST /api/auth/password/sign-in on the stack's origin. */
export async function personaState(stack: Stack, key: PersonaKey): Promise<Awaited<ReturnType<BrowserContext['storageState']>>> {
  const api = await request.newContext({ baseURL: stack.origin });
  try {
    const res = await api.post('/api/auth/password/sign-in', { data: { email: personaEmail(key), password: PERSONA_PASSWORD } });
    expect(res.status(), `password sign-in as ${key}`).toBe(200);
    return await api.storageState();
  } finally {
    await api.dispose();
  }
}

/** A page of a browser context signed in as `key` on `stack` (anonymous when `key` is null). */
export async function openPage(
  browser: Browser,
  stack: Stack,
  key: PersonaKey | null,
  viewport: { width: number; height: number } = DESKTOP,
  mobile = false,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const storageState = key ? await personaState(stack, key) : undefined;
  const context = await browser.newContext({
    baseURL: stack.origin,
    viewport,
    reducedMotion: 'reduce',
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

export const frameOf = (page: Page): Locator => page.locator('[data-testid="app-frame"]');

/** The frame is on screen, fonts are loaded and nothing is still loading. */
export async function settle(page: Page): Promise<Locator> {
  const frame = frameOf(page);
  await frame.waitFor();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts?.ready);
  return frame;
}

/** The landmarks of the live screen appear in this reading order (presence and order, no pixels). */
export async function expectLandmarkOrder(page: Page, order: string[]): Promise<void> {
  await settle(page);
  expect(checkOrder(await landmarks(page), order), `landmark order and presence of ${order.join(', ')}`).toEqual([]);
}

/** Class W: the landmarks appear in this reading order, and the frame matches its own committed baseline. */
export async function expectWireframe(page: Page, name: string, order: string[] | string[][]): Promise<void> {
  const frame = await settle(page);
  const found = await landmarks(page);
  const groups = Array.isArray(order[0]) ? (order as string[][]) : [order as string[]];
  for (const g of groups) expect(checkOrder(found, g), `landmark order and presence of ${g.join(', ')}`).toEqual([]);
  await expect(frame).toHaveScreenshot(`${name}.png`, { ...W_OPTIONS, mask: [page.locator('[data-vt-mask]')] });
}

// ---- plate comparison ---------------------------------------------------------------------------------------------

export interface Box { x: number; y: number; w: number; h: number }

export interface PlateSpec {
  section: SectionId;
  /** 1-based plate number inside the section. */
  n: number;
  /** What holds the pane inside the plate (default `.frame`; the phone plate has a row of device frames instead). */
  frameSelector?: string;
  /** The plate's pane (inside `.frame`) whose content box is compared, for example `.obr`. */
  paneSelector: string;
  /** Padding of that pane (top, right, bottom, left), which the content box excludes. */
  padding: [number, number, number, number];
  /** Fixed chrome (a rail) to the left of the pane, in px; used to pick the plate's viewport width. */
  railWidth: number;
  /** The plate's viewport width when it is not the live region's width plus the pane's chrome (a single message of a full screen). */
  viewportWidth?: number;
  /** More px of width the plate's viewport needs (the frame's own 1 px borders when the pane fills the frame). Default 0. */
  extraWidth?: number;
  /** Plate regions by landmark name (selectors inside the frame), measured relative to the pane content box. */
  regions: Record<string, string>;
  /** Plate texts by `data-copy` name (selectors inside the frame); each must equal the live `[data-copy]` text exactly. */
  copy?: Record<string, { selector: string; index?: number; /** Descendants left out of the text (plate-only affordances). */ omit?: string }>;
  /**
   * Plate regions painted black on BOTH images (times, avatars, anything the live screen holds as data of its own). The live
   * counterpart is every `[data-vt-mask]` element of the live region (support/vt.ts `liveMaskRects`).
   */
  masks?: string[];
}


async function pageBox(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  });
}

export interface PlateRender {
  png: Buffer;
  box: Box;
  landmarks: Landmark[];
  copy: Record<string, string>;
  /** Boxes of `spec.masks`, relative to `box`. */
  maskRects: Box[];
}

/**
 * Renders the plate at the viewport width whose pane content is `contentWidth` px wide and cuts out the pane's content box
 * (at most `height` px tall). Landmarks are relative to that box.
 */
export async function renderPlatePane(browser: Browser, spec: PlateSpec, contentWidth: number, height: number): Promise<PlateRender> {
  const [pt, pr, , pl] = spec.padding;
  // the plate's wrapper leaves 24px each side of the frame
  const viewportWidth = spec.viewportWidth ?? Math.ceil(contentWidth + pl + pr + spec.railWidth + 48 + (spec.extraWidth ?? 0));
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: 900 }, reducedMotion: 'reduce' });
  try {
    await useLocalFonts(context);
    const page = await context.newPage();
    await page.goto(`${MOCKUPS_URL}#${spec.section}`);
    await page.evaluate(() => document.fonts?.ready);
    const frame = page.locator(`#${spec.section} .plate`).nth(spec.n - 1).locator(spec.frameSelector ?? '.frame').first();
    await frame.scrollIntoViewIfNeeded();
    // The plate sits at a fractional page offset (text above it); a clip there paints every line a fraction of a pixel off the live
    // screen's, which rounds to a whole pixel of difference on some rows. Move the frame onto the pixel grid.
    await frame.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const fx = r.left + window.scrollX;
      const fy = r.top + window.scrollY;
      el.style.position = 'relative';
      el.style.left = `${Math.round(fx) - fx}px`;
      el.style.top = `${Math.round(fy) - fy}px`;
    });
    const pane = frame.locator(spec.paneSelector).first();
    const p = await pageBox(pane);
    const box: Box = { x: p.x + pl, y: p.y + pt, w: p.w - pl - pr, h: Math.min(height, p.h - pt) };
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h }, fullPage: true, animations: 'disabled' });
    const marks: Landmark[] = [];
    for (const [name, selector] of Object.entries(spec.regions)) {
      // a selector that matches several elements names the box around all of them (a column made of a stream and its composer)
      const boxes = await Promise.all((await frame.locator(selector).all()).map(pageBox));
      if (boxes.length === 0) throw new Error(`plate region ${name}: nothing matches ${selector}`);
      const x0 = Math.min(...boxes.map((b) => b.x));
      const y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.w));
      const y1 = Math.max(...boxes.map((b) => b.y + b.h));
      marks.push({ name, x: x0 - box.x, y: y0 - box.y, w: x1 - x0, h: y1 - y0 });
    }
    const copy: Record<string, string> = {};
    for (const [name, c] of Object.entries(spec.copy ?? {})) {
      copy[name] = await frame
        .locator(c.selector)
        .nth(c.index ?? 0)
        .evaluate((el, omit) => {
          const node = el.cloneNode(true) as Element;
          if (omit) node.querySelectorAll(omit).forEach((n) => n.remove());
          return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        }, c.omit);
    }
    const maskRects: Box[] = [];
    for (const selector of spec.masks ?? []) {
      for (const el of await frame.locator(selector).all()) {
        const r = await pageBox(el);
        if (r.w > 0 && r.h > 0) maskRects.push({ x: r.x - box.x, y: r.y - box.y, w: r.w, h: r.h });
      }
    }
    return { png, box, landmarks: marks, copy, maskRects };
  } finally {
    await context.close();
  }
}

/** Scrolls the channel's message list so the first day label sits where the plate's stream starts (22 px under the header). */
export async function scrollToFirstDay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.chview .vlist');
    const day = list?.querySelector<HTMLElement>('.daysep');
    if (!list || !day) return;
    list.scrollTop += day.getBoundingClientRect().top - list.getBoundingClientRect().top - 22;
  });
  await page.waitForTimeout(150);
}

/** The live region's content box, its landmarks relative to it, and its `data-copy` texts. */
export async function renderLiveRegion(page: Page, regionSelector: string, height: number, extraMasks: string[] = []) {
  const region = page.locator(regionSelector).first();
  await region.waitFor();
  await page.evaluate(() => document.fonts?.ready);
  const box = await pageBox(region);
  const clip = { x: box.x, y: box.y, width: box.w, height: Math.min(height, box.h) };
  // Unmasked: the masks (`[data-vt-mask]`) are painted black on both this image and the plate's by comparePngs.
  // A full-page capture resizes the viewport for a moment, which a virtualised list answers by jumping to its end: only take one when
  // the region does not fit on screen.
  const viewport = page.viewportSize();
  const fits = viewport !== null && box.y + clip.height <= viewport.height && box.x + clip.width <= viewport.width;
  const png = await page.screenshot({ clip, fullPage: !fits, animations: 'disabled', caret: 'hide' });
  const maskRects: Box[] = await region.evaluate((root, extra) => {
    const r0 = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll(['[data-vt-mask]', ...extra].join(',')))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.x - r0.x, y: r.y - r0.y, w: r.width, h: r.height }));
  }, extraMasks);
  const marks: Landmark[] = await region.evaluate((root) => {
    const r0 = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll('[data-landmark]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('data-landmark') ?? '', x: r.x - r0.x, y: r.y - r0.y, w: r.width, h: r.height };
    });
  });
  const copy: Record<string, string> = await region.evaluate((root) => {
    const out: Record<string, string> = {};
    for (const el of Array.from(root.querySelectorAll('[data-copy]'))) {
      out[el.getAttribute('data-copy') ?? ''] = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return out;
  });
  return { png, box, landmarks: marks, copy, maskRects };
}

export interface PlateCompareOptions {
  cls: 'P' | 'P-loose';
  spec: PlateSpec;
  /** Live region whose content box is compared (its top-left corner is the origin). */
  liveRegion: string;
  /** Names that must exist in the live screen in this reading order (one list, or one list per nesting level). */
  order: string[] | string[][];
  /** P: landmarks held to +-6px (x, y, width, height). */
  exact?: string[];
  /** P: `data-copy` names compared exactly. */
  copy?: string[];
  /** Plate pixels never differ in these live-only parts: live selectors painted over on both sides. */
  height?: number;
  /** Live elements masked besides `[data-vt-mask]` (avatars, which stay unmasked in the wireframe baselines). */
  liveMasks?: string[];
}

/** Compares a live page with a plate under class P or P-loose; attaches the diff and prints the measured ratio. */
export async function comparePlate(page: Page, browser: Browser, testInfo: TestInfo, o: PlateCompareOptions): Promise<{ diffRatio: number }> {
  const height = o.height ?? 640;
  await settle(page);
  const live = await renderLiveRegion(page, o.liveRegion, height, o.liveMasks);
  const plate = await renderPlatePane(browser, o.spec, live.box.w, height);

  const dump = process.env['MANYTHREADS_VT_DUMP'];
  if (dump) {
    mkdirSync(dump, { recursive: true });
    const base = (testInfo.file.split('/visual/')[1] ?? 'spec').replace(/[^a-z0-9]+/gi, '-');
    for (const [n, b] of [['plate', plate.png], ['live', live.png]] as const) writeFileSync(`${dump}/${base}-${n}.png`, b);
  }
  const limit = o.cls === 'P' ? CLASS_P.maxDiffRatio : CLASS_P_LOOSE.maxDiffRatio;
  const diff = comparePngs(plate.png, live.png, { masks: [...plate.maskRects, ...live.maskRects] });
  if (dump) {
    const base = (testInfo.file.split('/visual/')[1] ?? 'spec').replace(/[^a-z0-9]+/gi, '-');
    writeFileSync(`${dump}/${base}-diff.png`, diff.diffPng);
  }
  await testInfo.attach('plate.png', { body: plate.png, contentType: 'image/png' });
  await testInfo.attach('live.png', { body: live.png, contentType: 'image/png' });
  await testInfo.attach('diff.png', { body: diff.diffPng, contentType: 'image/png' });
  const line = `${o.cls} ${testInfo.file.split('/visual/')[1] ?? testInfo.title}: ${(diff.diffRatio * 100).toFixed(2)}% differing (limit ${(limit * 100).toFixed(0)}%, region ${Math.round(live.box.w)}x${Math.round(Math.min(height, live.box.h))})`;
  console.log(`[vt] ${line}`);
  await testInfo.attach('diff-ratio', { body: line });

  const groups = Array.isArray(o.order[0]) ? (o.order as string[][]) : [o.order as string[]];
  for (const g of groups) expect(checkOrder(live.landmarks, g), `landmark order and presence of ${g.join(', ')}`).toEqual([]);
  if (o.cls === 'P') {
    const expected = plate.landmarks.filter((l) => (o.exact ?? []).includes(l.name));
    expect(expected.map((l) => l.name).sort(), 'plate defines every exact landmark').toEqual([...(o.exact ?? [])].sort());
    expect(compareLandmarks(expected, live.landmarks, CLASS_P.landmarkPx), `landmarks within ${CLASS_P.landmarkPx}px`).toEqual([]);
    for (const name of o.copy ?? []) {
      expect(plate.copy[name], `plate text ${name}`).toBeTruthy();
      expect(live.copy[name], `data-copy ${name}`).toBe(plate.copy[name]);
    }
  }
  expect(diff.diffRatio, `${o.cls} differing pixels`).toBeLessThanOrEqual(limit);
  return { diffRatio: diff.diffRatio };
}

export { test, expect };
