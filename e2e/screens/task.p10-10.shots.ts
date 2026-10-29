import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * P10-10 on the live site: Workspace settings → System health (outbox, jobs, run slots, approvals, budgets, database, volumes).
 * Read-only. Output: <MANYTHREADS_TASK_SHOTS_DIR>/p10-10-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };

test('system health panel', async ({ browser }) => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await page.goto('/settings/workspace/health');
  await expect(page.getByText('System health').first()).toBeVisible(T);
  await expect(page.getByText('Loading…')).toHaveCount(0, T);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, 'p10-10-01-system-health.png'), animations: 'disabled', fullPage: true });
  await context.close();
});
