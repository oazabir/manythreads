import { expect, test } from '@playwright/test';
import { WEB, authState } from '../support/env.ts';
import { apiAs, createChannel, postMessage, uniqueName } from './support.ts';

/*
 * A message row is not replaced or moved while the page finishes loading (found when the phone Later test failed with "element was detached" after the
 * presence dots shipped). The hover action bar exists only while the pointer is over the row, so a row that moves out from under the pointer, or is drawn
 * again as a new element, takes the bar away while it is being pressed. Two things used to do that: the "New" line, which went in front of the first unread
 * message when the roster answered (after the rows were drawn), and, to be sure of the other half, the presence cards arriving and refreshing. Both run at the
 * desktop and the phone width.
 */
test.use({ actionTimeout: 10_000 });

const T = { timeout: 15_000 };
const MARK = '__rowStable';

test('a late roster does not move the rows: the New line is already there when they are first drawn, and the action bar stays', async ({ browser, isMobile }) => {
  const omar = await apiAs('omar');
  const nadia = await apiAs('nadia');
  const ch = await createChannel(omar, 'rowstab');
  const tag = uniqueName('rs');
  for (let i = 0; i < 6; i++) await postMessage(nadia, ch.id, `${tag} earlier ${i}`);
  const last = (await postMessage(nadia, ch.id, `${tag} last`)).id;
  const context = await browser.newContext({ baseURL: WEB, viewport: isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, storageState: authState('rafi'), ...(isMobile ? { isMobile: true, hasTouch: true } : {}) });
  try {
    const page = await context.newPage();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/teams/*/roster', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(`/t/engineering/c/${ch.name}`);
    const row = page.locator(`[data-message-id="${last}"]`).first();
    // while the roster has not answered, no row is drawn at a place it will leave (a channel that is still deciding is busy)
    await page.waitForTimeout(1_000);
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('channel-view')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(row).toBeVisible(T);
    await expect(page.getByTestId('unread-divider')).toHaveCount(1);
    const before = await row.boundingBox();
    await row.hover();
    const bar = row.getByRole('toolbar', { name: 'Message actions' });
    await expect(bar).toBeVisible(T);
    await row.evaluate((el, k) => { (el as unknown as Record<string, boolean>)[k] = true; el.querySelector('.acts')!.setAttribute(k, '1'); }, MARK);
    await page.waitForTimeout(1_500);
    expect(await row.boundingBox()).toEqual(before);
    expect(await row.evaluate((el, k) => (el as unknown as Record<string, boolean>)[k] === true && el.querySelector('.acts')?.getAttribute(k) === '1', MARK)).toBe(true);
    await expect(bar).toBeVisible();
  } finally {
    await context.close();
    await Promise.all([omar.ctx.dispose(), nadia.ctx.dispose()]);
  }
});

test('the presence cards arriving, and being read again, leave the same row and the same action bar in place', async ({ browser, isMobile }) => {
  const omar = await apiAs('omar');
  const nadia = await apiAs('nadia');
  const ch = await createChannel(omar, 'rowstab');
  const id = (await postMessage(nadia, ch.id, `${uniqueName('rs')} one`)).id;
  const context = await browser.newContext({ baseURL: WEB, viewport: isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, storageState: authState('rafi'), ...(isMobile ? { isMobile: true, hasTouch: true } : {}) });
  try {
    const page = await context.newPage();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    await page.route('**/api/presence/people', async (route) => {
      reads += 1;
      if (reads === 1) await gate;
      await route.continue();
    });
    await page.goto(`/t/engineering/c/${ch.name}`);
    const row = page.locator(`[data-message-id="${id}"]`).first();
    await expect(row).toBeVisible(T);
    await expect(row.getByTestId('presence-dot')).toHaveCount(0);
    await row.hover();
    const bar = row.getByRole('toolbar', { name: 'Message actions' });
    await expect(bar).toBeVisible(T);
    const before = await row.boundingBox();
    await row.evaluate((el, k) => { (el as unknown as Record<string, boolean>)[k] = true; el.querySelector('.acts')!.setAttribute(k, '1'); }, MARK);
    const same = (): Promise<boolean> => row.evaluate((el, k) => (el as unknown as Record<string, boolean>)[k] === true && el.querySelector('.acts')?.getAttribute(k) === '1', MARK);

    // the cards arrive: the dot appears, the row is the same element, in the same place, with the same bar
    release();
    await expect(row.getByTestId('presence-dot')).toHaveCount(1, T);
    expect(await same()).toBe(true);
    expect(await row.boundingBox()).toEqual(before);

    // and are read again (coming back to the tab reads them at once): still the same elements
    const asked = reads;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => reads, T).toBeGreaterThan(asked);
    await page.waitForTimeout(500);
    expect(await same()).toBe(true);
    expect(await row.boundingBox()).toEqual(before);
    await expect(bar).toBeVisible();
  } finally {
    await context.close();
    await Promise.all([omar.ctx.dispose(), nadia.ctx.dispose()]);
  }
});
