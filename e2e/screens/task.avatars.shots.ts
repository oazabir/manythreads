import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Live check of profile pictures (P14-23): Rafi's account page and picker (built-in picture, photo, back to initials), his picture beside his message in a channel
 * as Omar sees it, the roster, and Omar choosing a bot's picture. Credentials come from the environment only; AVATAR_PHOTO is a picture file to upload as a photo.
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.avatars.shots.ts --retries=0 --workers=1
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const PHOTO = process.env['AVATAR_PHOTO'] ?? '';
const T = { timeout: 20_000 };
test.describe.configure({ mode: 'serial' });

const who = (key: 'RAFI' | 'OMAR') => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });
const problems: string[] = [];
async function signIn(browser: Browser, key: 'RAFI' | 'OMAR', viewport = { width: 1440, height: 900 }): Promise<{ page: Page; context: BrowserContext }> {
  const u = who(key);
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)} @ ${page.url()}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `av-${name}.png`), animations: 'disabled' });
}

test('Rafi picks a picture, uploads a photo and goes back to initials', async ({ browser }) => {
  expect(PHOTO, 'AVATAR_PHOTO is not set').not.toBe('');
  const { page, context } = await signIn(browser, 'RAFI');
  try {
    await page.goto('/account');
    await expect(page.getByTestId('account-picture').locator('.av')).toBeVisible(T);
    await shoot(page, '1-account-initials');
    await page.getByTestId('account-change-picture').click();
    const dialog = page.getByTestId('avatar-picker');
    await expect(dialog).toBeVisible(T);
    await expect(dialog.locator('.avp-cell img').first()).toBeVisible(T);
    await expect.poll(() => dialog.locator('.avp-cell img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0)), T).toBe(true);
    await shoot(page, '2-picker');
    await dialog.getByTestId('avatar-man-7').click();
    await expect(dialog.getByTestId('avatar-current')).toHaveText('Man with glasses and a beard', T);
    await shoot(page, '3-picked');
    await dialog.getByTestId('avatar-file').setInputFiles(PHOTO);
    await expect(dialog.getByTestId('avatar-current')).toHaveText('Profile photo', T);
    await expect.poll(() => dialog.locator('.avp-now .av img').evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth), T).toBe(256);
    await shoot(page, '4-photo');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.goto('/settings/team/engineering/roster');
    await expect(page.locator('.person-row .av img').first()).toBeVisible(T);
    await shoot(page, '5-roster-as-rafi');
  } finally {
    await context.close();
  }
});

test('Omar sees it in the roster, chooses a bot picture, and Rafi goes back to initials', async ({ browser }) => {
  const { page, context } = await signIn(browser, 'OMAR');
  try {
    await page.goto('/settings/team/engineering/roster');
    await expect(page.locator('.person-row[data-person^="rafi"] .av img')).toBeVisible(T);
    await shoot(page, '6-roster-as-omar');
    await page.goto('/t/engineering/bots');
    const first = page.getByTestId('bot-row').first();
    await expect(first).toBeVisible(T);
    const slug = await first.getAttribute('data-bot');
    await page.goto(`/t/engineering/bots/${slug}`);
    await page.getByTestId('bot-change-picture').click();
    const dialog = page.getByTestId('avatar-picker');
    await expect(dialog.locator('.avp-cell')).toHaveCount(20, T);
    await expect(dialog.getByTestId('avatar-man-1')).toHaveCount(0);
    await expect.poll(() => dialog.locator('.avp-cell img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0)), T).toBe(true);
    await shoot(page, '7-bot-picker');
    await dialog.getByTestId('avatar-bot-fox-2').click();
    await expect(dialog.getByTestId('avatar-current')).toHaveText('Fox', T);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await shoot(page, '8-bot-page');
    await page.goto('/t/engineering/bots');
    await expect(page.locator(`[data-bot="${slug}"] .av img`)).toBeVisible(T);
    await shoot(page, '9-bot-roster');
    // put both back
    await page.goto(`/t/engineering/bots/${slug}`);
    await page.getByTestId('bot-change-picture').click();
    await page.getByTestId('avatar-remove').click();
    await expect(page.getByTestId('avatar-current')).toContainText('initials', T);
  } finally {
    await context.close();
  }
  const rafi = await signIn(browser, 'RAFI');
  try {
    await rafi.page.goto('/account');
    await rafi.page.getByTestId('account-change-picture').click();
    await rafi.page.getByTestId('avatar-remove').click();
    await expect(rafi.page.getByTestId('avatar-current')).toContainText('initials', T);
  } finally {
    await rafi.context.close();
  }
  expect(problems.filter((p) => !/favicon|Failed to load resource.*(401|403)/.test(p)), problems.join('\n')).toEqual([]);
});
