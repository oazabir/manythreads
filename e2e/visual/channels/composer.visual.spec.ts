import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The composer with attachments (PLAN phase 3 section 5, own baselines, class W; wireframe "Composer with attachments"): the markdown
 * toolbar, a typed message, one file uploaded and one refused as "Too large (50 MB)", the clip and Send. 1440x900 and 390x844:
 * composer-1440.png, composer-390.png. Times and counts are masked.
 */
let stack: Stack;
let files: { pdf: string; big: string };
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewports');
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
  const dir = mkdtempSync(join(tmpdir(), 'mt-composer-'));
  files = { pdf: join(dir, 'incident-review.pdf'), big: join(dir, 'big.zip') };
  writeFileSync(files.pdf, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2_200_000, 0x20)]));
  writeFileSync(files.big, Buffer.alloc(51 * 1024 * 1024)); // over the 50 MB limit: refused before a byte is sent
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const [name, viewport, mobile] of [
  ['composer-1440', DESKTOP, false],
  ['composer-390', MOBILE, true],
] as const) {
  test(`${name} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'priya', viewport, mobile);
    try {
      await page.goto('/t/engineering/c/dev');
      await expect(page.getByTestId('message').first()).toBeVisible();
      await page.locator('input[type=file]').first().setInputFiles([files.pdf, files.big]);
      await expect(page.locator('[data-testid="upload"][data-status="done"]')).toHaveCount(1, { timeout: 20_000 });
      await expect(page.locator('[data-testid="upload"][data-status="error"]')).toHaveCount(1);
      await page.getByRole('textbox', { name: 'Message #dev' }).fill('Notes from the incident review. Please check the timeline.');
      await expectWireframe(page, name, mobile ? [['header', 'content']] : [['search', 'sidebar'], ['header', 'content']]);
    } finally {
      await close();
    }
  });
}
