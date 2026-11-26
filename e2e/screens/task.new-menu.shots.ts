import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The sidebar's "New" menu (P38-07) on the live site, driven as Omar (a lead of Engineering) in a real browser at 1440 and 390 px: the menu open,
 * a bot chat (cursor in the box), the team file dialog, and Add to knowledge. Credentials come from the environment only
 * (OMAR_EMAIL / OMAR_PASSWORD; `source ~/manythreads.passwords.env`).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.new-menu.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/nm-*.png
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? '').replace(/\/+$/, '');
if (!BASE) throw new Error('set MANYTHREADS_URL to the address of the site to check');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, viewport: { width: number; height: number }, mobile: boolean): Promise<Page> {
  const email = process.env['OMAR_EMAIL'] ?? '';
  const password = process.env['OMAR_PASSWORD'] ?? '';
  if (!email || password.length < 8) throw new Error('OMAR_EMAIL / OMAR_PASSWORD are not set (source ~/manythreads.passwords.env)');
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return page;
}
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  const style = await page.addStyleTag({ content: '[data-vt-mask]:not([data-testid="presence-dot"]) { visibility: hidden !important; }' });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  await style.evaluate((el) => (el as unknown as Element).remove());
}
const menuItems = (page: Page) => page.getByTestId('new-menu').getByRole('menuitem');

test('desktop 1440: the menu, a bot chat, a team file, a knowledge upload', async ({ browser }) => {
  const page = await signIn(browser, { width: 1440, height: 900 }, false);
  await page.goto('/t/engineering/threads');
  await page.getByTestId('new-menu-button').click();
  await expect(page.getByTestId('new-menu')).toBeVisible(T);
  const labels = await menuItems(page).allInnerTexts();
  console.log(`[nm] ${labels.length} rows: ${labels.map((l) => l.split('\n')[0]).join(' | ')}`);
  await shoot(page, 'nm-menu-1440');
  await menuItems(page).first().click();
  await expect(page).toHaveURL(/chat/, T);
  await expect(page.getByRole('textbox').first()).toBeFocused(T);
  await shoot(page, 'nm-bot-chat-1440');
  await page.getByTestId('new-menu-button').click();
  await page.getByTestId('new-menu').getByRole('menuitem', { name: /team file/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible(T);
  await shoot(page, 'nm-team-file-1440');
  await page.keyboard.press('Escape');
  await page.getByTestId('new-menu-button').click();
  await page.getByTestId('new-menu').getByRole('menuitem', { name: /knowledge/i }).first().click();
  await expect(page).toHaveURL(/knowledge/, T);
  await shoot(page, 'nm-knowledge-1440');
  await page.context().close();
});

test('phone 390: the menu in the drawer and a bot chat', async ({ browser }) => {
  const page = await signIn(browser, { width: 390, height: 844 }, true);
  await page.goto('/t/engineering/threads');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByTestId('new-menu-button').click();
  await expect(page.getByTestId('new-menu')).toBeVisible(T);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shoot(page, 'nm-menu-390');
  await menuItems(page).first().click();
  await expect(page).toHaveURL(/chat/, T);
  await shoot(page, 'nm-bot-chat-390');
  await page.context().close();
});
