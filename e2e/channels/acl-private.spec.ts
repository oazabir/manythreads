import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

// the desktop layout (hover actions, side panel); the phone layout has its own spec (mobile-web)
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/** e2e/channels/acl-private: a private channel is for its members only: not in the sidebar, "You cannot see this channel." by URL, live once added. */
test('a private channel is invisible to a non-member until they are added', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'secret', { private: true });
  await postMessage(omar, id, 'only the people in here may read this');

  const nadia = await openAs(browser, 'nadia', `/t/engineering/c/${name}`);
  const owner = await openAs(browser, 'omar', `/t/engineering/c/${name}`);
  try {
    await expect(nadia.page.getByTestId('no-access')).toContainText('You cannot see this channel.');
    await expect(nadia.page.locator('[data-landmark="sidebar"]')).not.toContainText(name);
    // not even the text leaks into the page
    await expect(nadia.page.locator('body')).not.toContainText('only the people in here');

    // the owner sees it, with the lock mark in the sidebar
    await expect(messages(owner.page)).toHaveCount(1);
    await expect(owner.page.locator('[data-landmark="sidebar"] a.it', { hasText: name })).toBeVisible();

    const me = (await nadiaApi.get('/api/session')) as { person: { id: string } };
    await omar.post(`/api/channels/${id}/members`, { personId: me.person.id });
    await nadia.page.reload();
    await expect(messages(nadia.page)).toHaveCount(1);
    await expect(nadia.page.locator('[data-landmark="sidebar"] a.it', { hasText: name })).toBeVisible();
    await expect(messages(nadia.page).first()).toContainText('only the people in here may read this');
  } finally {
    await nadia.context.close();
    await owner.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
