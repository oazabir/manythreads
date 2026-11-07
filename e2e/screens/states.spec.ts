import { expect, test, type Browser, type Page } from '@playwright/test';
import { WEB, authState } from '../support/env.ts';

/*
 * P21-22: a list shows grey bars while it loads (never the word "Loading…"), an empty list shows an icon, a sentence and one button, and nothing
 * moves for a person who asked for reduced motion. The Approvals page of Engineering is the probe: the shared server has no approval in it, so
 * once the slowed request is let go the page is the empty state. Rafi decides approvals there, so the page opens for him.
 */
const LIST = /\/api\/teams\/engineering\/approvals\?/;

async function openSlowed(browser: Browser, reducedMotion: 'reduce' | 'no-preference'): Promise<{ page: Page; release: () => void; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: WEB, storageState: authState('rafi'), reducedMotion });
  const page = await context.newPage();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  await page.route(LIST, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/t/engineering/approvals');
  return { page, release, close: () => context.close() };
}

test('a slowed list shows skeleton rows, then the empty state with an icon and one button', async ({ browser }) => {
  const { page, release, close } = await openSlowed(browser, 'reduce');
  try {
    const skeleton = page.locator('.sk-rows[aria-busy="true"]');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('role', 'status');
    await expect(skeleton).toHaveAttribute('aria-label', 'Loading approvals');
    await expect(page.getByText('Loading…')).toHaveCount(0);
    expect(await skeleton.locator('.sk-row').count()).toBeGreaterThan(1);

    release();
    await expect(skeleton).toHaveCount(0);
    const empty = page.getByTestId('approvals-empty');
    await expect(empty).toBeVisible();
    await expect(empty.locator('svg')).toHaveCount(1);
    await expect(empty.getByRole('button')).toHaveCount(1);
    await expect(empty.getByRole('button')).toHaveText('See what was decided');

    // the one button does what it says
    await empty.getByRole('button').click();
    await expect(page.getByTestId('approvals-tab-decided')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('approvals-empty').getByRole('button')).toHaveText('See what is waiting');
  } finally {
    release();
    await close();
  }
});

test('reduced motion: the skeleton bars do not move; otherwise they shimmer', async ({ browser }) => {
  const still = await openSlowed(browser, 'reduce');
  try {
    await expect(still.page.locator('.sk-bar').first()).toBeVisible();
    expect(await still.page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  } finally {
    still.release();
    await still.close();
  }
  const moving = await openSlowed(browser, 'no-preference');
  try {
    await expect(moving.page.locator('.sk-bar').first()).toBeVisible();
    await expect
      .poll(() => moving.page.evaluate(() => document.querySelector('.sk-bar')?.getAnimations().filter((a) => a.playState === 'running').length ?? 0))
      .toBeGreaterThan(0);
  } finally {
    moving.release();
    await moving.close();
  }
});
