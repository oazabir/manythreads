import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, noSidewaysScroll, openOn } from '../support/stack-browser.ts';
import { BOTS_STACK_ENV, rosterRow } from './support.ts';

/*
 * The bots screens on a 390 px touch screen (PLAN P21-17): the roster header's "More" menu, the bot page's header row and its "…" menu with the keys a menu owes, the sticky save
 * bar with the arrow's menu, and the tab strip that brings the linked group into view. Runs only on the mobile-web project: the desktop specs of this folder (roster, botmd-editor,
 * test-action) cover the wide layout, and nothing here saves, so the stack's bot is the same for every test.
 */
test.skip(({ isMobile }) => !isMobile, 'phone layout');

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

const LAYOUT = { viewport: PHONE, mobile: true } as const;

/** The box of `el`, which must lie inside the screen. */
async function insideScreen(el: Locator, what: string): Promise<void> {
  const box = await el.boundingBox();
  expect(box, what).not.toBeNull();
  expect(box!.x, `${what} starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} ends on the screen`).toBeLessThanOrEqual(PHONE.width);
  expect(box!.y, `${what} is not above the screen`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${what} is not below the screen`).toBeLessThanOrEqual(PHONE.height);
}

/** The menu items in a menu, in order: the first one has the focus on opening, and the keys move it. */
async function expectMenuKeys(page: Page, menu: Locator): Promise<void> {
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
}

test('the roster keeps Add a bot in the header and puts Recipes, Proposals and Agents behind a More menu', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots', LAYOUT);
  try {
    await expect(rosterRow(page, 'coder')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('roster-add-bot')).toBeVisible();
    // the three secondary links are not on the header on a phone
    await expect(page.locator('a[data-testid="roster-recipes"]')).toHaveCount(0);
    const more = page.getByTestId('roster-more');
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await insideScreen(more, 'the More button');
    await insideScreen(page.getByTestId('roster-add-bot'), 'Add a bot');
    expect(await noSidewaysScroll(page)).toBe(true);

    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: 'More', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Browse recipes', /^Proposals/, 'Agents']);
    await insideScreen(menu, 'the menu');
    await expectMenuKeys(page, menu);

    // Esc closes it and the button has the focus back
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeFocused();

    // a choice goes there, and the menu is gone on the other side
    await more.click();
    await page.getByTestId('roster-agents').tap();
    await expect(page).toHaveURL(/\/t\/engineering\/agents$/);
    await expect(page.getByRole('menu', { name: 'More', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the bot page header keeps Talk, Deploy and the "…" button in one row, and the menu answers the keys', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/coder', LAYOUT);
  try {
    await expect(page.getByTestId('bot-page')).toBeVisible();
    const row = [page.getByTestId('open-conversation'), page.getByTestId('deploy-bot'), page.getByTestId('bot-more')];
    for (const el of row) await expect(el).toBeVisible();
    const tops = await Promise.all(row.map(async (el) => Math.round((await el.boundingBox())!.y)));
    expect(new Set(tops).size, `Talk, Deploy and the menu share one row: ${tops.join(', ')}`).toBe(1);
    for (const el of row) await insideScreen(el, 'a header button');
    for (const el of row) {
      const box = (await el.boundingBox())!;
      expect(Math.min(box.width, box.height), 'a header button is at least 44 px each way').toBeGreaterThanOrEqual(44);
    }
    expect(await noSidewaysScroll(page)).toBe(true);

    // the icon-only button is named for a screen reader
    const more = page.getByTestId('bot-more');
    await expect(more).toHaveAttribute('aria-label', 'More actions');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    const menu = page.getByRole('menu', { name: 'More actions', exact: true });
    await expect(menu).toBeVisible();
    for (const id of ['back-to-roster', 'open-in-files', 'bot-proposals', 'bot-usage', 'bot-change-picture']) await expect(menu.getByTestId(id)).toBeVisible();
    await insideScreen(menu, 'the menu');
    await expectMenuKeys(page, menu);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // a link in it closes the menu and goes
    await more.click();
    await menu.getByTestId('bot-proposals').tap();
    await expect(page).toHaveURL(/\/t\/engineering\/proposals$/);
  } finally {
    await context.close();
  }
});

test('the save bar fits the screen, leaves the focus in the field and opens its menu upward inside the screen', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/coder', LAYOUT);
  try {
    const role = page.getByTestId('bot-role');
    await expect(role).toBeVisible();
    await expect(page.getByTestId('bot-foot')).toHaveCount(0);
    await role.fill('A draft that is not saved');
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar).toBeVisible();
    await expect(role).toBeFocused();
    await expect.poll(async () => {
      const box = await bar.boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= PHONE.width && box.y + box.height <= PHONE.height && box.y + box.height >= PHONE.height - 40;
    }).toBe(true);
    expect(await noSidewaysScroll(page)).toBe(true);

    const arrow = bar.getByTestId('save-more');
    await expect(bar.getByTestId('save-bot')).toBeVisible();
    await arrow.tap();
    const menu = page.getByRole('menu', { name: 'More ways to save', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Save as proposal', 'Discard changes']);
    await insideScreen(menu, 'the save menu');
    await page.keyboard.press('Escape');
    await expect(arrow).toBeFocused();

    // Discard puts the saved value back and the bar goes
    await arrow.tap();
    await page.getByTestId('reset-bot').tap();
    await expect(page.getByTestId('bot-foot')).toHaveCount(0);
    await expect(role).not.toHaveValue('A draft that is not saved');
  } finally {
    await context.close();
  }
});

test('a link to a later group brings its tab into view; a link to a first section keeps the head and the tabs in sight', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/coder?tab=history', LAYOUT);
  try {
    const tabs = page.locator('[data-landmark="bot-tabs"]');
    await expect(page.getByTestId('tab-history')).toHaveAttribute('aria-selected', 'true');
    // the strip scrolls sideways, and the active tab is inside the screen after the link
    await expect.poll(async () => (await tabs.evaluate((el) => el.scrollWidth > el.clientWidth))).toBe(true);
    await expect.poll(async () => {
      const box = await page.getByTestId('tab-history').boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= PHONE.width;
    }).toBe(true);
    expect(await noSidewaysScroll(page)).toBe(true);

    await page.goto('/t/engineering/bots/coder?tab=identity');
    await expect(page.getByTestId('pane-identity')).toBeVisible();
    await expect(page.locator('[data-landmark="bot-head"]')).toBeInViewport();
    await expect(tabs).toBeInViewport();
  } finally {
    await context.close();
  }
});
