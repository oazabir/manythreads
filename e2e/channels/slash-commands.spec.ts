import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, noSidewaysScroll, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * Slash commands in the message box (PLAN P14-06), on a stack of its own (the spec posts messages and creates cards). Omar leads Engineering and
 * writes in #dev, which has a Bot Board and the `coder` bot (seed v6): `/ask coder …` posts a message that mentions the bot, `/task …` makes a
 * card on the channel's own board and says so with a link, `//ask` posts a literal `/ask`, an unknown `/xyz` is posted as typed, `/help` lists
 * the commands. The menu is driven by the keyboard only. Lena is a guest with a read grant on #releases: she gets no message box at all,
 * and the server refuses her a card.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the 390 px phone is opened with its own viewport below');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let lena: StackApi;
let dev = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
  omar = await apiOn(playwright, stack, 'omar');
  lena = await apiOn(playwright, stack, 'lena');
  dev = (await channelsOf(omar))['dev']!;
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), lena?.ctx.dispose()]);
  await stack?.stop();
});

const SHRUG_STORED = '¯\\\\\\_(ツ)\\_/¯';
const box = (page: Page) => page.getByRole('textbox', { name: 'Message #dev' });
const menu = (page: Page) => page.getByTestId('slash-menu');

/** The bodies of the channel's messages, as the server keeps them. */
async function bodies(channelId: string): Promise<string[]> {
  const page = await omar.get<{ items: Array<{ body: string }> }>(`/api/channels/${channelId}/messages?limit=200`);
  return page.items.map((m) => m.body);
}

test('the menu opens on a slash at the start, is driven by the keyboard, and never opens elsewhere', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const input = box(page);
    await expect(input).toBeVisible();
    await input.click();
    await input.pressSequentially('/');
    const list = menu(page);
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('role', 'listbox');
    await expect(list.getByRole('option')).toHaveCount(5);
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-expanded', 'true');

    // arrows move, and wrap
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');

    // typing narrows; Tab picks and leaves the box ready for the words
    await input.pressSequentially('ta');
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option').first()).toContainText('/task <title>');
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('/task ');
    await expect(list).toBeHidden();

    // Esc closes the menu and keeps what was typed
    await input.fill('');
    await input.pressSequentially('/h');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(input).toHaveValue('/h');

    // never in the middle of a message, never after a space at the start, never for //
    for (const typed of ['hello /', ' /', '//', 'a\n/']) {
      await input.fill('');
      await input.pressSequentially(typed.replace('\n', ''));
      await expect(list).toBeHidden();
    }
    await input.fill('');
    await input.pressSequentially('line one');
    await page.keyboard.press('Shift+Enter');
    await input.pressSequentially('/');
    await expect(list).toBeHidden();
    await input.fill('');
  } finally {
    await context.close();
  }
});

test('/ask picks a bot from the menu and posts a message that mentions it; a wrong bot is explained and nothing is posted', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const input = box(page);
    await input.click();
    await input.pressSequentially('/ask ');
    const list = menu(page);
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option').first()).toContainText('coder');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('/ask coder ');
    await input.pressSequentially('how do I run the tests?');
    await expect(list).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('message').filter({ hasText: 'how do I run the tests?' })).toHaveCount(1);
    expect(await bodies(dev)).toContain('@coder how do I run the tests?');

    // a bot the team does not have: one plain sentence, the text stays, nothing is posted
    await input.pressSequentially('/ask nobody hello there');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('slash-notice')).toContainText('There is no bot called “nobody” in this team. Bots here: coder.');
    await expect(input).toHaveValue('/ask nobody hello there');
    expect(await bodies(dev)).not.toContain('@nobody hello there');

    // no question
    await input.fill('/ask coder');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('slash-notice')).toContainText('Add your question after the bot’s name');
    // typing again clears the sentence
    await input.pressSequentially(' ');
    await expect(page.getByTestId('slash-notice')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('/task makes a card on the channel board and links to it; in a thread it says where it came from', async ({ browser, playwright }) => {
  const root = await postAs(omar, dev, 'Deploy plan for slash-command week');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const input = box(page);
    await input.click();
    await input.pressSequentially('/task Fix the login redirect');
    await page.keyboard.press('Enter');
    const notice = page.getByTestId('slash-notice');
    await expect(notice).toContainText('Card created: “Fix the login redirect”.');
    await expect(input).toHaveValue('');
    // nothing was posted as a message
    expect(await bodies(dev)).not.toContain('/task Fix the login redirect');

    const boards = await omar.get<{ items: Array<{ id: string; name: string; channelId: string | null }> }>(`/api/channels/${dev}/boards`);
    const channelBoard = boards.items.find((b) => b.channelId === dev)!;
    expect(channelBoard).toBeTruthy();
    const tasks = await omar.get<{ items: Array<{ id: string; title: string; boardId: string | null; kind: string; description: string }> }>('/api/teams/engineering/tasks?limit=100');
    const card = tasks.items.find((t) => t.title === 'Fix the login redirect')!;
    expect(card).toMatchObject({ boardId: channelBoard.id, kind: 'other', description: 'Created from #dev with /task.' });

    await notice.getByTestId('slash-notice-link').click();
    await expect(page).toHaveURL(new RegExp(`/t/engineering/boards\\?board=${channelBoard.id}&card=${card.id}`));
    await expect(page.getByText('Fix the login redirect').first()).toBeVisible();

    // from a thread
    await page.goto(`/t/engineering/c/dev?panel=thread:${root.id}`);
    const reply = page.locator('[data-landmark="right-panel"]').getByRole('textbox', { name: 'Reply in thread' });
    await reply.fill('/task Write the migration note');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-landmark="right-panel"]').getByTestId('slash-notice')).toContainText('Card created: “Write the migration note”.');
    const after = await omar.get<{ items: Array<{ title: string; description: string }> }>('/api/teams/engineering/tasks?limit=100');
    expect(after.items.find((t) => t.title === 'Write the migration note')?.description).toBe('Created from a thread in #dev with /task.');
  } finally {
    await context.close();
  }
});

test('//ask posts a literal slash, an unknown /xyz is posted as typed, /shrug and /me post their lines', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const input = box(page);
    await input.click();
    for (const typed of ['//ask coder this is not a command', '/xyz stays exactly as typed']) {
      await input.pressSequentially(typed);
      await page.keyboard.press('Enter');
      await expect(input).toHaveValue('');
    }
    await expect(page.getByTestId('message').filter({ hasText: 'this is not a command' })).toHaveCount(1);
    await expect(page.getByTestId('message').filter({ hasText: 'stays exactly as typed' })).toHaveCount(1);
    const seen = await bodies(dev);
    expect(seen).toContain('/ask coder this is not a command');
    expect(seen).toContain('/xyz stays exactly as typed');
    // the bot was not mentioned by the escaped text
    expect(seen).not.toContain('@coder this is not a command');

    await input.pressSequentially('/shrug whatever');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('message').filter({ hasText: 'whatever' }).last()).toContainText('¯\\_(ツ)_/¯');
    await input.pressSequentially('/me is at lunch');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('message').filter({ hasText: 'is at lunch' }).last().locator('em')).toContainText(/^Omar.* is at lunch$/);
    const stored = await bodies(dev);
    expect(stored).toContain(`whatever ${SHRUG_STORED}`);
  } finally {
    await context.close();
  }
});

test('/help lists the commands in a dialog that Esc closes', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const input = box(page);
    await input.click();
    await input.pressSequentially('/help');
    // typed in full, the menu has nothing left to pick: Enter runs it
    await expect(menu(page).getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    const dlg = page.getByTestId('slash-help');
    await expect(dlg).toBeVisible();
    for (const usage of ['/ask <bot> <question>', '/task <title>', '/me <what you are doing>', '/shrug [message]', '/help']) {
      await expect(dlg.getByText(usage, { exact: true })).toBeVisible();
    }
    await expect(dlg).toContainText('//ask');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
  } finally {
    await context.close();
  }
});

test('a guest gets no message box, and the server refuses her a card', async ({ browser, playwright }) => {
  const releases = (await channelsOf(omar))['releases']!;
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/t/engineering/c/releases');
  try {
    await expect(page.getByTestId('read-only')).toHaveText('You can read this channel.');
    await expect(page.getByRole('textbox', { name: /Message/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const refused = await lena.status('POST', '/api/teams/engineering/tasks', { title: 'Guest card', branch: 'task/guest-card' });
  expect([403, 404]).toContain(refused);
  expect(await lena.status('POST', `/api/channels/${releases}/messages`, { channelId: releases, body: '@coder hello', threadRootId: null })).toBe(403);
});

test('on a 390 px phone the menu sits above the box, inside the screen, with rows a thumb can hit', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
  try {
    const input = box(page);
    await input.click();
    await input.pressSequentially('/');
    const list = menu(page);
    await expect(list).toBeVisible();
    const area = await list.boundingBox();
    const field = await input.boundingBox();
    expect(area).not.toBeNull();
    expect(field).not.toBeNull();
    expect(area!.y + area!.height).toBeLessThanOrEqual(field!.y + 1);
    expect(area!.x).toBeGreaterThanOrEqual(0);
    expect(area!.x + area!.width).toBeLessThanOrEqual(PHONE.width);
    for (const option of await list.getByRole('option').all()) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect(await noSidewaysScroll(page)).toBe(true);
    await list.getByRole('option').nth(1).tap();
    await expect(input).toHaveValue('/task ');
  } finally {
    await context.close();
  }
});
