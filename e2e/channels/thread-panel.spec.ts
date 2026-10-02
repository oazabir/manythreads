import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

/** PLAN criterion 2 and e2e/channels/thread-panel: a thread opens in the right panel with the channel visible; two pushes, Back, reload. */
test('open a thread, reply, push a second panel, Back, reload on the deep link', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'threads');
  const a = await postMessage(nadiaApi, id, 'Release notes for 2.4 are drafted.');
  const b = await postMessage(nadiaApi, id, 'Who owns the rollback runbook?');
  await postMessage(nadiaApi, id, 'A reply already waiting', a.id);

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const nadia = await openAs(browser, 'nadia', `/t/engineering/c/${name}`);
  const { page } = rafi;
  const panel = page.locator('[data-landmark="right-panel"]');
  try {
    await expect(messages(page)).toHaveCount(2);
    // "1 reply" opens the thread in the right panel; the channel stays where it was
    await messages(page).nth(0).getByRole('button', { name: '1 reply' }).click();
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`panel=thread(%3A|:)${a.id}`));
    await expect(panel.getByTestId('thread-view')).toContainText('Release notes for 2.4 are drafted.');
    await expect(panel.getByTestId('thread-view')).toContainText('A reply already waiting');
    await expect(panel.getByTestId('thread-channel')).toContainText(`# ${name}`);
    await expect(page.locator('[data-landmark="content"]')).toBeVisible();
    await expect(messages(page.locator('[data-landmark="content"]'))).toHaveCount(2);

    // reply in the panel: shown at once, counted on the root in the channel, live on Nadia's screen
    const reply = panel.getByRole('textbox', { name: 'Reply in thread' });
    await expect(reply).toBeFocused();
    await reply.fill('On it, I will take the runbook.');
    await page.keyboard.press('Enter');
    await expect(panel.getByTestId('message')).toHaveCount(3); // root + two replies
    await expect(messages(page.locator('[data-landmark="content"]')).nth(0).getByRole('button', { name: '2 replies' })).toBeVisible();
    await expect(messages(nadia.page).nth(0).getByRole('button', { name: '2 replies' })).toBeVisible({ timeout: 2_000 });

    // a second thread on top of the first: two panels, Back shows the first again, the URL follows
    await messages(page.locator('[data-landmark="content"]')).nth(1).hover();
    await messages(page.locator('[data-landmark="content"]')).nth(1).getByRole('button', { name: 'Reply in thread' }).click();
    await expect(panel.getByTestId('thread-view')).toContainText('Who owns the rollback runbook?');
    await expect(page).toHaveURL(new RegExp(`panel=thread(%3A|:)${b.id}`));
    await expect(panel.getByRole('button', { name: 'Back' })).toBeVisible();
    await panel.getByRole('button', { name: 'Back' }).click();
    await expect(panel.getByTestId('thread-view')).toContainText('Release notes for 2.4 are drafted.');
    await expect(page).toHaveURL(new RegExp(`panel=thread(%3A|:)${a.id}`));

    // reload on the deep link: the same thread, with its replies, beside the same channel
    await page.reload();
    await expect(panel.getByTestId('thread-view')).toContainText('On it, I will take the runbook.');
    await expect(panel.getByTestId('thread-view')).toHaveAttribute('data-root-id', a.id);
    await expect(messages(page.locator('[data-landmark="content"]'))).toHaveCount(2);

    // a reply from someone else arrives in the open panel without a reload
    await postMessage(nadiaApi, id, 'Thanks, Rafi.', a.id);
    await expect(panel.getByTestId('message')).toHaveCount(4);
    await expect(panel).toContainText('Thanks, Rafi.');

    // Esc closes the panel; the channel remains
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(messages(page)).toHaveCount(2);
  } finally {
    await rafi.context.close();
    await nadia.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

test('a thread link that is not there says so instead of failing', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { name } = await createChannel(omar, 'nothread');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}?panel=thread:00000000-0000-7000-8000-000000000999`);
  try {
    await expect(rafi.page.getByTestId('thread-unavailable')).toContainText('This thread is not available.');
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});

test('following: the toggle in the panel is the same state the Threads inbox lists (when the threads service is there)', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'follow');
  const root = await postMessage(nadiaApi, id, 'Plan the migration window.');
  const probe = await omar.ctx.get(`/api/threads/${root.id}`);
  test.skip(probe.status() === 404, 'no threads service on this server');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}?panel=thread:${root.id}`);
  const panel = rafi.page.locator('[data-landmark="right-panel"]');
  try {
    const toggle = panel.getByRole('switch', { name: 'Follow thread' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByTestId('follow-state')).toContainText('Following');
    await rafi.page.reload();
    await expect(panel.getByRole('switch', { name: 'Follow thread' })).toHaveAttribute('aria-checked', 'true');
    await panel.getByRole('switch', { name: 'Follow thread' }).click();
    await expect(panel.getByRole('switch', { name: 'Follow thread' })).toHaveAttribute('aria-checked', 'false');
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
