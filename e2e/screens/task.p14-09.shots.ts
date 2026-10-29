import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * P14-09 on the live site: Account → Notifications (kinds, levels, keywords, this browser) and the bell in a channel header.
 * Read-only. Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-09-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };

test('notification settings and the channel bell', async ({ browser }) => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1300 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  mkdirSync(OUT, { recursive: true });

  await page.goto('/account');
  const settings = page.getByTestId('notification-settings');
  await expect(settings).toBeVisible(T);
  await settings.scrollIntoViewIfNeeded();
  await page.waitForLoadState('networkidle');
  await settings.screenshot({ path: join(OUT, 'p14-09-01-account-notifications.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/t/engineering');
  await page.getByRole('link', { name: /dev/ }).first().click();
  const bell = page.getByRole('button', { name: /notification level|notifications for/i }).first();
  await expect(bell).toBeVisible(T);
  await bell.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'p14-09-02-channel-bell.png'), animations: 'disabled' });
  await context.close();
});
