import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The Agents page on the live site: the team's connections and the "how to connect" panel. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/agents-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser): Promise<Page> {
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
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage: true });
}

test('the Agents page lists the connections and how to connect', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/t/engineering/agents');
    await expect(page.getByTestId('agents-row').first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'agents-01-list');
  } finally {
    await page.context().close();
  }
});
