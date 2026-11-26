import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn, PHONE } from '../support/stack-browser.ts';

/**
 * The sidebar's "New" menu (PLAN P38-07), on a stack of its own. Omar leads Engineering, so he is offered every row, the likeliest first;
 * picking a row goes to the screen that makes the thing and starts its journey by itself (the composer takes focus, the dialog opens),
 * with the one-shot `?new=` request taken out of the address. Nadia is a plain member and is not offered the lead-only rows.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const items = (page: import('@playwright/test').Page) => page.getByTestId('new-menu').getByRole('menuitem');

test('the menu lists the likeliest things first and a bot chat opens with the cursor in the composer', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the desktop sidebar; the phone drawer is the next test');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    const button = page.getByTestId('new-menu-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(items(page).nth(0)).toContainText('New chat with a bot');
    await expect(items(page).nth(1)).toContainText('Message a person');
    await expect(items(page).nth(2)).toContainText('New channel');
    await expect(items(page).first()).toBeFocused();

    // Esc closes it and puts focus back on the button
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('new-menu')).toBeHidden();
    await expect(button).toBeFocused();

    await button.click();
    await page.getByRole('menuitem', { name: /New chat with a bot/ }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/chat$/);
    await expect(page.locator('[data-testid="chat-main"] textarea')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('a new team file opens the New page dialog, and a new channel opens its dialog where the person is', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the desktop sidebar');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await page.getByTestId('new-menu-button').click();
    await page.getByRole('menuitem', { name: /New team file/ }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/files$/);
    await expect(page.getByTestId('dialog-new-file')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.getByTestId('new-menu-button').click();
    await page.getByRole('menuitem', { name: /New channel/ }).click();
    await expect(page.getByTestId('new-channel-dialog')).toBeVisible();
    await expect(page.getByTestId('new-channel-name')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('a plain member is not offered the lead-only rows', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the desktop sidebar');
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await page.getByTestId('new-menu-button').click();
    await expect(items(page).first()).toContainText('New chat with a bot');
    for (const name of ['New channel', 'New board', 'New job', 'New project']) await expect(page.getByRole('menuitem', { name: new RegExp(name) })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('on a phone the button is in the drawer and the menu fits the screen', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads', { viewport: PHONE, mobile: true });
  try {
    await page.getByRole('button', { name: 'Open menu' }).click();
    const button = page.getByTestId('new-menu-button');
    await expect(button).toBeVisible();
    await button.click();
    const menu = page.getByTestId('new-menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= PHONE.width).toBe(true);
  } finally {
    await context.close();
  }
});
