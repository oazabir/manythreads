import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, type StackApi } from '../support/stack-browser.ts';

test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/**
 * PLAN criterion 3, first half: Priya is a `member` of two teams. She replies in a thread of Engineering from the right panel, switches to
 * Marketing (the section and the /t/<slug> URL follow), comes back, and her reply is where she left it. (The second half, the guest
 * invitation's grant, is e2e/channels/guest-invite.spec.ts.) Priya follows a thread here, so this runs on a stack of its own: on the shared
 * server it would change what her Threads inbox lists for e2e/threads/inbox.spec.ts.
 */
let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

test('Priya replies in an Engineering thread, switches to Marketing and back, and her reply is still there', async ({ browser, playwright }) => {
  const created = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'two-teams' });
  const id = created.channel.id;
  const root = await nadia.post<{ id: string }>(`/api/channels/${id}/messages`, { channelId: id, body: 'Who can pair on the release checklist?', threadRootId: null });
  const { page, context } = await openOn(browser, playwright, stack, 'priya', `/t/engineering/c/two-teams?panel=thread:${root.id}`);
  const panel = page.locator('[data-landmark="right-panel"]');
  try {
    await expect(panel.getByTestId('thread-view')).toContainText('Who can pair on the release checklist?');
    await panel.getByRole('textbox', { name: 'Reply in thread' }).fill('I can, after standup.');
    await page.keyboard.press('Enter');
    await expect(panel.getByTestId('message')).toHaveCount(2); // the root and her reply, sent
    await expect(panel.getByTestId('pending-message')).toHaveCount(0);

    // the team switch lists exactly her two teams and keeps the URL shape
    await page.getByRole('button', { name: /Team/ }).click();
    const menu = page.getByRole('menu', { name: 'Teams' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await menu.getByRole('menuitemradio', { name: 'Marketing' }).click();
    await expect(page).toHaveURL(/\/t\/marketing\/threads/);
    await expect(page.locator('[data-landmark="search"] input')).toHaveAttribute('placeholder', 'Search Marketing');

    await page.getByRole('button', { name: /Team/ }).click();
    await page.getByRole('menu', { name: 'Teams' }).getByRole('menuitemradio', { name: 'Engineering' }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/threads/);
    await page.goto(`/t/engineering/c/two-teams?panel=thread:${root.id}`);
    await expect(panel.getByTestId('thread-view')).toContainText('I can, after standup.');
    await expect(page.locator('[data-landmark="content"]').getByTestId('message').first().getByRole('button', { name: '1 reply' })).toBeVisible();
  } finally {
    await context.close();
  }
});
