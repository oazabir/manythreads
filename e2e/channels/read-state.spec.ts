import { expect, test } from '@playwright/test';
import { apiAs, bulkMessages, createChannel, messages, openAs, postMessage } from './support.ts';

const sidebarRow = (page: import('@playwright/test').Page, name: string) => page.locator('[data-landmark="sidebar"] a.it', { hasText: name });

/** PLAN criterion 1 and e2e/channels/read-state: the badge counts what arrived, reading clears it, one "New" divider marks where it began. */
test('3 posts: badge 3 on the sidebar, open the channel: one divider, the badge goes to 0 and stays 0 after a reload', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'unread');
  const rafi = await openAs(browser, 'rafi', '/t/engineering/threads');
  try {
    // Rafi is elsewhere (Threads) while Nadia posts three messages: the badge appears live
    await expect(sidebarRow(rafi.page, name)).toBeVisible();
    for (const text of ['first', 'second', 'third']) await postMessage(nadiaApi, id, text);
    const row = sidebarRow(rafi.page, name);
    await expect(row.locator('.pill')).toHaveText('3', { timeout: 3_000 });
    await expect(row).toHaveClass(/unread/);

    // open it: three messages, exactly one divider, above the first; the bottom is in view so they are marked read
    await row.click();
    await expect(messages(rafi.page)).toHaveCount(3);
    await expect(rafi.page.getByTestId('unread-divider')).toHaveCount(1);
    await expect(rafi.page.locator('[data-testid="unread-divider"] ~ *, [data-testid="unread-divider"]')).not.toHaveCount(0);
    await expect(sidebarRow(rafi.page, name).locator('.pill')).toHaveCount(0, { timeout: 3_000 });
    await expect(rafi.page.getByTestId('unread-divider')).toHaveCount(1); // it stays while the channel is open

    // the order on screen: divider, then the three messages
    const order = await rafi.page.locator('.vlist [data-testid="unread-divider"], .vlist [data-testid="message"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(order).toEqual(['unread-divider', 'message', 'message', 'message']);

    // a message arriving while he watches the bottom is read at once: no badge, no second divider
    await postMessage(nadiaApi, id, 'fourth, while you are here');
    await expect(messages(rafi.page)).toHaveCount(4, { timeout: 2_000 });
    await expect(rafi.page.getByTestId('unread-divider')).toHaveCount(1);
    await expect(sidebarRow(rafi.page, name).locator('.pill')).toHaveCount(0);

    await rafi.page.reload();
    await expect(messages(rafi.page)).toHaveCount(4);
    await expect(rafi.page.getByTestId('unread-divider')).toHaveCount(0);
    await expect(sidebarRow(rafi.page, name).locator('.pill')).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

test('with the channel open but scrolled away, a new post lights the dot; scrolling to the bottom clears it', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'dot');
  await bulkMessages(omar, id, 90);
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    await expect(messages(rafi.page).last()).toContainText('bulk 90');
    const list = rafi.page.locator('.vlist');
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(rafi.page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    await postMessage(nadiaApi, id, 'ping while you are scrolled up');
    await expect(sidebarRow(rafi.page, name).locator('.pill')).toHaveText('1', { timeout: 3_000 });

    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(messages(rafi.page).last()).toContainText('ping while you are scrolled up');
    await expect(sidebarRow(rafi.page, name).locator('.pill')).toHaveCount(0, { timeout: 3_000 });
    await expect(rafi.page.getByRole('button', { name: 'Jump to latest' })).toBeHidden();
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
