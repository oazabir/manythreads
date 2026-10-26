import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P10-16 on the live site: the Delivery team's #manythreads with the "Bot Board" link in its header (the board the orchestrator made with
 * `boards.ensure`), and that board with the bots' cards on it. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p10-16-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const T = { timeout: 20_000 };

async function signIn(browser: Browser): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  const context = await browser.newContext({ baseURL: BASE, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
}

test('#manythreads links to its Bot Board, and the board holds the bots\' cards', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/t/delivery/c/manythreads');
    const link = page.getByTestId('bot-board-link');
    await expect(link).toBeVisible(T);
    await expect(link).toHaveText('Bot Board');
    await shoot(page, 'p10-16-01-channel-header');
    await link.click();
    await expect(page.getByTestId('board-view')).toBeVisible(T);
    await expect(page.getByTestId('board-select').locator('option:checked')).toContainText('Bot Board');
    // the columns load after the board: wait for the bots' card, not the "Loading…" line
    await expect(page.getByTestId('board-view').getByText('Loading…')).toHaveCount(0, T);
    await expect(page.getByTestId('board-view').getByText(/^Docs:/).first()).toBeVisible(T);
    await shoot(page, 'p10-16-02-bot-board');
  } finally {
    await page.context().close();
  }
});
