import { expect, test, type Page } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

// the pointer and keyboard layout of the desktop; the phone gets its own test below, which opens its own 390 px window
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.use({ actionTimeout: 10_000 });

/**
 * PLAN P14-02, composer parity: the formatting toolbar writes the Markdown the message list reads, the emoji picker searches, remembers the
 * last ones and applies a skin tone, the Up arrow in an empty box edits your last message, and the reaction menu opens the same picker.
 */
const boxOf = (page: Page, name: string) => page.getByRole('textbox', { name: `Message #${name}` });

test('the toolbar: strike, quote, numbered list, link and a code block with a language', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { name } = await createChannel(omar, 'fmt');
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const box = boxOf(page, name);
    await expect(box).toBeVisible();
    const select = async (from: number, to: number): Promise<void> => {
      await box.evaluate((el: HTMLTextAreaElement, range: [number, number]) => el.setSelectionRange(range[0], range[1]), [from, to] as [number, number]);
    };
    const bar = page.getByRole('toolbar', { name: 'Formatting' });
    await box.click();
    await expect(bar).toBeVisible();

    await box.fill('word');
    await select(0, 4);
    await bar.getByRole('button', { name: 'Strikethrough' }).click();
    await expect(box).toHaveValue('~~word~~');
    await bar.getByRole('button', { name: 'Strikethrough' }).click(); // a second press takes the marks off again
    await expect(box).toHaveValue('word');

    await select(0, 4);
    await bar.getByRole('button', { name: 'Quote' }).click();
    await expect(box).toHaveValue('> word');
    await box.fill('one\ntwo');
    await select(0, 7);
    await bar.getByRole('button', { name: 'Numbered list' }).click();
    await expect(box).toHaveValue('1. one\n2. two');

    await box.fill('docs');
    await select(0, 4);
    await bar.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(box).toHaveValue('[docs](https://)');
    await expect(box.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).resolves.toBe('https://');

    await box.fill('x = 1');
    await select(0, 5);
    await bar.getByRole('combobox', { name: 'Insert a code block' }).selectOption({ label: 'TypeScript' });
    await expect(box).toHaveValue('```ts\nx = 1\n```');

    // what the toolbar writes is what the list draws
    await box.fill('~~gone~~ and **kept**\n\n> quoted\n\n1. first\n2. second');
    await box.press('Enter');
    const row = messages(page).first();
    await expect(row.locator('del')).toHaveText('gone');
    await expect(row.locator('blockquote')).toContainText('quoted');
    await expect(row.locator('ol > li')).toHaveCount(2);
  } finally {
    await context.close();
    await omar.ctx.dispose();
  }
});

test('the toolbar is one tab stop and the arrow keys move along it', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { name } = await createChannel(omar, 'tools');
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    await boxOf(page, name).click();
    const bar = page.getByRole('toolbar', { name: 'Formatting' });
    const tabbable = bar.locator('button.ctool:not([tabindex="-1"]), select.ctool:not([tabindex="-1"])');
    await expect(tabbable).toHaveCount(1);
    await bar.getByRole('button', { name: 'Bold' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(bar.getByRole('button', { name: 'Italic' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(bar.getByRole('button', { name: 'Emoji' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(bar.getByRole('button', { name: 'Bold' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(bar.getByRole('button', { name: 'Emoji' })).toBeFocused();
    await expect(tabbable).toHaveCount(1);
  } finally {
    await context.close();
    await omar.ctx.dispose();
  }
});

test('the emoji picker: search, pick with the keyboard, recent ones, a skin tone, Esc', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { name } = await createChannel(omar, 'emoji');
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const box = boxOf(page, name);
    await box.click();
    const open = page.getByRole('button', { name: 'Emoji', exact: true });
    await open.click();
    const picker = page.getByTestId('emoji-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('searchbox', { name: 'Search emoji' })).toBeFocused();
    await expect(picker.getByTestId('emoji-recent')).toHaveCount(0);

    // search by name, Down into the grid, Enter picks
    await page.keyboard.type('rocket');
    await expect(picker.getByTestId('emoji-results').getByRole('button')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(picker.getByRole('button', { name: 'rocket launch ship' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await expect(box).toHaveValue('🚀');
    await expect(box).toBeFocused();

    // the next time it opens, the rocket is among the recent ones
    await open.click();
    await expect(picker.getByTestId('emoji-recent').getByRole('button')).toHaveCount(1);
    await expect(picker.getByTestId('emoji-recent')).toContainText('🚀');

    // a skin tone is applied to the hands and kept for next time
    await picker.getByRole('radio', { name: 'Medium skin tone' }).click();
    await expect(picker.getByRole('radio', { name: 'Medium skin tone' })).toHaveAttribute('aria-checked', 'true');
    await picker.getByRole('searchbox').fill('thumbs up');
    await picker.getByRole('button', { name: /thumbs up/ }).click();
    await expect(box).toHaveValue('🚀👍\u{1F3FD}');
    await page.reload();
    await boxOf(page, name).click();
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Medium skin tone' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('emoji-recent').getByRole('button').first()).toContainText('👍\u{1F3FD}');

    // Esc closes the picker and gives the focus back to the box
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('emoji-picker')).toBeHidden();
    await expect(boxOf(page, name)).toBeFocused();
  } finally {
    await context.close();
    await omar.ctx.dispose();
  }
});

test('Up in an empty box edits your last message; a box with text keeps its own Up', async ({ browser }) => {
  const omar = await apiAs('omar');
  const rafiApi = await apiAs('rafi');
  const { id, name } = await createChannel(omar, 'upedit');
  await postMessage(rafiApi, id, 'first note');
  await postMessage(omar, id, 'omar speaks last');
  await postMessage(rafiApi, id, 'second note');
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const box = boxOf(page, name);
    await expect(messages(page)).toHaveCount(3);
    await box.click();
    await box.fill('typing');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0);
    await box.fill('');
    await page.keyboard.press('ArrowUp');
    const editor = page.getByRole('textbox', { name: 'Edit message' });
    await expect(editor).toHaveValue('second note');
    await editor.fill('second note, corrected');
    await editor.press('Enter');
    await expect(messages(page).last()).toContainText('second note, corrected');
    await expect(messages(page).last()).toContainText('edited');
  } finally {
    await context.close();
    await omar.ctx.dispose();
    await rafiApi.ctx.dispose();
  }
});

test('the reaction menu opens the same picker', async ({ browser }) => {
  const omar = await apiAs('omar');
  const rafiApi = await apiAs('rafi');
  const { id, name } = await createChannel(omar, 'react');
  await postMessage(omar, id, 'ship it');
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const row = messages(page).first();
    await row.hover();
    await row.getByRole('button', { name: 'Add reaction' }).click();
    await row.getByRole('menuitem', { name: 'More emoji' }).click();
    const picker = row.getByTestId('emoji-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('searchbox').fill('rocket');
    await picker.getByRole('button', { name: 'rocket launch ship' }).click();
    await expect(row.getByRole('button', { name: /^🚀 1/ })).toBeVisible();
  } finally {
    await context.close();
    await omar.ctx.dispose();
    await rafiApi.ctx.dispose();
  }
});

test('on a phone the toolbar scrolls inside the composer and the picker stays on screen', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { name } = await createChannel(omar, 'phone');
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${name}`, { width: 390, height: 844 }, true);
  try {
    const box = boxOf(page, name);
    await expect(box).toBeVisible();
    await box.click();
    const bar = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(bar).toBeVisible();
    const noSideScroll = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noSideScroll()).toBe(true);
    const barBox = await bar.boundingBox();
    const composerBox = await page.getByTestId('composer').boundingBox();
    expect(barBox && composerBox && barBox.x >= composerBox.x - 1 && barBox.x + barBox.width <= composerBox.x + composerBox.width + 1).toBe(true);
    expect(barBox?.height ?? 99).toBeLessThan(40); // one row, not wrapped into a second

    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    const picker = page.getByTestId('emoji-picker');
    await expect(picker).toBeVisible();
    const p = await picker.boundingBox();
    expect(p && p.x >= 0 && p.x + p.width <= 390 && p.y >= 0).toBe(true);
    expect(await noSideScroll()).toBe(true);
    await expect(page.locator('[data-landmark="header"]').first()).toBeVisible(); // the header is still there
  } finally {
    await context.close();
    await omar.ctx.dispose();
  }
});
