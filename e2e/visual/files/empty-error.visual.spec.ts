import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { DESKTOP, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The plain states of Files (PLAN phase 4 section 5, own baselines, class W), 1440x900: an empty folder ("Nothing here yet."), the refusal of
 * a PNG offered to a git folder (the copy that says git holds text only), and a folder the person cannot read ("You do not have access").
 * empty-folder.png, binary-rejected.png, no-access.png.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'), Buffer.alloc(48)]);

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewport');
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const ORDER = [['team-switch', 'search', 'sidebar'], ['header', 'tree', 'list']];

test('an empty folder matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=channels/alerts');
    await expect(page.getByTestId('files-empty')).toContainText('Nothing here yet.');
    await expectWireframe(page, 'empty-folder', ORDER);
  } finally {
    await close();
  }
});

test('a PNG refused by a git folder matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=pages');
    await expect(page.getByTestId('file-row').first()).toBeVisible();
    // the files of a seeded repo were made within the same second: by name, the order is the same every run
    await page.getByRole('button', { name: 'Sort by name' }).click();
    await page.getByTestId('upload-input').setInputFiles({ name: 'latency-chart.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('upload-text-only')).toContainText('This folder is stored in git, which holds text only. Upload attachments to a channel folder.');
    await expectWireframe(page, 'binary-rejected', ORDER);
  } finally {
    await close();
  }
});

test('a folder the person cannot read matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'lena', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=channels/dev');
    await expect(page.getByTestId('files-denied')).toContainText('You do not have access');
    await expectWireframe(page, 'no-access', [['team-switch', 'search', 'sidebar'], ['header', 'content']]);
  } finally {
    await close();
  }
});
