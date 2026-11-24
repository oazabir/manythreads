import { expect, type Locator, type Page } from '@playwright/test';

/*
 * The composer's Attach menu (P36-09): the box shows only Attach, Voice message and Send; a file, a screenshot, a screen recording, a poll, emoji, Send later
 * and the formatting bar are items of Attach's menu. Every helper acts inside one composer (its `[data-testid="composer"]` element), never on the whole
 * page: a channel with its thread panel open shows two composers. `mainComposer(page)` is the conversation's own box; a thread's is
 * `thread.getByTestId('composer')`.
 */

/** The conversation's own composer (a channel, a direct message), not the reply box of an open thread. */
export const mainComposer = (page: Page): Locator => page.locator('[data-testid="composer"][data-landmark="composer"]');

/** Opens the Attach menu of `composer` and returns the menu. */
export async function openAttach(composer: Locator): Promise<Locator> {
  const menu = composer.getByTestId('composer-attach-menu');
  if (await menu.isVisible()) return menu;
  await composer.getByTestId('composer-attach').click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Chooses one item of the Attach menu of `composer` by its test id (`send-later`, `poll-tool`, `attach-emoji`, `capture-image`…). */
export async function chooseAttach(composer: Locator, testId: string): Promise<void> {
  const menu = await openAttach(composer);
  await menu.getByTestId(testId).click();
}

/** Shows the formatting bar of `composer` (it is hidden until asked for, and the choice is kept in the browser) and returns it. */
export async function showFormatting(composer: Locator): Promise<Locator> {
  const bar = composer.getByRole('toolbar', { name: 'Formatting' });
  if (await bar.isVisible()) return bar;
  await chooseAttach(composer, 'composer-format-toggle');
  await expect(bar).toBeVisible();
  return bar;
}
