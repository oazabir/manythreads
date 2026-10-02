import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

test.skip(({ isMobile }) => isMobile, 'desktop layout');

/**
 * PLAN criterion 3, first half: Priya is a `member` of two teams. She replies in a thread of Engineering from the right panel, switches to
 * Marketing (the section and the /t/<slug> URL follow), comes back, and her reply is where she left it. (The second half, the guest
 * invitation's grant, is e2e/channels/guest-invite.spec.ts.)
 */
test('Priya replies in an Engineering thread, switches to Marketing and back, and her reply is still there', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'two-teams');
  const root = await postMessage(nadiaApi, id, 'Who can pair on the release checklist?');
  const priya = await openAs(browser, 'priya', `/t/engineering/c/${name}?panel=thread:${root.id}`);
  const { page } = priya;
  const panel = page.locator('[data-landmark="right-panel"]');
  try {
    await expect(panel.getByTestId('thread-view')).toContainText('Who can pair on the release checklist?');
    const reply = panel.getByRole('textbox', { name: 'Reply in thread' });
    await reply.fill('I can, after standup.');
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
    await page.goto(`/t/engineering/c/${name}?panel=thread:${root.id}`);
    await expect(panel.getByTestId('thread-view')).toContainText('I can, after standup.');
    await expect(messages(page.locator('[data-landmark="content"]')).first().getByRole('button', { name: '1 reply' })).toBeVisible();
  } finally {
    await priya.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
