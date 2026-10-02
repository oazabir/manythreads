import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { noSidewaysScroll } from '../../support/stack-browser.ts';
import { MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Files on a phone (PLAN phase 4 section 2, own baselines, class W), 390x844: the tree is a breadcrumb that opens a sheet of folders, the list
 * has one line per file, and a file's preview fills the screen. files-390.png, folders-390.png, preview-390.png; no sideways scroll in any of them.
 */
let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the list, the folder sheet and the preview keep the phone layout (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', MOBILE, true);
  try {
    await page.goto('/t/engineering/files?path=pages/reports');
    await expect(page.getByTestId('file-row').first()).toBeVisible();
    await expect(page.getByTestId('tree-node')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectWireframe(page, 'files-390', [['header', 'list']]);

    // the breadcrumb's button opens the folders as a sheet; a folder in it opens and closes the sheet
    await page.getByTestId('browse-folders').click();
    const sheet = page.getByTestId('folder-sheet');
    await expect(sheet.getByTestId('tree-node').first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectWireframe(page, 'folders-390', [['header', 'list']]);
    await sheet.locator('[data-testid="tree-node"][data-path="memory"]').click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/path=memory/);

    // a file's preview is the whole screen
    await page.goto('/t/engineering/files?path=pages/reports');
    await page.locator('[data-testid="file-row"][data-path="pages/reports/signups.csv"]').click();
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel.getByTestId('viewer-csv')).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.width).toBe(MOBILE.width);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectWireframe(page, 'preview-390', [['panel-header', 'panel-body']]);
  } finally {
    await close();
  }
});
