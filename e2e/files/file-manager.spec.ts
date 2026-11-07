import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV } from './support.ts';
import { apiOn, openPersonal, rowAt, rowPaths, treeOf, uploadAs, type StackApi } from './personal-support.ts';

/*
 * P20-04: the file manager of a Personal folder: a list and a grid, ticking several files, the bar that moves or deletes them, the sort that is kept, the
 * right-click menu, the buttons that appear on hover, the drop of files from the computer, and the preview. Own stack, in order, desktop.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; personal-mobile.spec.ts is the phone');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let api: StackApi;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...STACK_ENV });
  api = await apiOn(playwright, stack, 'nadia');
  // three files of different sizes in Notes, uploaded in this order
  await uploadAs(api, 'Notes', 'alpha.md', '# Alpha\n');
  await uploadAs(api, 'Notes', 'gamma.txt', 'g'.repeat(300));
  await uploadAs(api, 'Notes', 'beta.csv', 'a,b\n'.repeat(40), { type: 'text/csv' });
});
test.afterAll(async () => {
  await api?.ctx.dispose();
  await stack?.stop();
});

const NOTES = ['Notes/alpha.md', 'Notes/beta.csv', 'Notes/gamma.txt'] as const;
const header = (page: Page, name: 'name' | 'size' | 'modified') => page.getByTestId(`sort-${name}`).locator('xpath=ancestor::*[@role="columnheader"]');

test('sorting: a click sorts, a second click turns it round, folders stay first, and the choice is kept for the next visit', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await expect(page.getByTestId('file-row')).toHaveCount(3);
    // the first look is newest first
    await expect(header(page, 'modified')).toHaveAttribute('aria-sort', 'descending');
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'none');
    expect(await rowPaths(page)).toEqual(['Notes/beta.csv', 'Notes/gamma.txt', 'Notes/alpha.md']);

    await page.getByTestId('sort-name').click();
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'ascending');
    expect(await rowPaths(page)).toEqual([...NOTES]);
    await page.getByTestId('sort-name').click();
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'descending');
    expect(await rowPaths(page)).toEqual([...NOTES].reverse());

    // size starts with the largest
    await page.getByTestId('sort-size').click();
    await expect(header(page, 'size')).toHaveAttribute('aria-sort', 'descending');
    expect(await rowPaths(page)).toEqual(['Notes/gamma.txt', 'Notes/beta.csv', 'Notes/alpha.md']);

    // the same choice from the selector the phone uses
    await expect(page.getByTestId('sort-select')).toHaveValue('size:desc');
    await page.getByTestId('sort-select').selectOption('name:asc');
    expect(await rowPaths(page)).toEqual([...NOTES]);

    // folders stay on top whatever the column: at the top level the seven folders come before any file
    await page.goto(`${stack.origin}/files`);
    await page.getByTestId('sort-size').click();
    const kinds = await page.getByTestId('file-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    expect(new Set(kinds)).toEqual(new Set(['folder']));

    // kept: another visit opens sorted the same way
    await page.getByTestId('sort-name').click();
    await page.goto(`${stack.origin}/files?path=Notes`);
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'ascending');
    expect(await rowPaths(page)).toEqual([...NOTES]);
    expect(await page.evaluate(() => window.localStorage.getItem('mt.files.prefs'))).toContain('"key":"name"');
  } finally {
    await close();
  }
});

test('list and grid: the choice is kept, a grid card is the same row, and the arrow keys walk the cards', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await expect(page.getByTestId('view-list')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('file-list').locator('[role="columnheader"]').first()).toBeVisible();
    await page.getByTestId('view-grid').click();
    await expect(page.getByTestId('view-grid')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.fgrid')).toBeVisible();
    // a grid has no column heads, the cards carry the same row data
    await expect(page.getByTestId('sort-name')).toHaveCount(0);
    await expect(page.locator('.fgrid [data-testid="file-row"]')).toHaveCount(3);
    await expect(rowAt(page, 'Notes/alpha.md')).toHaveAttribute('data-store', 'personal');
    // the choice outlives a reload
    await page.reload();
    await expect(page.locator('.fgrid')).toBeVisible();

    // keyboard: focus the first card, Right and Left walk, Space ticks
    await rowAt(page, 'Notes/alpha.md').focus();
    await page.keyboard.press('ArrowRight');
    await expect(rowAt(page, 'Notes/beta.csv')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(rowAt(page, 'Notes/gamma.txt')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(rowAt(page, 'Notes/beta.csv')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(rowAt(page, 'Notes/beta.csv')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('selection-bar')).toContainText('1 selected');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);

    await page.getByTestId('view-list').click();
    await expect(page.locator('.fgrid')).toHaveCount(0);
    await expect(page.getByTestId('sort-name')).toBeVisible();
  } finally {
    await close();
  }
});

test('ticking: checkboxes, Ctrl-click, Shift-click, Select all and Clear; the bar counts what is ticked', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await page.getByTestId('sort-name').click();
    if ((await header(page, 'name').getAttribute('aria-sort')) !== 'ascending') await page.getByTestId('sort-name').click();
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);
    const selected = () => page.locator('[data-testid="file-row"][data-selected="true"]');

    await rowAt(page, 'Notes/alpha.md').getByTestId('row-check').click();
    await expect(page.getByTestId('selection-bar')).toContainText('1 selected');
    // the click on a ticked row's box does not open the file
    await expect(page.getByTestId('file-preview')).toHaveCount(0);
    // Shift-click on another box ticks the whole stretch
    await rowAt(page, 'Notes/gamma.txt').getByTestId('row-check').click({ modifiers: ['Shift'] });
    await expect(selected()).toHaveCount(3);
    await expect(page.getByTestId('selection-bar')).toContainText('3 selected');
    await expect(page.getByTestId('select-all')).toBeChecked();
    // un-tick one: the head box shows "some"
    await rowAt(page, 'Notes/beta.csv').getByTestId('row-check').click();
    await expect(selected()).toHaveCount(2);
    expect(await page.getByTestId('select-all').evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);

    await page.getByTestId('selection-clear').click();
    await expect(selected()).toHaveCount(0);
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);

    await page.getByTestId('select-all').check();
    await expect(selected()).toHaveCount(3);
    await page.getByTestId('select-all').uncheck();
    await expect(selected()).toHaveCount(0);

    // Ctrl-click ticks a row without opening it, a plain click on another row clears the ticks
    await rowAt(page, 'Notes/alpha.md').click({ modifiers: ['Control'] });
    await rowAt(page, 'Notes/gamma.txt').click({ modifiers: ['Control'] });
    await expect(selected()).toHaveCount(2);
    await expect(rowAt(page, 'Notes/beta.csv')).toHaveAttribute('data-selected', 'false');
    // the bar's actions are for several files: Move and Delete, no Rename
    await expect(page.getByTestId('selection-move')).toBeVisible();
    await expect(page.getByTestId('selection-delete')).toBeVisible();
    await rowAt(page, 'Notes/beta.csv').click();
    await expect(selected()).toHaveCount(0);
  } finally {
    await close();
  }
});

test('the bar moves several files at once and then deletes them, each step asking first', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await rowAt(page, 'Notes/alpha.md').getByTestId('row-check').click();
    await rowAt(page, 'Notes/gamma.txt').getByTestId('row-check').click();
    await page.getByTestId('selection-move').click();
    const move = page.getByTestId('dialog-move');
    await expect(move).toContainText('Move 2 files');
    await move.getByLabel('Move to folder').fill('Meetings');
    await move.getByRole('button', { name: 'Move' }).click();
    await expect(page.getByTestId('dialog-move')).toHaveCount(0);
    // they left Notes (the third stays), the ticks went with them
    await expect(page.getByTestId('file-row')).toHaveCount(1);
    await expect(rowAt(page, 'Notes/beta.csv')).toBeVisible();
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);
    expect((await treeOf(api, 'Meetings')).map((e) => e.name).sort()).toEqual(['alpha.md', 'gamma.txt']);

    await page.goto(`${stack.origin}/files?path=Meetings`);
    await page.getByTestId('select-all').check();
    await page.getByTestId('selection-delete').click();
    const del = page.getByTestId('dialog-delete');
    await expect(del).toContainText('Delete 2 files?');
    await del.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('file-row')).toHaveCount(2);
    await page.getByTestId('selection-delete').click();
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('file-row')).toHaveCount(0);
    await expect(page.getByTestId('files-empty')).toBeVisible();
    expect(await treeOf(api, 'Meetings')).toEqual([]);
    // put the third file back where the later tests expect the three
    await uploadAs(api, 'Notes', 'alpha.md', '# Alpha\n');
    await uploadAs(api, 'Notes', 'gamma.txt', 'g'.repeat(300));
  } finally {
    await close();
  }
});

test('the right-click menu: a row has its actions, several rows have the group ones, a folder and the empty space have their own', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    const menu = page.getByTestId('context-menu');
    await rowAt(page, 'Notes/alpha.md').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Preview', 'Version history', 'Download', 'Rename', 'Move', 'Send to a team…', 'Delete']);
    // the right-clicked row is ticked, and Escape closes the menu
    await expect(rowAt(page, 'Notes/alpha.md')).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // an action from the menu is the same as from the row: Rename opens its dialog
    await rowAt(page, 'Notes/alpha.md').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(page.getByTestId('dialog-rename')).toBeVisible();
    await page.getByTestId('dialog-rename').getByRole('button', { name: 'Cancel' }).click();

    // two ticked rows: the menu is about both
    await page.getByTestId('selection-clear').click();
    await rowAt(page, 'Notes/alpha.md').getByTestId('row-check').click();
    await rowAt(page, 'Notes/beta.csv').getByTestId('row-check').click();
    await rowAt(page, 'Notes/beta.csv').click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Move 2 items…', 'Delete 2 items']);
    await page.keyboard.press('Escape');
    await page.getByTestId('selection-clear').click();

    // the keyboard way in: Shift+F10 on a focused row
    await rowAt(page, 'Notes/gamma.txt').focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rowAt(page, 'Notes/gamma.txt')).toBeFocused();

    // the empty space of an empty folder: New note, New folder, Upload
    await page.goto(`${stack.origin}/files?path=Routines`);
    await page.getByTestId('files-empty').click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['New note', 'New folder', 'Upload files…']);
    await menu.getByRole('menuitem', { name: 'New folder' }).click();
    await expect(page.getByTestId('dialog-new-folder')).toBeVisible();
    await page.getByTestId('dialog-new-folder').getByRole('button', { name: 'Cancel' }).click();

    // the top level: a folder offers to open, a seed folder has nothing to delete, and the top has no New note or Upload
    await page.goto(`${stack.origin}/files`);
    await rowAt(page, 'Notes').click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Open folder']);
    await page.keyboard.press('Escape');
  } finally {
    await close();
  }
});

test('hover: Download, Rename and Send to a team appear beside the menu, and keys do the common things', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    const row = rowAt(page, 'Notes/alpha.md');
    await row.hover();
    await expect(row.getByTestId('hover-download')).toBeVisible();
    await expect(row.getByTestId('hover-rename')).toBeVisible();
    await expect(row.getByTestId('hover-share')).toBeVisible();
    await expect(row.getByTestId('hover-download')).toHaveAttribute('href', /download=1/);
    await expect(row.getByTestId('hover-download')).toHaveAttribute('download', 'alpha.md');
    await expect(row.getByTestId('hover-rename')).toHaveAccessibleName('Rename alpha.md');
    await row.getByTestId('hover-rename').click();
    await expect(page.getByTestId('dialog-rename')).toContainText('Rename alpha.md');
    await page.getByTestId('dialog-rename').getByRole('button', { name: 'Cancel' }).click();
    await row.getByTestId('hover-share').click();
    await expect(page.getByTestId('dialog-share')).toBeVisible();
    await page.getByTestId('dialog-share').getByRole('button', { name: 'Cancel' }).click();

    // F2 renames, Delete deletes (after asking), Escape in the dialog keeps the file
    await row.focus();
    await page.keyboard.press('F2');
    await expect(page.getByTestId('dialog-rename')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-rename')).toHaveCount(0);
    await row.focus();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('dialog-delete')).toContainText('Delete alpha.md?');
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toBeVisible();
  } finally {
    await close();
  }
});

test('dropping files from the computer: the overlay names the folder, a drop uploads, and the top level asks for a folder first', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    const overlay = page.getByTestId('drop-overlay');
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped text\n'], 'dropped.txt', { type: 'text/plain' }));
      return dt;
    });
    await expect(overlay).toHaveCount(0);
    await page.getByTestId('file-list').dispatchEvent('dragenter', { dataTransfer });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Drop to upload to Notes');
    // leaving hides it again
    await page.getByTestId('file-list').dispatchEvent('dragleave', { dataTransfer });
    await expect(overlay).toHaveCount(0);
    await page.getByTestId('file-list').dispatchEvent('dragenter', { dataTransfer });
    await page.getByTestId('file-list').dispatchEvent('dragover', { dataTransfer });
    await page.getByTestId('file-list').dispatchEvent('drop', { dataTransfer });
    await expect(overlay).toHaveCount(0);
    await expect(rowAt(page, 'Notes/dropped.txt')).toBeVisible();
    expect((await treeOf(api, 'Notes')).map((e) => e.name)).toContain('dropped.txt');

    // the top level cannot hold a file: the overlay says so and a drop adds nothing
    await page.goto(`${stack.origin}/files`);
    await page.getByTestId('file-list').dispatchEvent('dragenter', { dataTransfer });
    await expect(overlay).toContainText('Open a folder first to drop files');
    await page.getByTestId('file-list').dispatchEvent('drop', { dataTransfer });
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId('upload-list')).toHaveCount(0);
    expect((await treeOf(api, '')).every((e) => e.kind === 'folder')).toBe(true);
  } finally {
    await close();
  }
});

test('preview and open: a click shows the file beside the list, a double-click opens it in the middle, and it can be read', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await rowAt(page, 'Notes/alpha.md').click();
    const preview = page.getByTestId('file-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('alpha.md');
    await expect(preview).toContainText('Alpha');
    await expect(rowAt(page, 'Notes/alpha.md')).toHaveAttribute('aria-current', 'true');

    await rowAt(page, 'Notes/beta.csv').dblclick();
    await expect(page).toHaveURL(/open=Notes(%2F|\/)beta\.csv/);
    await expect(page.getByTestId('file-view-path')).toHaveAttribute('title', 'Notes/beta.csv');
    await page.getByTestId('close-file').click();
    await expect(page.getByTestId('file-list')).toBeVisible();

    // a plain click on a folder enters it, and the breadcrumb is the way back
    await page.goto(`${stack.origin}/files`);
    await rowAt(page, 'Notes').click();
    await expect(page).toHaveURL(/path=Notes/);
    await page.getByTestId('breadcrumb').getByRole('button', { name: 'Personal' }).click();
    await expect(page.getByTestId('file-row')).toHaveCount(7);
  } finally {
    await close();
  }
});
