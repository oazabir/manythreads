import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';

export const SECTION_IDS = [
  'onboarding', 'app', 'teams', 'bots', 'botgeneric', 'setup',
  'workshop', 'email', 'surfaces', 'connections', 'cabinet', 'brain',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const here = dirname(fileURLToPath(import.meta.url));
export const MOCKUPS_PATH = resolve(here, '../../../docs/spec/mockups-all.html');
export const MOCKUPS_URL = pathToFileURL(MOCKUPS_PATH).href;

const FONTS_DIR = resolve(here, '../../../clients/web/public/fonts');
const dataUri = (file: string) => `data:font/woff2;base64,${readFileSync(resolve(FONTS_DIR, file)).toString('base64')}`;

/**
 * The prototype loads Inter Tight and JetBrains Mono from Google Fonts, so a plate renders with whatever fallback the machine
 * has when the CDN is unreachable (sandbox) and with the real fonts when it is (CI). Answer the CDN requests with the same
 * font files the web client self-hosts, so a plate renders identically everywhere. Call before navigating to the prototype.
 */
export async function useLocalFonts(target: Page | BrowserContext): Promise<void> {
  const css = `
@font-face{font-family:'Inter Tight';font-style:normal;font-weight:400 700;src:url(${dataUri('inter-tight-latin.woff2')}) format('woff2');}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400 500;src:url(${dataUri('jetbrains-mono-latin.woff2')}) format('woff2');}`;
  await target.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: css }));
  await target.route('https://fonts.gstatic.com/**', (route) => route.abort());
}

/**
 * Prototype structure: `section#<id> > .wrap > .plate (h2, p.note, .scroller > .frame > .app)`.
 * Plates are numbered by document order inside the section (1-based).
 */
export function plateFrame(page: Page, sectionId: SectionId, n: number) {
  return page.locator(`#${sectionId} .plate`).nth(n - 1).locator('.frame').first();
}

/** PNG of the Nth plate's `.frame` in a section of the prototype. */
export async function renderPlate(page: Page, sectionId: SectionId, n: number): Promise<Buffer> {
  await useLocalFonts(page);
  await page.goto(`${MOCKUPS_URL}#${sectionId}`);
  await page.evaluate(() => document.fonts?.ready);
  const frame = plateFrame(page, sectionId, n);
  await frame.scrollIntoViewIfNeeded();
  return frame.screenshot({ animations: 'disabled', caret: 'hide' });
}

/** PNG of the live `[data-testid="app-frame"]`, `[data-vt-mask]` regions masked. */
export async function renderLive(page: Page, url: string): Promise<Buffer> {
  await page.goto(url);
  const frame = page.locator('[data-testid="app-frame"]');
  await frame.waitFor();
  await page.evaluate(() => document.fonts?.ready);
  return frame.screenshot({
    animations: 'disabled',
    caret: 'hide',
    mask: [page.locator('[data-vt-mask]')],
  });
}
