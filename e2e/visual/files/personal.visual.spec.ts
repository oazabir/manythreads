import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, uploadAs } from '../../files/personal-support.ts';
import { noSidewaysScroll } from '../../support/stack-browser.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Personal files (P20-04, own baselines, class W): the top of Personal with its seven folders and the Teams branch, a folder in the list view and in the
 * grid view, a row's right-click menu, and the same on a phone (390x844). personal-top.png, personal-list.png, personal-grid.png, personal-menu.png,
 * personal-list-390.png, personal-grid-390.png, personal-folders-390.png. Times and names of people carry data-vt-mask; the sort is by name so the order
 * does not depend on when the files were made.
 */
const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../../fixtures/files/${name}`, import.meta.url)));
const ORDER = [['team-switch', 'search', 'sidebar'], ['header', 'tree', 'list']];

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const api = await apiOn(playwright, stack, 'nadia');
  await uploadAs(api, 'Notes', 'launch-plan.md', fixture('page.md'));
  await uploadAs(api, 'Notes', 'signups.csv', fixture('signups.csv'), { type: 'text/csv' });
  await uploadAs(api, 'Notes', 'screenshot.png', fixture('sample.png'), { type: 'image/png' });
  await uploadAs(api, 'Meetings', 'standup.md', Buffer.from('# Standup\n\nNothing blocked.\n'));
  await api.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Sorted by name, ascending (the browser is new, so the first look is newest first). */
async function sortByName(page: Page, phone = false): Promise<void> {
  if (phone) await page.getByTestId('sort-select').selectOption('name:asc');
  else {
    await page.getByTestId('sort-name').click();
    await expect(page.getByTestId('sort-name').locator('xpath=ancestor::*[@role="columnheader"]')).toHaveAttribute('aria-sort', 'ascending');
  }
}

test('the top of Personal and a folder with files keep their layout (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/files');
    await expect(page.locator('[data-testid="file-row"][data-kind="folder"]')).toHaveCount(7);
    await expect(page.locator('[data-testid="tree-root"][data-root="personal"]')).toBeVisible();
    await expect(page.getByTestId('tree-teams')).toBeVisible();
    await expectWireframe(page, 'personal-top', ORDER);

    await page.goto('/files?path=Notes');
    await expect(page.getByTestId('file-row')).toHaveCount(3);
    await expect(page.getByTestId('quota-text')).toBeVisible();
    await sortByName(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expectWireframe(page, 'personal-list', ORDER);
  } finally {
    await close();
  }
});

test('the grid view keeps its layout (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/files?path=Notes');
    await expect(page.getByTestId('file-row')).toHaveCount(3);
    await page.getByTestId('sort-select').selectOption('name:asc');
    await page.getByTestId('view-grid').click();
    await expect(page.locator('.fgrid')).toBeVisible();
    // the picture is the card's thumbnail: wait for it, so the plate does not catch it half drawn
    await expect(page.locator('.fgrid img')).toHaveJSProperty('complete', true);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expectWireframe(page, 'personal-grid', ORDER);
  } finally {
    await close();
  }
});

test('the right-click menu of a row keeps its layout (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/files?path=Notes');
    await expect(page.getByTestId('file-row')).toHaveCount(3);
    await sortByName(page);
    await page.locator('[data-testid="file-row"][data-path="Notes/launch-plan.md"]').click({ button: 'right', position: { x: 240, y: 12 } });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(7);
    await expectWireframe(page, 'personal-menu', ORDER);
  } finally {
    await close();
  }
});

test('on a phone: the list, the grid and the folder sheet with Personal first keep their layout (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', MOBILE, true);
  try {
    await page.goto('/files?path=Notes');
    await expect(page.getByTestId('file-row')).toHaveCount(3);
    await expect(page.getByTestId('tree-node')).toHaveCount(0);
    await sortByName(page, true);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectWireframe(page, 'personal-list-390', [['header', 'list']]);

    await page.getByTestId('view-grid').click();
    await expect(page.locator('.fgrid')).toBeVisible();
    await expect(page.locator('.fgrid img')).toHaveJSProperty('complete', true);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectWireframe(page, 'personal-grid-390', [['header', 'list']]);

    await page.getByTestId('view-list').click();
    await page.getByTestId('browse-folders').click();
    const sheet = page.getByTestId('folder-sheet');
    await expect(sheet.locator('[data-testid="tree-root"]').first()).toHaveAttribute('data-root', 'personal');
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectWireframe(page, 'personal-folders-390', [['header', 'list']]);
  } finally {
    await close();
  }
});
