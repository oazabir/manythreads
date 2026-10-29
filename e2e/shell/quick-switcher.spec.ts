import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * PLAN P14-10, the keyboard of the signed-in app, on a stack of its own (it marks Omar's channels read and opens conversations, which other
 * specs on the shared server must not see): Ctrl/Cmd+K opens the switcher, typing narrows it, arrows and Enter open the pick, Esc closes;
 * it finds people, bots and screens as well as channels; Alt+Down and Alt+Up walk the conversations with unread messages; Esc marks the open
 * conversation read and Shift+Esc everything; the open channel offers "Jump to first unread"; `?` opens the shortcut list.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'keyboard shortcuts of the desktop layout; a phone has no Ctrl/Cmd+K to press');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

const channel = async (name: string): Promise<{ id: string; name: string }> => {
  const res = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name });
  return { id: res.channel.id, name };
};
const unreadChannels = async (): Promise<string[]> => (await omar.get<{ channels: Array<{ channelId: string }> }>('/api/read-state/summary')).channels.map((c) => c.channelId);
/** Focus on the page itself, not in the composer: Esc and `?` mean typing inside a text box. */
const blurFocus = (page: Page): Promise<void> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test('Ctrl+K jumps to a channel: narrowing, arrows, Enter, Esc; Caps Lock does not matter', async ({ browser, playwright }) => {
  const open = await channel('jump-open');
  const hidden = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'jump-hidden', private: true });
  expect(hidden.channel.id).toBeTruthy();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    const dlg = page.getByTestId('quick-switcher');
    const search = page.getByTestId('quick-switcher-search');
    const options = page.getByTestId('quick-switcher-option');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(dlg).toBeVisible();
    await expect(search).toBeFocused();
    await expect(options.first()).toBeVisible();

    // typing narrows the list to the two channels; the first is selected; ArrowDown and Enter open the second
    await search.pressSequentially('jump-');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    const picked = (await options.nth(1).locator('.qs-label').textContent()) ?? '';
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/t/engineering/c/${picked}$`));
    await expect(dlg).toBeHidden();
    expect([open.name, 'jump-hidden']).toContain(picked);

    // Ctrl+K again closes an open switcher; Esc closes it too
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dlg).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dlg).toBeHidden();
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    // Caps Lock reports a capital K; a headless keyboard cannot switch it on, so the event is made the way the browser would
    await blurFocus(page);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, bubbles: true, cancelable: true })));
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  } finally {
    await context.close();
  }
});

test('the switcher also finds people, bots and screens', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    const search = page.getByTestId('quick-switcher-search');
    const options = page.getByTestId('quick-switcher-option');
    await expect(page.getByTestId('app-frame')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    await search.pressSequentially('boards');
    await expect(options.first()).toHaveAttribute('data-kind', 'section');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/t\/engineering\/boards$/);

    // a person: Enter opens (or makes) the conversation with them
    await page.keyboard.press('ControlOrMeta+k');
    await search.pressSequentially('nadia');
    await expect(options.first()).toHaveAttribute('data-kind', 'person');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/t\/engineering\/dm\/[0-9a-f-]{36}$/);

    // a bot of the team, when the seed has one
    const bots = await omar.get<{ bots: Array<{ name: string; slug: string }> }>('/api/teams/engineering/bots');
    const bot = bots.bots[0];
    if (bot) {
      await page.keyboard.press('ControlOrMeta+k');
      await search.pressSequentially(bot.name);
      const row = options.filter({ has: page.locator('.qs-label', { hasText: bot.name }) }).first();
      await expect(row).toHaveAttribute('data-kind', 'bot');
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/t/engineering/bots/${bot.slug}$`));
    }

    // nothing has that name
    await page.keyboard.press('ControlOrMeta+k');
    await search.pressSequentially('zzzqqq');
    await expect(page.getByTestId('quick-switcher')).toContainText('Nothing has that name.');
  } finally {
    await context.close();
  }
});

test('Alt+Down and Alt+Up walk the conversations with unread messages; Shift+Esc reads everything', async ({ browser, playwright }) => {
  const one = await channel('unread-one');
  const two = await channel('unread-two');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await blurFocus(page);

    // start from nothing unread: Shift+Esc reads everything, and says so
    await page.keyboard.press('Shift+Escape');
    await expect(page.getByTestId('quick-switcher-note')).toContainText(/marked as read|Nothing was unread/);
    await expect.poll(unreadChannels).toEqual([]);

    await postAs(nadia, one.id, 'first news');
    await postAs(nadia, two.id, 'second news');
    await expect(page.locator(`a[href$="/c/${one.name}"]`)).toHaveClass(/unread/);
    await expect(page.locator(`a[href$="/c/${two.name}"]`)).toHaveClass(/unread/);

    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(/\/t\/engineering\/c\/unread-(one|two)$/);
    const first = page.url().endsWith('unread-one') ? one : two;
    const other = first === one ? two : one;
    // opening a conversation reads it, so the next stop is the other one
    await expect.poll(async () => (await unreadChannels()).includes(first.id)).toBe(false);
    await blurFocus(page);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(new RegExp(`/c/${other.name}$`));
    await expect.poll(unreadChannels).toEqual([]);

    // nothing else is unread now
    await blurFocus(page);
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByTestId('quick-switcher-note')).toHaveText('Nothing else is unread.');

    // a new message in the other channel: Alt+Up finds it from here
    await postAs(nadia, first.id, 'third news');
    await expect.poll(async () => (await unreadChannels()).includes(first.id)).toBe(true);
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page).toHaveURL(new RegExp(`/c/${first.name}$`));
  } finally {
    await context.close();
  }
});

test('Esc marks the open conversation read, but not while a text box has focus', async ({ browser, playwright }) => {
  const chan = await channel('esc-read');
  const first = await postAs(nadia, chan.id, 'read me');
  await postAs(nadia, chan.id, 'and me');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${chan.name}`);
  try {
    await expect(page.getByText('and me')).toBeVisible();
    await expect.poll(async () => (await unreadChannels()).includes(chan.id)).toBe(false);

    // put the channel back to unread behind the page's back (what "Mark unread from here" does), then press Esc
    await omar.post(`/api/channels/${chan.id}/messages/${first.id}/unread`);
    await expect.poll(async () => (await unreadChannels()).includes(chan.id)).toBe(true);

    // in the composer Esc is the composer's own
    const box = page.getByRole('textbox', { name: `Message #${chan.name}` });
    await box.click();
    await page.keyboard.press('Escape');
    expect(await unreadChannels()).toContain(chan.id);

    await blurFocus(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-switcher-note')).toHaveText(`#${chan.name} marked as read.`);
    await expect.poll(async () => (await unreadChannels()).includes(chan.id)).toBe(false);
  } finally {
    await context.close();
  }
});

test('an open channel with unread messages offers Jump to first unread', async ({ browser, playwright }) => {
  const chan = await channel('first-unread');
  for (let i = 1; i <= 3; i++) await postAs(nadia, chan.id, `news ${i}`);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${chan.name}`);
  try {
    const jump = page.getByRole('button', { name: 'Jump to first unread' });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect(page.getByText('news 1')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('? opens the shortcut list outside a text box and not inside the composer', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const box = page.getByRole('textbox', { name: 'Message #dev' });
    await box.click();
    await box.pressSequentially('hi?');
    await expect(page.getByTestId('shortcut-sheet')).toHaveCount(0);
    await expect(box).toHaveValue('hi?');
    await box.fill('');
    await blurFocus(page);

    await page.keyboard.press('?');
    const sheet = page.getByTestId('shortcut-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Ctrl/Cmd+K');
    await expect(sheet).toContainText('Alt+↓');
    await expect(sheet).toContainText('Shift+Esc');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  } finally {
    await context.close();
  }
});
