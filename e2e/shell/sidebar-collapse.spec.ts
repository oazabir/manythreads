import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * P21-08, the sidebar's folds and shortcuts, on a stack of its own (it posts direct messages and folds sections): Direct messages folds to the
 * rows that need the person, the fold is kept per team, the row menu mutes and reads, Alt+1..9 jumps to a team unless the person is typing, and
 * the setup card folds to one line and stays folded.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let priya: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  priya = await apiOn(playwright, stack, 'priya');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), priya?.ctx.dispose()]);
  await stack?.stop();
});

const personId = async (api: StackApi): Promise<string> => (await api.get<{ person: { id: string } }>('/api/session')).person.id;
const dmWith = async (from: StackApi, to: StackApi): Promise<string> => (await from.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [await personId(to)] })).dm.channel.id;
const sidebar = (page: Page) => page.locator('[data-landmark="sidebar"]');
const dmRow = (page: Page, id: string) => sidebar(page).locator(`a.it[href$="/dm/${id}"]`);
const fold = (page: Page, label: string) => sidebar(page).getByRole('button', { name: new RegExp(`^${label}, (open|folded)$`) });

test('Direct messages folds to the rows that need the person; the fold is kept per team and survives a reload', async ({ browser, playwright }) => {
  const a = await dmWith(omar, priya);
  const b = await dmWith(nadia, priya);
  await postAs(omar, a, 'first');
  await postAs(nadia, b, 'second');
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads');
  try {
    await expect(dmRow(page, a)).toBeVisible();
    await expect(dmRow(page, b)).toBeVisible();
    const toggle = fold(page, 'Direct messages');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // read one of them, go back to the list, then fold: the read one goes, the unread one stays
    await dmRow(page, a).click();
    await expect(page).toHaveURL(new RegExp(`/dm/${a}$`));
    // wait until it is read for real (the badge goes) before the reload, or the page would come back with it still unread
    await expect(dmRow(page, a).locator('.pill')).toHaveCount(0);
    await page.goto('/t/engineering/threads');
    await expect(dmRow(page, a)).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(dmRow(page, a)).toHaveCount(0);
    await expect(dmRow(page, b)).toBeVisible();

    // the open conversation stays in view even though it is read
    await page.goto(`/t/engineering/dm/${a}`);
    await expect(dmRow(page, a)).toBeVisible();

    // kept: a reload comes back folded; another team of the same person has its own fold
    await page.goto('/t/engineering/threads');
    await expect(fold(page, 'Direct messages')).toHaveAttribute('aria-expanded', 'false');
    await expect(dmRow(page, a)).toHaveCount(0);
    await page.goto('/t/marketing/threads');
    await expect(fold(page, 'Direct messages')).toHaveAttribute('aria-expanded', 'true');

    // open it again in the first team
    await page.goto('/t/engineering/threads');
    await fold(page, 'Direct messages').click();
    await expect(dmRow(page, a)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the row menu of a direct message mutes, reads and has no Leave', async ({ browser, playwright }) => {
  const dm = await dmWith(nadia, priya);
  await postAs(nadia, dm, 'one more');
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads');
  try {
    const row = dmRow(page, dm);
    await expect(row.locator('.pill')).toBeVisible();
    await expect(row.locator('.pill')).toHaveClass(/\bmention\b/);
    const more = sidebar(page).locator('.sb-row', { has: row }).getByTestId('dm-row-menu');
    await more.click();
    const menu = page.getByRole('menu', { name: /^Options for / });
    await expect(menu.getByRole('menuitem')).toHaveText(['Mute', 'Mark read']);
    await expect(menu.getByTestId('row-menu-leave')).toHaveCount(0);

    await menu.getByRole('menuitem', { name: 'Mute' }).click();
    await expect(page.getByTestId('row-menu-note')).toContainText('is muted');
    await expect(row).toHaveClass(/\bmuted\b/);
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Unmute' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Mark read' }).click();
    await expect(row.locator('.pill')).toHaveCount(0);

    await more.click();
    await page.getByRole('menuitem', { name: 'Unmute' }).click();
    await expect(row).not.toHaveClass(/\bmuted\b/);
  } finally {
    await context.close();
  }
});

test('a channel row menu lists Star, Mute, Mark read and Leave channel', async ({ browser, playwright }) => {
  const made = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'row-menu-room' });
  expect(made.channel.id).toBeTruthy();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    const row = sidebar(page).locator('a.it[href$="/c/row-menu-room"]');
    await expect(row).toBeVisible();
    await sidebar(page).locator('.sb-row', { has: row }).getByTestId('channel-row-menu').click();
    const menu = page.getByRole('menu', { name: 'Options for #row-menu-room' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Star channel', 'Mute', 'Mark read', 'Leave channel']);
  } finally {
    await context.close();
  }
});

test('Alt+1 and Alt+2 jump to the first and second team, but not while typing', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await sidebar(page).getByRole('link', { name: /Threads/ }).first().waitFor();
    // the team menu says which team each key reaches (Priya is on two teams in the content seed)
    await page.locator('.team-wrap .team').click();
    const items = page.getByRole('menu', { name: 'Teams' }).getByRole('menuitemradio');
    await expect(items.nth(1)).toBeVisible();
    const slugs = await items.evaluateAll((els) => els.map((e) => (e.getAttribute('href') ?? '').split('/')[2] ?? ''));
    await expect(items.nth(0).locator('kbd')).toHaveText('Alt+1');
    await expect(items.nth(1).locator('kbd')).toHaveText('Alt+2');
    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const [first, second] = slugs as [string, string];
    expect(first).not.toBe(second);

    await page.keyboard.press('Alt+Digit1');
    await expect(page).toHaveURL(new RegExp(`/t/${first}/threads`));
    await page.keyboard.press('Alt+Digit2');
    await expect(page).toHaveURL(new RegExp(`/t/${second}/threads`));

    // typing in the search box: the key is the person's, not the shortcut's
    await page.locator('[data-landmark="search"]').getByRole('searchbox').focus();
    await page.keyboard.press('Alt+Digit1');
    await expect(page).toHaveURL(new RegExp(`/t/${second}/`));
    // Alt+9 with fewer teams does nothing
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+Digit9');
    await expect(page).toHaveURL(new RegExp(`/t/${second}/`));
    // and the shortcut is still alive once the focus is out of the box
    await page.keyboard.press('Alt+Digit1');
    await expect(page).toHaveURL(new RegExp(`/t/${first}/`));
  } finally {
    await context.close();
  }
});

test('the setup card folds to one line, and stays folded after a reload', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect(sidebar(page).getByRole('link', { name: /Threads/ }).first()).toBeVisible();
    const card = page.locator('[data-landmark="setup-checklist"]');
    test.skip((await card.count()) === 0, 'setup already put away on this stack');
    await expect(card.locator('.ob-bar')).toBeVisible();
    await card.getByRole('button', { name: 'Fold the setup steps' }).click();
    await expect(card.locator('.ob-bar')).toHaveCount(0);
    await expect(card.getByTestId('setup-card-count')).toBeVisible();
    await page.reload();
    await expect(card.getByRole('button', { name: 'Show the setup steps' })).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.ob-bar')).toHaveCount(0);
    await card.getByRole('button', { name: 'Show the setup steps' }).click();
    await expect(card.locator('.ob-bar')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the channel section says Add channel and the direct messages button says New message', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('new-channel')).toContainText('Add channel');
    await expect(sidebar(page).getByRole('button', { name: 'New message', exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
