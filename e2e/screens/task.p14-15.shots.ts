import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * P14-15 on the live site: the sidebar's "New channel" button and dialog (a bad name, a taken name, a filled form), the new channel opening,
 * and unread rows (bold label and a count badge) for a channel.
 * The channel it makes is called `verify-p14-15-<time>` and is archived again at the end of the run, so the sidebar is left as it was.
 * The run posts one tagged message in the new channel as the same person and marks it unread again through the read-state route, which
 * leaves what another person's message would leave behind.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-15-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const NAME = `verify-p14-15-${Date.now().toString(36)}`;

test.describe.configure({ retries: 0 });
test.setTimeout(240_000);

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

test('New channel dialog, the new channel, and unread rows in the sidebar', async ({ browser }) => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const shot = async (name: string): Promise<void> => {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `p14-15-${name}.png`), animations: 'disabled' });
  };
  const csrf = async (): Promise<string> => (await context.cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  let channelId = '';
  await signIn(page);
  try {
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId('channel-view')).toBeVisible(T);
    await page.mouse.move(700, 5);
    await expect(page.getByTestId('new-channel')).toBeVisible(T);
    await shot('01-sidebar-new-channel');

    await page.getByTestId('new-channel').click();
    await expect(page.getByTestId('new-channel-dialog')).toBeVisible(T);
    await page.getByTestId('new-channel-name').fill('-bad name');
    await shot('02-dialog-bad-name');
    await page.getByTestId('new-channel-name').fill('general');
    await page.getByTestId('new-channel-create').click();
    await expect(page.getByTestId('new-channel-error')).toBeVisible(T);
    await shot('03-dialog-name-taken');
    await page.getByTestId('new-channel-name').fill(NAME.toUpperCase());
    await page.getByTestId('new-channel-topic').fill('Checking the new channel button (archived again after the run)');
    await shot('04-dialog-filled');
    await page.getByTestId('new-channel-create').click();
    await expect(page).toHaveURL(new RegExp(`/c/${NAME}$`), T);
    await expect(page.getByRole('textbox', { name: `Message #${NAME}` })).toBeVisible(T);
    await shot('05-new-channel-open');

    // unread rows: leave the channel with a message in it that the person has not read
    channelId = (await page.getByTestId('channel-view').getAttribute('data-channel-id')) ?? '';
    const headers = { 'x-csrf-token': await csrf() };
    const posted = await page.request.post(`/api/channels/${channelId}/messages`, { data: { channelId, body: '[verify P14-15] a message to leave unread', threadRootId: null }, headers });
    expect(posted.status()).toBeLessThan(300);
    const messageId = ((await posted.json()) as { id: string }).id;
    await expect(page.getByText('a message to leave unread')).toBeVisible(T);
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId('channel-view')).toBeVisible(T);
    const marked = await page.request.post(`/api/channels/${channelId}/messages/${messageId}/unread`, { headers });
    expect(marked.status()).toBeLessThan(300);
    const link = page.locator(`[data-landmark="sidebar"] a.it[href$="/c/${NAME}"]`);
    await expect(link).toHaveClass(/unread/, T);
    await page.mouse.move(700, 5);
    await shot('06-sidebar-unread');
    await link.click();
    await expect(link).not.toHaveClass(/unread/, T);
    await shot('07-unread-cleared');
  } finally {
    if (channelId) {
      const res = await page.request.post(`/api/channels/${channelId}/archive`, { headers: { 'x-csrf-token': await csrf() } });
      console.log('archive', NAME, res.status());
    }
    await context.close();
  }
});
