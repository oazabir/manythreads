import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, messagesIn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/channels/mentions-notifications (PLAN phase 3, criteria 1 and 8 style): Nadia mentions Rafi, Rafi's bell counts it live, the
 * popover lists it, a click lands on the message (scrolled to and flashed) and clears the count; replies and DMs show up the same way;
 * "Allow browser alerts?" asks the browser and stores the choice, and is simply absent where there is no Notification API.
 */
// a click on something that never becomes clickable fails in seconds instead of hanging until the test timeout
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone has its own spec (mobile-web)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let omar: StackApi;
let chan: { id: string; name: string };

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  const name = 'mentions';
  const res = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name });
  chan = { id: res.channel.id, name };
  await postAs(nadia, chan.id, 'Earlier: standup moved to 10:00.');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

test('a mention reaches Rafi live: badge, popover item, and the click lands on the message', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('bell')).toBeVisible();
    await expect(page.getByTestId('bell-count')).toHaveCount(0);

    const posted = await postAs(nadia, chan.id, 'Hey @rafi, can you check the rollback runbook before the freeze?');
    await postAs(nadia, chan.id, 'And a later message that is not for anyone.');
    await expect(page.getByTestId('bell-count')).toHaveText('1', { timeout: 3_000 });

    await page.getByTestId('bell').click();
    const pop = page.getByTestId('notifications-popover');
    await expect(pop).toContainText('Notifications');
    await expect(pop.getByRole('button', { name: 'Mark all' })).toBeEnabled();
    const item = pop.getByTestId('notification');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(`Nadia mentioned you in #${chan.name}`);
    await expect(item).toContainText('can you check the rollback runbook');
    await expect(item).toHaveAttribute('data-unread', 'true');

    await item.click();
    await expect(page).toHaveURL(new RegExp(`/t/engineering/c/${chan.name}\\?message=${posted.id}`));
    await expect(pop).toHaveCount(0);
    const target = page.locator(`[data-testid="message"][data-message-id="${posted.id}"]`);
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/hl/);
    await expect(messagesIn(page)).toHaveCount(3);
    // opening it read it: the badge is gone, the item stays in the list as read
    await expect(page.getByTestId('bell-count')).toHaveCount(0);
    await page.getByTestId('bell').click();
    await expect(page.getByTestId('notification')).toHaveAttribute('data-unread', 'false');
  } finally {
    await context.close();
  }
});

test('a reply on a followed thread and a direct message arrive too; Mark all clears the badge in every tab', async ({ browser, playwright }) => {
  const root = await postAs(rafi, chan.id, 'Rollout plan for the 2.4 release');
  const first = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  const second = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  try {
    // Rafi started the thread, so he follows it: a reply by Nadia notifies him, and so does her direct message
    await postAs(nadia, chan.id, 'Looks good to me, one question about the order.', root.id);
    const dm = await nadia.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [(await rafi.get<{ person: { id: string } }>('/api/session')).person.id] });
    await postAs(nadia, dm.dm.channel.id, 'Do you have a minute?');
    await expect(first.page.getByTestId('bell-count')).toHaveText('2', { timeout: 3_000 });
    await expect(second.page.getByTestId('bell-count')).toHaveText('2', { timeout: 3_000 });

    await first.page.getByTestId('bell').click();
    const items = first.page.getByTestId('notification');
    await expect(items).toHaveCount(3);
    await expect(items.filter({ hasText: 'replied in a thread' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'sent you a message' })).toHaveCount(1);

    // the reply opens its thread beside the channel
    await items.filter({ hasText: 'replied in a thread' }).click();
    await expect(first.page.getByTestId('thread-view')).toBeVisible();
    await expect(first.page).toHaveURL(new RegExp(`panel=thread(%3A|:)${root.id}`));

    await first.page.getByTestId('bell').click();
    await first.page.getByRole('button', { name: 'Mark all' }).click();
    await expect(first.page.getByTestId('bell-count')).toHaveCount(0);
    await expect(second.page.getByTestId('bell-count')).toHaveCount(0, { timeout: 3_000 });

    // the popover stays open after Mark all: the DM item (now read) lands on the conversation
    await first.page.getByTestId('notification').filter({ hasText: 'sent you a message' }).click();
    await expect(first.page).toHaveURL(new RegExp(`/t/engineering/dm/${dm.dm.channel.id}`));
    await expect(messagesIn(first.page).filter({ hasText: 'Do you have a minute?' })).toBeVisible();
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test('"Allow browser alerts?" asks the browser, stores the choice, and is absent without a Notification API', async ({ browser, playwright }) => {
  const prefsOf = () => rafi.get<{ mention: { browser: boolean } }>('/api/notifications/prefs');
  expect((await prefsOf()).mention.browser).toBe(false);

  // no Notification API (an old WebView): the row is not offered, nothing breaks
  const bare = await browser.newContext({ baseURL: stack.origin, storageState: await rafi.ctx.storageState() });
  await bare.addInitScript(() => {
    Reflect.deleteProperty(window, 'Notification');
  });
  const barePage = await bare.newPage();
  await barePage.goto('/t/engineering/threads');
  await barePage.getByTestId('bell').click();
  await expect(barePage.getByTestId('notifications-popover')).toBeVisible();
  await expect(barePage.getByTestId('allow-alerts')).toHaveCount(0);
  await bare.close();

  // with the API (a stand-in: headless Chromium always answers "denied"): the row shows, Allow asks the browser and the setting is saved
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads', {
    init: () => {
      const alerts: Array<{ title: string; body?: string }> = [];
      class FakeNotification {
        static permission = 'default';
        static requestPermission = (): Promise<string> => {
          FakeNotification.permission = 'granted';
          return Promise.resolve('granted');
        };
        constructor(title: string, options?: { body?: string }) {
          alerts.push({ title, ...(options?.body ? { body: options.body } : {}) });
        }
      }
      Object.assign(window, { Notification: FakeNotification, __alerts: alerts });
      // the tab is in front in a test browser; pretend it is not, as when the person works in another window
      document.hasFocus = () => false;
    },
  });
  try {
    await page.getByTestId('bell').click();
    const row = page.getByTestId('allow-alerts');
    await expect(row).toContainText('Allow browser alerts?');
    await row.getByRole('button', { name: 'Allow' }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await prefsOf()).mention.browser).toBe(true);
    // the live push now says `browser: true`: the page raises an operating-system alert
    await postAs(nadia, chan.id, '@rafi last call for the freeze notes');
    await expect(page.getByTestId('bell-count')).toBeVisible({ timeout: 3_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __alerts: unknown[] }).__alerts.length)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __alerts: Array<{ title: string; body: string }> }).__alerts[0])).toMatchObject({
      title: `Nadia mentioned you in #${chan.name}`,
      body: expect.stringContaining('last call for the freeze notes'),
    });
  } finally {
    await context.close();
  }
});
