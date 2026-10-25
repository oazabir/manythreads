import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Domain & HTTPS on the live site: onboarding step 4 and the settings page with its live checks (mode, certificate on the
 * public URL and on a made-up app host, the client address the server sees). Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/https-*.png (default temp/screenshots).
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
  // No masks: the check details are the evidence (they hold no secrets, only addresses and plain-language results).
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage: true });
}

test('onboarding lists step 4, Domain & HTTPS', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/onboarding');
    await expect(page.locator('[data-step="https"]')).toBeVisible({ timeout: 15_000 });
    await shoot(page, 'https-01-onboarding');
  } finally {
    await page.context().close();
  }
});

test('the Domain & HTTPS page shows the mode, the live checks and the switch commands', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/settings/workspace/https');
    await expect(page.getByText(/We see you as/i)).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'https-02-settings');
  } finally {
    await page.context().close();
  }
});
