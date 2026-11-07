import { expect, test } from '@playwright/test';
import { personas } from '../fixtures/seed.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { noSidewaysScroll } from '../support/stack-browser.ts';
import { STACK_ENV } from './support.ts';
import { apiOn, openPersonal, openSpaceOf, pickFile, rowAt, treeOf, uploadAs } from './personal-support.ts';

/*
 * P20-04 on the phone (the `mobile-web` project, 390x844): Personal is the first thing in the folder sheet, the list fits, the row menu does what the
 * hover buttons do on a desktop, a guest is told there is no Personal space, and the admin's read-only look has no upload and no sideways scroll.
 */
test.skip(({ isMobile }) => !isMobile, 'Runs on the mobile-web project');
test.describe.configure({ mode: 'serial' });

const PHONE = { viewport: { width: 390, height: 844 }, mobile: true } as const;

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Personal opens first; the folders are a sheet; upload, rename and delete work from the list and the row menu', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '', PHONE);
  try {
    // the tree is not on the page, the list is, and nothing scrolls sideways
    await expect(page.getByTestId('tree-node')).toHaveCount(0);
    await expect(page.locator('[data-testid="file-row"][data-kind="folder"]')).toHaveCount(7);
    expect(await noSidewaysScroll(page)).toBe(true);
    // at the top a file cannot be added: Upload waits for a folder
    await expect(page.getByTestId('upload')).toBeDisabled();

    // the sheet: Personal first, then the teams
    await page.getByTestId('browse-folders').click();
    const sheet = page.getByTestId('folder-sheet');
    await expect(sheet.locator('[data-testid="tree-root"]').first()).toHaveAttribute('data-root', 'personal');
    await expect(sheet.locator('[data-testid="tree-root"][data-root="team"]')).toHaveText(['Engineering']);
    await sheet.locator(`[data-testid="tree-node"][data-space="~me"][data-path="Notes"]`).click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/path=Notes/);

    // upload from the button
    await expect(page.getByTestId('upload')).toBeEnabled();
    await pickFile(page, { name: 'phone.md', mimeType: 'text/markdown', buffer: Buffer.from('From the phone\n') });
    await expect(rowAt(page, 'Notes/phone.md')).toBeVisible();
    await expect(page.getByTestId('quota-text')).toHaveText('15 B of 5.0 GB used');
    expect(await noSidewaysScroll(page)).toBe(true);

    // the row menu is the way to Rename (a touch screen has no hover)
    await rowAt(page, 'Notes/phone.md').getByTestId('row-menu').click();
    await page.getByTestId('row-action-rename').click();
    await page.getByTestId('dialog-rename').getByLabel('New name').fill('handset.md');
    await page.getByTestId('dialog-rename').getByRole('button', { name: 'Rename' }).click();
    await expect(rowAt(page, 'Notes/handset.md')).toBeVisible();
    expect((await treeOf(api, 'Notes')).map((e) => e.name)).toEqual(['handset.md']);

    // a dialog fits the screen, and Delete asks first
    await rowAt(page, 'Notes/handset.md').getByTestId('row-menu').click();
    await page.getByTestId('row-action-delete').click();
    const del = page.getByTestId('dialog-delete');
    await expect(del).toBeVisible();
    const box = await del.boundingBox();
    expect(box?.width ?? 999).toBeLessThanOrEqual(390);
    await del.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(rowAt(page, 'Notes/handset.md')).toHaveCount(0);
    expect(await treeOf(api, 'Notes')).toEqual([]);

    // ticking with the Select button, then the bar
    await uploadAs(api, 'Notes', 'one.md', '1');
    await uploadAs(api, 'Notes', 'two.md', '2');
    await page.reload();
    await page.getByTestId('select-mode').click();
    await rowAt(page, 'Notes/one.md').getByTestId('row-check').click();
    await rowAt(page, 'Notes/two.md').getByTestId('row-check').click();
    await expect(page.getByTestId('selection-bar')).toContainText('2 selected');
    await expect(page.getByTestId('selection-move')).toBeVisible();
    await expect(page.getByTestId('selection-delete')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('selection-clear').click();
    await page.getByTestId('select-mode').click();
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a guest on the phone is told there is no Personal space', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'lena', '', PHONE);
  try {
    await expect(page.getByTestId('files-no-personal')).toContainText('Personal files are not available here.');
    await expect(page.getByTestId('upload')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
  }
});

test('an admin who has opened a space reads it on the phone: the note fits, there is no upload and nothing to change', async ({ browser, playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  await uploadAs(nadia, 'Notes', 'handover.md', '# Handover\n');
  await nadia.ctx.dispose();
  const omar = await apiOn(playwright, stack, 'omar');
  expect((await openSpaceOf(omar, personas.nadia.personId, 'Checking the handover notes while Nadia is away')).status).toBe(200);
  await omar.ctx.dispose();

  const { page, close } = await openPersonal(browser, playwright, stack, 'omar', '?path=Notes', { ...PHONE, path: `/files/person/${personas.nadia.personId}` });
  try {
    await expect(page.getByTestId('admin-view-note')).toContainText('You are reading Nadia');
    await expect(page.getByTestId('admin-view-note')).toContainText('It is read-only');
    await expect(rowAt(page, 'Notes/handover.md')).toBeVisible();
    await expect(page.getByTestId('upload')).toHaveCount(0);
    await expect(page.getByTestId('files-actions')).toHaveCount(0);
    await expect(page.getByTestId('quota')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
    // the row menu has Download and nothing that changes the file
    await rowAt(page, 'Notes/handover.md').getByTestId('row-menu').click();
    await expect(page.getByTestId('row-action-download')).toBeVisible();
    for (const id of ['rename', 'move', 'delete', 'share']) await expect(page.getByTestId(`row-action-${id}`)).toHaveCount(0);
    await page.keyboard.press('Escape');
    // the way out
    await expect(page.getByTestId('admin-view-close')).toHaveAttribute('href', '/settings/workspace/members');
  } finally {
    await close();
  }
});
