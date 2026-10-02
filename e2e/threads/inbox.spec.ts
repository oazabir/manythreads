import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from '../channels/support.ts';

// the desktop layout (hover actions, side panel); the phone layout has its own spec (mobile-web)
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/**
 * PLAN criterion 4 and e2e/threads/inbox: Followed lists what I follow, Unread lists threads with replies I have not read, Mine lists
 * the threads I started. Also the keyboard (j, k, e) and the live Threads badge. Needs the threads service; skipped on a server without it.
 */
test('three tabs list the right threads; opening one reads it; j, k and e move and mark', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const priyaApi = await apiAs('priya');
  const { id } = await createChannel(omar, 'inbox');

  // Priya reads (no other spec posts in threads she is in). T1: she starts it, Nadia replies. T2: Nadia starts it, she replies. T3: Nadia starts it, Omar replies (she is not in it).
  const t1 = await postMessage(priyaApi, id, 'T1 Priya asks about the rollback runbook');
  const t2 = await postMessage(nadiaApi, id, 'T2 Nadia proposes a release freeze');
  const t3 = await postMessage(nadiaApi, id, 'T3 Nadia and Omar talk budget');
  const probe = await priyaApi.ctx.get(`/api/threads/${t1.id}`);
  test.skip(probe.status() === 404, 'no threads service on this server');
  await postMessage(nadiaApi, id, 'T1 reply from Nadia', t1.id);
  await postMessage(priyaApi, id, 'T2 reply from Priya', t2.id);
  await postMessage(omar, id, 'T3 reply from Omar', t3.id);

  const reader = await openAs(browser, 'priya', '/t/engineering/threads');
  const { page } = reader;
  const rows = page.getByTestId('thread-row');
  const tab = (label: string) => page.getByRole('tab', { name: new RegExp(`^${label}`) });
  try {
    // Followed: T1 and T2 (she follows what she started once it has a reply, and what she replied to), not T3
    await expect(tab('Followed')).toHaveAttribute('aria-selected', 'true');
    await expect(rows.filter({ hasText: 'T1 Priya asks' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'T2 Nadia proposes' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'T3 Nadia and Omar' })).toHaveCount(0);

    // Unread: only T1 (Nadia's reply she has not read); T2's only reply is her own
    await tab('Unread').click();
    await expect(rows.filter({ hasText: 'T1 Priya asks' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'T2 Nadia proposes' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'T1 Priya asks' }).locator('.cnt')).toHaveText('1');
    await expect(page.locator('[data-landmark="sidebar"] > a.it', { hasText: 'Threads' }).locator('.pill')).toHaveText(/^[1-9]/);

    // Mine: T1 only (she wrote the root)
    await tab('Mine').click();
    await expect(rows.filter({ hasText: 'T1 Priya asks' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'T2 Nadia proposes' })).toHaveCount(0);

    // opening T1 shows it in the main area, beside the list; it is read, so Unread no longer lists it
    await tab('Followed').click();
    await rows.filter({ hasText: 'T1 Priya asks' }).click();
    const view = page.getByTestId('thread-view');
    await expect(view).toContainText('T1 reply from Nadia');
    await expect(view).toContainText('T1 Priya asks about the rollback runbook');
    await expect(rows.filter({ hasText: 'T1 Priya asks' }).locator('.cnt')).toHaveCount(0, { timeout: 4_000 }); // read: the count on its row goes
    await tab('Unread').click();
    await expect(rows.filter({ hasText: 'T1 Priya asks' })).toHaveCount(0, { timeout: 4_000 });
    await expect(page.getByTestId('threads-empty')).toContainText('You are all caught up');
    await expect(page.locator('[data-landmark="sidebar"] > a.it', { hasText: 'Threads' }).locator('.pill')).toHaveCount(0);

    // a new reply lights the badge and the Unread tab live; j and k move; e marks the selected thread read
    await postMessage(nadiaApi, id, 'T2 another reply', t2.id);
    await expect(rows.filter({ hasText: 'T2 Nadia proposes' })).toHaveCount(1, { timeout: 4_000 });
    await postMessage(nadiaApi, id, 'T1 another reply', t1.id);
    await expect(rows).toHaveCount(2, { timeout: 4_000 });
    const selected = (): Promise<string[]> => rows.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.textContent ?? ''));
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('j');
    await expect.poll(async () => (await selected()).length).toBe(1);
    const first = (await selected())[0] ?? '';
    await page.keyboard.press('j');
    await expect.poll(async () => (await selected())[0]).not.toBe(first);
    await page.keyboard.press('k');
    await expect.poll(async () => (await selected())[0]).toBe(first);
    await page.keyboard.press('e');
    await expect(rows).toHaveCount(1, { timeout: 4_000 });
    await expect(rows.first()).not.toContainText(first.slice(0, 20));
  } finally {
    await reader.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
    await priyaApi.ctx.dispose();
  }
});

test('a thread in the inbox opens in the main area and the channel link goes to its message', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'inbox2');
  const root = await postMessage(nadiaApi, id, 'Inbox link target');
  const probe = await omar.ctx.get(`/api/threads/${root.id}`);
  test.skip(probe.status() === 404, 'no threads service on this server');
  await postMessage(omar, id, 'a reply', root.id);
  const nadia = await openAs(browser, 'nadia', '/t/engineering/threads');
  try {
    await nadia.page.getByTestId('thread-row').filter({ hasText: 'Inbox link target' }).click();
    await expect(nadia.page.getByTestId('thread-view')).toContainText('a reply');
    await nadia.page.getByRole('link', { name: 'Open channel' }).click();
    await expect(nadia.page).toHaveURL(new RegExp(`/c/${name}\\?message=${root.id}`));
    await expect(messages(nadia.page).filter({ hasText: 'Inbox link target' })).toBeVisible();
  } finally {
    await nadia.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
