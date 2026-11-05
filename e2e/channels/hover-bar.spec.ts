import { expect, test, type Page } from '@playwright/test';
import { apiAs, bulkMessages, createChannel, messages, openAs, postMessage } from './support.ts';

/*
 * P21-02 and P21-05: the hover bar's quick reactions and the + pill, who reacted, keys on a focused row, Esc reading the list with Undo,
 * Jump to latest with a count, and the day pills. The quick "React with 👍" button (inside .acts) and the menu item of the same name
 * share an accessible name, so each is looked up inside its own container.
 */

const acts = (row: ReturnType<typeof messages>) => row.locator('.acts');
const unreadIds = async (api: Awaited<ReturnType<typeof apiAs>>): Promise<string[]> =>
  ((await api.get('/api/read-state/summary')) as { channels: Array<{ channelId: string }> }).channels.map((c) => c.channelId);

test('a quick reaction in the hover bar adds a pill with one click', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'the hover bar is the desktop layout');
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'hoverbar');
  await postMessage(omar, id, 'react to this one');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const row = messages(rafi.page).first();
    await expect(row).toContainText('react to this one');
    await row.hover();
    await acts(row).getByRole('button', { name: 'React with 👍' }).click();
    const pill = row.locator('.reactions .rx:not(.rx-add)');
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText('1');
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
    // clicking the pill takes it back
    await pill.click();
    await expect(row.locator('.reactions .rx:not(.rx-add)')).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});

test('the + pill opens the reaction menu and a pick adds a reaction', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'the hover bar is the desktop layout');
  const omar = await apiAs('omar');
  const nadia = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'plus');
  const m = await postMessage(omar, id, 'has a reaction already');
  await nadia.post(`/api/channels/${id}/messages/${m.id}/reactions`, { emoji: '🎉' });
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const row = messages(rafi.page).first();
    await expect(row.locator('.reactions .rx')).not.toHaveCount(0);
    const plus = row.getByRole('button', { name: 'Add another reaction' });
    // faint until the row is hovered or focused; focus makes it whole
    await row.hover();
    await expect(plus).toHaveCSS('opacity', '1');
    await plus.click();
    const menu = rafi.page.getByRole('menu', { name: 'Reactions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'React with ✅' }).click();
    await expect(menu).toHaveCount(0);
    await expect(row.locator('.reactions .rx:not(.rx-add)')).toHaveCount(2);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
  }
});

test('hovering a reaction pill for a moment names who reacted', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'the hover bar is the desktop layout');
  const omar = await apiAs('omar');
  const nadia = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'who');
  const m = await postMessage(omar, id, 'who clapped');
  await nadia.post(`/api/channels/${id}/messages/${m.id}/reactions`, { emoji: '👍' });
  await omar.post(`/api/channels/${id}/messages/${m.id}/reactions`, { emoji: '👍' });
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const row = messages(rafi.page).first();
    const pill = row.locator('.reactions .rx:not(.rx-add)');
    await expect(pill).toContainText('2');
    await pill.hover();
    const tip = rafi.page.getByRole('tooltip');
    await expect(tip).toContainText('Nadia');
    await expect(tip).toContainText('Omar');
    await expect(tip).toContainText('reacted with 👍');
    // moving away takes it down
    await rafi.page.mouse.move(5, 5);
    await expect(tip).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
  }
});

test('e and r act on a focused row, and are plain letters while typing in the composer', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'the hover bar is the desktop layout');
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'keys');
  await postMessage(omar, id, 'my own words');
  const page: Page = (await openAs(browser, 'omar', `/t/engineering/c/${name}`)).page;
  try {
    const row = messages(page).first();
    await expect(row).toContainText('my own words');

    // typing in the composer: no edit box, no thread
    const box = page.getByRole('textbox', { name: `Message #${name}` });
    await box.click();
    await page.keyboard.type('re');
    await expect(box).toContainText('re');
    await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0);
    await expect(page.getByTestId('thread-panel')).toHaveCount(0);
    await box.clear();

    // r on the focused row opens the thread
    await row.focus();
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/panel=|thread/);
    await page.keyboard.press('Escape');

    // e on the focused row edits it
    await row.focus();
    await page.keyboard.press('e');
    await expect(row.getByRole('textbox', { name: 'Edit message' })).toBeVisible();
  } finally {
    await page.context().close();
    await omar.ctx.dispose();
  }
});

test('Esc on the message list marks it read with Undo; Esc closing a menu does not', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'the hover bar is the desktop layout');
  const omar = await apiAs('omar');
  const rafiApi = await apiAs('rafi');
  const { id, name } = await createChannel(omar, 'esc');
  const first = await postMessage(omar, id, 'one to read');
  await postMessage(omar, id, 'two to read');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const page = rafi.page;
  try {
    const row = messages(page).first();
    await expect(messages(page).last()).toContainText('two to read');
    await expect.poll(async () => (await unreadIds(rafiApi)).includes(id)).toBe(false);
    await rafiApi.post(`/api/channels/${id}/messages/${first.id}/unread`);
    await expect.poll(async () => (await unreadIds(rafiApi)).includes(id)).toBe(true);

    // a menu is open: Esc closes the menu and reads nothing
    await row.focus();
    await row.hover();
    await acts(row).getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'Message' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    expect(await unreadIds(rafiApi)).toContain(id);

    // the list has focus and nothing is open: Esc reads, says so, and Undo puts the New line back
    await row.focus();
    await page.keyboard.press('Escape');
    const toast = page.getByTestId('toast');
    await expect(toast).toContainText('marked as read');
    await expect.poll(async () => (await unreadIds(rafiApi)).includes(id)).toBe(false);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await unreadIds(rafiApi)).includes(id)).toBe(true);
    await expect(toast).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await rafiApi.ctx.dispose();
  }
});

test('Jump to latest counts the new messages that came while scrolled up; the day pill shows', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadia = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'jump');
  await bulkMessages(omar, id, 90);
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const page = rafi.page;
  try {
    await expect(messages(page).last()).toContainText('bulk 90');
    const list = page.locator('.vlist');
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    // the day divider is a pill
    await expect(page.locator('.vlist .daysep span').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    await postMessage(nadia, id, 'first while away');
    await expect(page.getByRole('button', { name: 'Jump to latest, 1 new message' })).toBeVisible();
    await postMessage(nadia, id, 'second while away');
    const jump = page.getByRole('button', { name: 'Jump to latest, 2 new messages' });
    await expect(jump).toContainText('2 new messages');

    // scrolled a little: the day stays on top as a floating pill
    await list.evaluate((el) => {
      el.scrollTop = 800;
    });
    await expect(page.locator('.day-float')).toBeVisible();

    await jump.click();
    await expect(messages(page).last()).toContainText('second while away');
    await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeHidden();
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
  }
});
