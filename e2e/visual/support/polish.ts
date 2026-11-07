import { mkdirSync } from 'node:fs';
import { expect, type Browser, type Page } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import type { PersonaKey } from '../../support/env.ts';
import { noSidewaysScroll } from '../../support/stack-browser.ts';
import { SIZES, THEMES, expectWireframe, openPage, settle, type Look, type SizeName, type Theme } from './vt.ts';

/*
 * The polish plates of Phase 21 (P21-24): every screen shot in light and dark, at 1440 and at 390. One plate is one name; the four baselines are
 * `<name>-<size>-<theme>.png` in the spec's own baseline folder (class W, 0.2% of the pixels, times and avatars masked by `data-vt-mask`).
 *
 * Besides the picture, each plate asserts what a picture cannot say by itself: the page was drawn in the theme asked for (the root attribute, and a
 * body background that differs between the two themes), nothing scrolls sideways at 390, and the frame is up.
 *
 * `MANYTHREADS_VT_DRY=1` takes the pictures to MANYTHREADS_VT_DUMP (a folder) instead of comparing them with a baseline, so a coder can LOOK at a plate
 * before any baseline exists. It never writes a baseline and is not for CI.
 */

export interface PlateOptions {
  /** Which persona looks at it (default omar). */
  who?: PersonaKey | null;
  /** Sizes to shoot (default both). */
  sizes?: SizeName[];
  /** Themes to shoot (default both). */
  themes?: readonly Theme[];
  density?: Look['density'];
  /** Landmarks the plate holds in this reading order (default none). */
  order?: string[] | string[][];
  /** Brings the page to the state of the plate, after the sign-in. */
  go: (page: Page, size: SizeName, theme: Theme) => Promise<void>;
}

/** The body background each theme must paint (tokens.css: `--paper`), so a dark plate that is the light page is caught. */
const PAPER: Record<Theme, string> = { light: 'rgb(237, 238, 240)', dark: 'rgb(15, 18, 22)' };

export async function plate(browser: Browser, stack: Stack, name: string, o: PlateOptions): Promise<void> {
  const seen = new Map<Theme, string>();
  for (const size of o.sizes ?? (['1440', '390'] as SizeName[])) {
    for (const theme of o.themes ?? THEMES) {
      const look: Look = { theme, ...(o.density ? { density: o.density } : {}) };
      const { page, close } = await openPage(browser, stack, o.who === undefined ? 'omar' : o.who, SIZES[size], size === '390', look);
      try {
        await o.go(page, size, theme);
        await settle(page);
        const root = await page.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          density: document.documentElement.getAttribute('data-density'),
          paper: getComputedStyle(document.body).backgroundColor,
        }));
        expect(root.theme, `${name}: the page is drawn in ${theme}`).toBe(theme);
        expect(root.density, `${name}: density`).toBe(o.density ?? 'comfortable');
        if (size === '390') expect(await noSidewaysScroll(page), `${name}: no sideways scroll at 390`).toBe(true);
        seen.set(theme, root.paper);
        const file = `${name}-${size}-${theme}`;
        if (process.env['MANYTHREADS_VT_DRY'] === '1') {
          const dir = process.env['MANYTHREADS_VT_DUMP'] ?? 'test-results/vt-dry';
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: `${dir}/${file}.png`, animations: 'disabled', caret: 'hide' });
        } else {
          await expectWireframe(page, file, o.order ?? []);
        }
      } finally {
        await close();
      }
    }
  }
  // a dark plate is not the light page: the two backgrounds differ, and the dark one is the token's value
  if (seen.has('light') && seen.has('dark')) {
    expect(seen.get('dark'), `${name}: dark body background`).toBe(PAPER.dark);
    expect(seen.get('light'), `${name}: light body background`).not.toBe(seen.get('dark'));
  }
}
