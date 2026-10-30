import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * P14-06 on the live site: the slash-command menu in #general (all commands, narrowed, the bot list after `/ask `), the `/help` dialog, a plain
 * sentence for a bot that does not exist, and the menu on a 390 px phone.
 * It posts nothing and creates no card: every command is checked up to the point of sending, and the text is cleared again.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-06-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };

test.describe.configure({ retries: 0 });
test.setTimeout(240_000);

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`slash commands, ${label}`, async ({ browser }) => {
    if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
    mkdirSync(OUT, { recursive: true });
    const context = await browser.newContext({ baseURL: BASE, viewport, reducedMotion: 'reduce', ...(label === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    const shot = async (name: string): Promise<void> => {
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `p14-06-${label}-${name}.png`), animations: 'disabled' });
    };
    await signIn(page);
    try {
      await page.goto('/t/engineering/c/general');
      const input = page.getByRole('textbox', { name: 'Message #general' });
      await expect(input).toBeVisible(T);
      await input.click();
      await input.pressSequentially('/');
      await expect(page.getByTestId('slash-menu')).toBeVisible(T);
      await shot('01-menu');
      await input.pressSequentially('ta');
      await shot('02-menu-narrowed');
      await input.fill('/ask ');
      await shot('03-bot-list');
      await input.fill('/ask nobody hello');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('slash-notice')).toBeVisible(T);
      await shot('04-unknown-bot');
      await input.fill('/help');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('slash-help')).toBeVisible(T);
      await shot('05-help');
      await page.keyboard.press('Escape');
      await input.fill('');
    } finally {
      await context.close();
    }
  });
}
