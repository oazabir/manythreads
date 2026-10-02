import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { DESKTOP, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The CSV viewer of the PLAN's wireframe (own baseline, class W): `pages/reports/signups.csv` in the right panel of Files, a cell being edited,
 * the "Saving creates a commit by Nadia" line under the grid. 1440x900: csv-editing.png. The tree and the list beside it are the screen's own.
 */
let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewport');
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the CSV viewer with a cell being edited matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=pages/reports&panel=file:pages/reports/signups.csv');
    const csv = page.locator('[data-landmark="right-panel"]').getByTestId('viewer-csv');
    await expect(csv.getByTestId('csv-cell')).toHaveCount(15);
    const cell = csv.getByLabel('Row 3, column B');
    await cell.fill('460');
    await expect(csv).toHaveAttribute('data-dirty', 'true');
    // the cursor is not part of the picture
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expectWireframe(page, 'csv-editing', [['team-switch', 'search', 'sidebar'], ['header', 'tree', 'list', 'right-panel']]);
  } finally {
    await close();
  }
});
