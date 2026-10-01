import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export const SECTION_IDS = [
  'onboarding', 'app', 'teams', 'bots', 'botgeneric', 'setup',
  'workshop', 'email', 'surfaces', 'connections', 'cabinet', 'brain',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const here = dirname(fileURLToPath(import.meta.url));
export const MOCKUPS_PATH = resolve(here, '../../../docs/spec/mockups-all.html');
export const MOCKUPS_URL = pathToFileURL(MOCKUPS_PATH).href;

/**
 * Prototype structure: `section#<id> > .wrap > .plate (h2, p.note, .scroller > .frame > .app)`.
 * Plates are numbered by document order inside the section (1-based).
 */
export function plateFrame(page: Page, sectionId: SectionId, n: number) {
  return page.locator(`#${sectionId} .plate`).nth(n - 1).locator('.frame').first();
}

/** PNG of the Nth plate's `.frame` in a section of the prototype. */
export async function renderPlate(page: Page, sectionId: SectionId, n: number): Promise<Buffer> {
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
