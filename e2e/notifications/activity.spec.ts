import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, PHONE, type StackApi } from '../support/stack-browser.ts';

/**
 * P21-10, the notifications as a person reads them: the bell and the Activity page list the same items with the sender's picture; an unread one is
 * bold with a dot; hovering a row offers Mark read and Open; the red number counts what is addressed to the person and a message from a channel set to
 * "all" is only a grey dot. On a stack of its own (it reads and marks Rafi's notifications).
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the specs open their own browser contexts, at desktop and at phone width; one run is enough');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let omar: StackApi;
let channelId = '';
let quietId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  omar = await apiOn(playwright, stack, 'omar');
  channelId = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'activity-room' })).channel.id;
  quietId = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'activity-quiet' })).channel.id;
});
test.afterAll(async () => {
  await Promise.all([nadia?.ctx.dispose(), rafi?.ctx.dispose(), omar?.ctx.dispose()]);
  await stack?.stop();
});

test('the bell and the Activity page list the same items, with the sender\'s picture, bold while unread, and Mark read on hover', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('bell')).toBeVisible();
    await postAs(nadia, channelId, 'Hey @rafi, please look at the freeze checklist before Friday');
    await postAs(nadia, channelId, 'And @rafi one more thing about the rollback plan');
    await expect(page.getByTestId('bell-count')).toHaveText('2', { timeout: 5_000 });

    // the bell: avatars, the quoted line, the unread dot, bold title
    await page.getByTestId('bell').click();
    const pop = page.getByTestId('notifications-popover');
    const popItems = pop.getByTestId('notification');
    await expect(popItems).toHaveCount(2);
    await expect(popItems.first().locator('.ntf-av .av')).toBeVisible();
    await expect(popItems.first().locator('.ntf-dot')).toBeVisible();
    await expect(popItems.first().locator('.ntf-preview')).toContainText('“');
    expect(await popItems.first().locator('.ntf-title').evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
    const titles = await popItems.locator('.ntf-title').allTextContents();

    // Mark read and Open appear on hover; Mark read reads that one only
    await popItems.first().hover();
    await expect(pop.getByTestId('notification-open').first()).toBeVisible();
    await pop.getByTestId('notification-mark-read').first().click();
    await expect(page.getByTestId('bell-count')).toHaveText('1');
    // the Unread tab lets go of the one just read; All keeps it, as read
    await expect(popItems).toHaveCount(1);
    await pop.getByRole('button', { name: 'All', exact: true }).click();
    await expect(popItems.filter({ has: page.locator('.ntf-dot') })).toHaveCount(1);
    await expect(popItems.locator('xpath=self::*[@data-unread="false"]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // the Activity page lists the same items (All tab) and reads from the same store
    await page.goto('/t/engineering/activity');
    const screen = page.getByTestId('activity-screen');
    await expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
    await screen.getByRole('button', { name: 'All', exact: true }).click();
    const items = screen.getByTestId('notification');
    await expect(items).toHaveCount(2);
    expect((await items.locator('.ntf-title').allTextContents()).sort()).toEqual([...titles].sort());
    await expect(items.first().locator('.ntf-av .av')).toBeVisible();
    // Unread keeps the one still unread; Mark all read empties it and shows the empty state
    await screen.getByRole('button', { name: 'Unread', exact: true }).click();
    await expect(items).toHaveCount(1);
    await screen.getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(page.getByTestId('bell-count')).toHaveCount(0);
    await expect(screen.getByTestId('notifications-empty')).toContainText('You are all caught up');
  } finally {
    await context.close();
  }
});

test('a message from a channel set to "all" is a grey dot, not part of the red number', async ({ browser, playwright }) => {
  await rafi.post(`/api/channels/${quietId}/join`);
  const res = await rafi.ctx.put(`/api/notifications/levels/${quietId}`, { data: { level: 'all' }, headers: await rafi.headers() });
  expect(res.status()).toBeLessThan(300);
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('bell')).toBeVisible();
    await expect(page.getByTestId('bell-count')).toHaveCount(0);
    await postAs(nadia, quietId, 'Background chatter nobody asked Rafi about');
    await expect(page.getByTestId('bell-activity')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('bell-count')).toHaveCount(0);
    // a real mention on top: the red number counts only that one, the dot stays beside it
    await postAs(nadia, channelId, '@rafi this one is for you');
    await expect(page.getByTestId('bell-count')).toHaveText('1', { timeout: 5_000 });
    await expect(page.getByTestId('bell-activity')).toBeVisible();
    await expect(page.getByTestId('bell')).toHaveAttribute('aria-label', /2 unread/);
  } finally {
    await context.close();
  }
});

test('the Activity page works at phone width without sideways scrolling', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/activity', { viewport: PHONE, mobile: true });
  try {
    const screen = page.getByTestId('activity-screen');
    await expect(screen).toBeVisible();
    await screen.getByRole('button', { name: 'All', exact: true }).click();
    await expect(screen.getByTestId('notification').first()).toBeVisible();
    // no hover on a phone: Mark read / Open are always shown for an unread row, and nothing overflows
    await expect(screen.getByTestId('notification-open').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
