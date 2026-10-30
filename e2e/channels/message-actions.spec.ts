import { expect, test, type Locator } from '@playwright/test';
import { WEB, authState } from '../support/env.ts';
import { apiAs, bulkMessages, createChannel, messages, openAs, postMessage } from './support.ts';

// the desktop layout (hover actions); the phone layout has its own spec (mobile-web)
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/** PLAN P14-12: "(edited)" opens the earlier versions, "Copy link" gives a link that opens the message, "Forward…" posts a card. */
test('edit history, copy link and forward', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'actions');
  const target = await createChannel(omar, 'actions-target');
  const nadiaApi = await apiAs('nadia');
  const posted = await postMessage(nadiaApi, id, 'first wording');
  await nadiaApi.ctx.patch(`/api/channels/${id}/messages/${posted.id}`, { data: { body: 'second wording' }, headers: await nadiaApi.headers() });
  await nadiaApi.ctx.patch(`/api/channels/${id}/messages/${posted.id}`, { data: { body: 'third wording' }, headers: await nadiaApi.headers() });

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  await rafi.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    const row = messages(rafi.page).first();
    await expect(row).toContainText('third wording');

    // the earlier versions, oldest first, for a reader who is not the author (and no "Clear" button for them)
    await row.getByTestId('edited-mark').click();
    const versions = rafi.page.getByTestId('versions-popover').getByTestId('version');
    await expect(versions).toHaveCount(2);
    await expect(versions.nth(0)).toContainText('first wording');
    await expect(versions.nth(1)).toContainText('second wording');
    await expect(rafi.page.getByTestId('versions-clear')).toHaveCount(0);
    await rafi.page.keyboard.press('Escape');
    await expect(rafi.page.getByTestId('versions-popover')).toHaveCount(0);

    // copy link: the clipboard holds a link that opens the channel at the message
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(row.getByRole('status')).toHaveText('Link copied');
    const link = await rafi.page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain(`/open?channel=${id}&message=${posted.id}`);
    const other = await openAs(browser, 'rafi', new URL(link).pathname + new URL(link).search);
    try {
      await expect(other.page).toHaveURL(new RegExp(`/t/engineering/c/${name}\\?message=${posted.id}`));
      await expect(messages(other.page).first()).toContainText('third wording');
    } finally {
      await other.context.close();
    }

    // forward into another channel: a card with the author and an excerpt for a reader of the original
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Forward…' }).click();
    const dialog = rafi.page.getByTestId('forward-dialog');
    await dialog.getByRole('searchbox').fill(target.name);
    await dialog.getByTestId('forward-place').first().click();
    await dialog.getByLabel('Add a note (optional)').fill('worth a look');
    await dialog.getByTestId('forward-send').click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole('status')).toContainText(`Forwarded to #${target.name}`);

    const there = await openAs(browser, 'rafi', `/t/engineering/c/${target.name}`);
    try {
      const card = messages(there.page).first().getByTestId('forward-card');
      await expect(messages(there.page).first()).toContainText('worth a look');
      await expect(card).toContainText('Nadia');
      await expect(card).toContainText('third wording');
    } finally {
      await there.context.close();
    }
  } finally {
    await rafi.context.close();
  }
});

/** The element at the middle of `box` is the box itself or inside it: nothing (a row below, the composer) lies over it. */
const onTop = (box: Locator): Promise<boolean> =>
  box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at !== null && el.contains(at);
  });

/**
 * The newest messages sit at the composer: the "More" menu and the earlier-versions list must stay whole there (they open upward when there is no
 * room below), be reachable, and lie over the rows beside them, not under.
 */
test('menu and earlier versions stay reachable at the end of the list', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'actions-edge');
  await bulkMessages(omar, id, 40);
  const first = await postMessage(omar, id, 'first wording');
  await omar.ctx.patch(`/api/channels/${id}/messages/${first.id}`, { data: { body: 'first, final wording' }, headers: await omar.headers() });
  await postMessage(omar, id, 'middle one');
  await postMessage(omar, id, 'middle two');
  await postMessage(omar, id, 'middle three');
  const last = await postMessage(omar, id, 'newest wording');
  await omar.ctx.patch(`/api/channels/${id}/messages/${last.id}`, { data: { body: 'newest, final wording' }, headers: await omar.headers() });
  await postMessage(omar, id, 'the very last note');
  // The roster answers after the messages (it does, under load): the reader is not yet known as the author of the whole channel, and the
  // list must still open at the newest message, with no "New" line, instead of at the top as if all 40 messages were someone else's.
  const context = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 }, storageState: authState('omar') });
  const me = { page: await context.newPage(), context };
  await me.page.route('**/api/teams/engineering/roster', async (route) => {
    await new Promise((done) => setTimeout(done, 1_500));
    await route.continue();
  });
  await me.page.goto(`/t/engineering/c/${name}`);
  try {
    const page = me.page;
    await expect(messages(page).filter({ hasText: 'the very last note' })).toBeVisible();
    await expect(page.getByTestId('unread-divider')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    const list = page.getByRole('log');
    const inside = async (box: Locator): Promise<void> => {
      const l = (await list.boundingBox())!;
      const b = (await box.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(l.y - 1);
      expect(b.y + b.height).toBeLessThanOrEqual(l.y + l.height + 1);
      expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    };

    // the newest message: every item of its menu is whole, on top, and clickable
    const newest = messages(page).filter({ hasText: 'the very last note' });
    await newest.hover();
    await newest.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'Message' });
    await inside(menu);
    for (const item of ['Copy link', 'Forward…', 'Mark unread from here', 'Edit', 'Delete…']) {
      const it = menu.getByRole('menuitem', { name: item });
      await expect(it).toBeVisible();
      expect(await onTop(it), `${item} is under another element`).toBe(true);
    }
    await menu.getByRole('menuitem', { name: 'Delete…' }).click();
    await expect(menu.getByRole('menuitem', { name: 'Delete message' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await newest.hover();
    await newest.getByRole('button', { name: 'More actions' }).click();
    await menu.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(newest.getByRole('textbox', { name: 'Edit message' })).toBeVisible();
    await page.keyboard.press('Escape');

    // the reaction menu at the same place
    await newest.hover();
    await newest.getByRole('button', { name: 'Add reaction' }).click();
    const emoji = page.getByRole('menu', { name: 'Reactions' });
    await inside(emoji);
    expect(await onTop(emoji.getByRole('menuitem').first())).toBe(true);
    await page.keyboard.press('Escape');

    // earlier versions of the second-newest message (just above the last one) open whole and over its neighbours
    const edited = messages(page).filter({ hasText: 'newest, final wording' });
    await edited.getByTestId('edited-mark').click();
    const pop = page.getByTestId('versions-popover');
    await expect(pop.getByTestId('version')).toHaveCount(1);
    await inside(pop);
    expect(await onTop(pop)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);

    // a message high in the list: the list opens downward and the rows below it do not print over it
    const top = messages(page).filter({ hasText: 'first, final wording' });
    await top.getByTestId('edited-mark').click();
    await inside(pop);
    expect(await onTop(pop)).toBe(true);
    const next = (await messages(page).filter({ hasText: 'middle one' }).boundingBox())!;
    const box = (await pop.boundingBox())!;
    expect(box.y).toBeLessThan(next.y + next.height);
    await expect(pop.getByTestId('version')).toHaveCount(1);
  } finally {
    await me.context.close();
  }
});

/** A link to a message in a private channel shows the no-access page to someone who is not in it, and nothing of the message. */
test('a link to a message you cannot read shows no text', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id } = await createChannel(omar, 'actions-private', { private: true });
  const msg = await postMessage(omar, id, 'the secret launch date');
  const nadia = await openAs(browser, 'nadia', `/open?channel=${id}&message=${msg.id}`);
  try {
    await expect(nadia.page.getByTestId('no-access')).toContainText('You cannot see this message.');
    await expect(nadia.page.locator('body')).not.toContainText('secret launch date');
  } finally {
    await nadia.context.close();
  }
});

/** "Mark unread from here" keeps the channel unread while it is open, and the badge counts the message and the ones after it. */
test('mark unread from here', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'actions-unread');
  const nadiaApi = await apiAs('nadia');
  await postMessage(nadiaApi, id, 'first note');
  await postMessage(nadiaApi, id, 'second note');
  await postMessage(nadiaApi, id, 'third note');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    await expect(messages(rafi.page)).toHaveCount(3);
    const second = messages(rafi.page).filter({ hasText: 'second note' });
    await second.hover();
    await second.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(second.getByRole('status')).toHaveText('Marked unread from here');
    // a later mark takes the line from the earlier one
    const third = messages(rafi.page).filter({ hasText: 'third note' });
    await third.hover();
    await third.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(third.getByRole('status')).toHaveText('Marked unread from here');
    await expect(second.getByRole('status')).toHaveCount(0);
    await second.hover();
    await second.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(second.getByRole('status')).toHaveText('Marked unread from here');
    // the "New" line sits just above the second note, and the sidebar counts two
    await expect(rafi.page.getByTestId('unread-divider')).toHaveCount(1);
    await expect(rafi.page.getByRole('link', { name: new RegExp(`${name}.*2`) }).first()).toBeVisible();
    // the channel is still open and at the bottom, yet nothing marks it read again
    await rafi.page.waitForTimeout(800);
    await expect(rafi.page.getByTestId('unread-divider')).toHaveCount(1);
  } finally {
    await rafi.context.close();
  }
});

/** "Also send to channel" from a thread reply shows the reply in the channel too, marked with its thread. */
test('also send a thread reply to the channel', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'actions-also');
  const nadiaApi = await apiAs('nadia');
  const root = await postMessage(nadiaApi, id, 'which port do we use?');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    await messages(rafi.page).first().hover();
    await messages(rafi.page).first().getByRole('button', { name: 'Reply in thread' }).click();
    const thread = rafi.page.getByTestId('thread-view');
    await expect(thread.getByRole('textbox')).toBeVisible();
    await thread.getByTestId('also-to-channel').click();
    await expect(thread.getByTestId('also-to-channel')).toBeChecked();
    await thread.getByRole('textbox').fill('port 8443, for everybody');
    await thread.getByRole('textbox').press('Enter');
    await expect(thread).toContainText('port 8443, for everybody');
    const copy = messages(rafi.page.getByTestId('channel-view')).filter({ hasText: 'port 8443, for everybody' });
    await expect(copy).toHaveCount(1);
    await expect(copy.getByTestId('also-from-thread')).toContainText('Also sent from a thread');
    await expect(thread.getByTestId('also-to-channel')).not.toBeChecked();
    expect(root.id).toBeTruthy();
  } finally {
    await rafi.context.close();
  }
});

/** The bookmarks bar: a link and a page are added from the bar, show for another member, and can be removed. */
test('bookmarks bar', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'actions-bookmarks');
  await postMessage(omar, id, 'hello');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    await rafi.page.getByTestId('bookmark-add').click();
    const dialog = rafi.page.getByTestId('bookmark-dialog');
    await dialog.getByLabel('Web address').fill('https://example.com/runbook');
    await dialog.getByLabel('Name (optional)').fill('Runbook');
    await dialog.getByTestId('bookmark-save').click();
    await expect(dialog).toHaveCount(0);
    await rafi.page.getByTestId('bookmark-add').click();
    await dialog.getByRole('radio', { name: 'Page' }).click();
    await dialog.getByLabel('Page path').fill('pages/handbook.md');
    await dialog.getByTestId('bookmark-save').click();
    await expect(rafi.page.getByTestId('bookmark')).toHaveCount(2);
    await expect(rafi.page.getByRole('link', { name: 'Runbook' })).toHaveAttribute('href', 'https://example.com/runbook');
    await expect(rafi.page.getByRole('link', { name: 'handbook' })).toHaveAttribute('href', '/t/engineering/files?open=pages%2Fhandbook.md');

    const nadia = await openAs(browser, 'nadia', `/t/engineering/c/${name}`);
    try {
      await expect(nadia.page.getByTestId('bookmark')).toHaveCount(2);
      await nadia.page.getByRole('button', { name: 'Remove bookmark Runbook' }).click();
      await expect(nadia.page.getByTestId('bookmark')).toHaveCount(1);
    } finally {
      await nadia.context.close();
    }
  } finally {
    await rafi.context.close();
  }
});
