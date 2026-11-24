import { expect, type Locator, type Page } from '@playwright/test';

/*
 * The composer's Attach menu (P36-09): the box shows only Attach, Voice message and Send; a file, a screenshot, a screen recording, a poll, emoji, Send later
 * and the formatting bar are items of Attach's menu. `scope` is the page when it shows one composer, or the composer (or the panel) to act in.
 */

/** Opens the Attach menu of the composer in `scope` and returns the menu. */
export async function openAttach(scope: Page | Locator): Promise<Locator> {
  const menu = scope.getByTestId('composer-attach-menu');
  if (await menu.isVisible()) return menu;
  await scope.getByTestId('composer-attach').click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Chooses one item of the Attach menu by its test id (`send-later`, `poll-tool`, `attach-emoji`, `capture-image`…). */
export async function chooseAttach(scope: Page | Locator, testId: string): Promise<void> {
  const menu = await openAttach(scope);
  await menu.getByTestId(testId).click();
}

/** Shows the formatting bar of the composer in `scope` (it is hidden until asked for, and the choice is kept in the browser) and returns it. */
export async function showFormatting(scope: Page | Locator): Promise<Locator> {
  const bar = scope.getByRole('toolbar', { name: 'Formatting' });
  if (await bar.isVisible()) return bar;
  await chooseAttach(scope, 'composer-format-toggle');
  await expect(bar).toBeVisible();
  return bar;
}
