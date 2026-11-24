import { expect, test, type Page } from '@playwright/test';
import { apiAs, createChannel, openAs, postMessage, uniqueName, type Api } from './support.ts';

/**
 * Bookmarks, step 1 (P36-08, docs/plans/bookmarks.md): Rafi bookmarks a thread from the bookmark at the top right of the thread pane, and a message from its
 * More menu (the row then shows a small mark). The sidebar shows Bookmarks only while he has one, in a second tab too (the push). The Threads view's
 * Bookmarked filter lists the thread he does not follow. The Bookmarks page has Threads and Messages: a thread opens with the thread on the right, a channel
 * message opens the channel at it, a reply opens its thread on the right. A deleted message says "No longer available" and nothing of it. Removing the last
 * bookmark hides the sidebar entry. One check at 390 px. Rafi's bookmarks are emptied first: the entry depends on his count.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };

let nadia: Api;
let rafi: Api;
let channel = { id: '', name: '' };
let tag = '';
const ids: Record<string, string> = {};

const keys = async (): Promise<{ total: number; items: Array<{ id: string; kind: string; key: string }> }> => (await rafi.get('/api/bookmarks/keys')) as never;
const clearRafi = async (): Promise<void> => {
  for (const k of (await keys()).items) await rafi.ctx.delete(`/api/bookmarks/${k.id}`, { headers: await rafi.headers() });
};
const put = async (target: Record<string, unknown>): Promise<void> => {
  const res = await rafi.ctx.put('/api/bookmarks', { data: { target }, headers: await rafi.headers() });
  expect(res.status(), await res.text()).toBeLessThan(300);
};
const sidebarEntry = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Bookmarks' });
const row = (page: Page, key: string) => page.locator(`[data-message-id="${ids[key]}"]`).first();

test.beforeAll(async () => {
  nadia = await apiAs('nadia');
  rafi = await apiAs('rafi');
  const omar = await apiAs('omar');
  channel = await createChannel(omar, 'bkm');
  await omar.ctx.dispose();
  tag = uniqueName('bk');
  // Nadia starts two threads and answers them herself, so Rafi follows neither; one plain message; one reply worth keeping
  ids['root'] = (await postMessage(nadia, channel.id, `${tag} release plan thread`)).id;
  await postMessage(nadia, channel.id, `${tag} first answer`, ids['root']);
  ids['root2'] = (await postMessage(nadia, channel.id, `${tag} second thread`)).id;
  ids['reply'] = (await postMessage(nadia, channel.id, `${tag} the reply worth keeping`, ids['root2'])).id;
  ids['plain'] = (await postMessage(nadia, channel.id, `${tag} plain message to keep`)).id;
  ids['gone'] = (await postMessage(nadia, channel.id, `${tag} canary words soon deleted`)).id;
  await clearRafi();
});
test.afterAll(async () => {
  await clearRafi().catch(() => undefined);
  await Promise.all([nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout; one 390 px check at the end');

  test('the bookmark at the top right of the thread pane; the sidebar entry appears, in a second tab too', async ({ browser }) => {
    const other = await openAs(browser, 'rafi', '/t/engineering/drafts');
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}?panel=thread:${ids['root']}`);
    try {
      await expect(other.page.getByTestId('drafts')).toBeVisible(T);
      await expect(sidebarEntry(other.page)).toHaveCount(0);
      await expect(sidebarEntry(page)).toHaveCount(0);
      const toggle = page.getByTestId('thread-bookmark');
      await expect(toggle).toBeVisible(T);
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(toggle).toHaveAccessibleName('Bookmark thread');
      // it is the last of the thread's own tools, before the panel's Expand and Close
      const box = await toggle.boundingBox();
      const follow = await page.getByTestId('thread-follow').boundingBox();
      expect(box!.x).toBeGreaterThan(follow!.x);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('bookmark-toast')).toHaveText('Thread bookmarked');
      await expect(sidebarEntry(page)).toBeVisible(T);
      // the other tab hears it from the server
      await expect(sidebarEntry(other.page)).toBeVisible(T);
    } finally {
      await context.close();
      await other.context.close();
    }
    expect((await keys()).items.map((k) => [k.kind, k.key])).toEqual([['thread', ids['root']]]);
  });

  test('a message from its More menu: the row shows the mark; a thread root offers both', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      const r = row(page, 'plain');
      await expect(r).toBeVisible(T);
      await r.hover();
      await r.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Bookmark', exact: true }).click();
      await expect(r.getByTestId('bookmarked-mark')).toBeVisible(T);
      await expect(page.getByTestId('bookmark-toast')).toHaveText('Message bookmarked');
      // the first message of a thread offers both, and the thread is already bookmarked
      const root = row(page, 'root');
      await root.hover();
      await root.getByRole('button', { name: 'More actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Bookmark message' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Remove thread bookmark' })).toBeVisible();
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
    }
    await put({ kind: 'message', messageId: ids['reply'] });
  });

  test('the Threads view Bookmarked filter lists the thread he does not follow', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', '/t/engineering/threads?tab=followed&bookmarked=1');
    try {
      const toggle = page.getByTestId('threads-bookmarked');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true', T);
      await expect(page.getByTestId('thread-row').filter({ hasText: `${tag} release plan thread` })).toBeVisible(T);
      await expect(page.getByTestId('thread-row').filter({ hasText: `${tag} second thread` })).toHaveCount(0);
      await toggle.click();
      await expect(page).not.toHaveURL(/bookmarked=1/);
      await expect(page.getByTestId('thread-row').filter({ hasText: `${tag} release plan thread` })).toHaveCount(0, T);
    } finally {
      await context.close();
    }
  });

  test('the Bookmarks page: Threads and Messages with counts; each opens where it lives', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', '/t/engineering/bookmarks');
    try {
      await expect(page.getByTestId('bookmarks-screen')).toBeVisible(T);
      await expect(page.getByRole('tab', { name: /Threads · 1/ })).toHaveAttribute('aria-selected', 'true', T);
      await expect(page.getByRole('tab', { name: /Messages · 2/ })).toBeVisible();
      const thread = page.getByTestId('bookmark-row').filter({ hasText: `${tag} release plan thread` });
      await expect(thread).toContainText(`# ${channel.name}`);
      await expect(thread).toContainText('1 reply');
      await thread.getByTestId('bookmark-open').click();
      await expect(page).toHaveURL(new RegExp(`/c/${channel.name}\\?.*panel=thread(%3A|:)${ids['root']}`), T);
      await expect(page.getByTestId('thread-bookmark')).toHaveAttribute('aria-pressed', 'true', T);

      await page.goBack();
      await page.getByRole('tab', { name: /Messages/ }).click();
      await expect(page).toHaveURL(/tab=message/);
      const reply = page.getByTestId('bookmark-row').filter({ hasText: 'the reply worth keeping' });
      await expect(reply).toContainText(`Thread in # ${channel.name}`);
      await reply.getByTestId('bookmark-open').click();
      await expect(page).toHaveURL(new RegExp(`message=${ids['root2']}.*panel=thread(%3A|:)${ids['root2']}`), T);
      await expect(row(page, 'reply')).toBeVisible(T);

      await page.goBack();
      const plain = page.getByTestId('bookmark-row').filter({ hasText: 'plain message to keep' });
      await plain.getByTestId('bookmark-open').click();
      await expect(page).toHaveURL(new RegExp(`/c/${channel.name}\\?message=${ids['plain']}`), T);
      await expect(row(page, 'plain')).toBeVisible(T);
    } finally {
      await context.close();
    }
  });

  test('a deleted message says "No longer available", nothing of it; removing every bookmark hides the sidebar entry', async ({ browser }) => {
    await put({ kind: 'message', messageId: ids['gone'] });
    const del = await nadia.ctx.delete(`/api/channels/${channel.id}/messages/${ids['gone']}`, { headers: await nadia.headers() });
    expect(del.status()).toBeLessThan(300);
    const { page, context } = await openAs(browser, 'rafi', '/t/engineering/bookmarks?tab=message');
    try {
      const gone = page.getByTestId('bookmark-gone');
      await expect(gone).toHaveText('No longer available', T);
      await expect(page.getByTestId('bookmarks-screen')).not.toContainText('canary words');
      // Delete with the keyboard; what is no longer available cannot come back, so it has no Undo
      await gone.focus();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('bookmark-gone')).toHaveCount(0);
      await expect(page.getByTestId('bookmark-toast')).toHaveText('Bookmark removed');
      await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
      // a live one: Delete removes it, Undo brings it back
      const plain = page.getByTestId('bookmark-row').filter({ hasText: 'plain message to keep' });
      await plain.getByTestId('bookmark-open').focus();
      await page.keyboard.press('Delete');
      await expect(plain).toHaveCount(0);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(plain).toHaveCount(1, T);
      // remove them all from the page
      for (const tab of ['Messages', 'Threads']) {
        await page.getByRole('tab', { name: new RegExp(tab) }).click();
        const rows = page.getByTestId('bookmark-row');
        await expect(rows.first()).toBeVisible(T);
        while ((await rows.count()) > 0) {
          const before = await rows.count();
          await rows.first().getByTestId('bookmark-remove').click();
          await expect(rows).toHaveCount(before - 1, T);
        }
      }
      await expect(page.getByTestId('bookmarks-empty')).toContainText('No bookmarked threads');
      await expect(sidebarEntry(page)).toHaveCount(0, T);
    } finally {
      await context.close();
    }
    expect((await keys()).total).toBe(0);
  });

  test('390 px: one column, the tabs on one row, no sideways scroll', async ({ browser }) => {
    await put({ kind: 'thread', rootMessageId: ids['root'] });
    const { page, context } = await openAs(browser, 'rafi', '/t/engineering/bookmarks', { width: 390, height: 844 }, true);
    try {
      await expect(page.getByTestId('bookmark-row').first()).toBeVisible(T);
      const [a, b] = await Promise.all([page.getByTestId('bookmarks-tab-thread').boundingBox(), page.getByTestId('bookmarks-tab-message').boundingBox()]);
      expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
      const rowBox = await page.getByTestId('bookmark-row').first().boundingBox();
      expect(rowBox!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
});
