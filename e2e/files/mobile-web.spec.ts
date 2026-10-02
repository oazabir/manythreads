import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, noSidewaysScroll } from '../support/stack-browser.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STACK_ENV, apiOn, openFiles } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/mobile-web.spec.ts` (the `mobile-web` project, 390x844): the list, a page and a PDF open without sideways scroll,
 * the tree is a breadcrumb that opens a sheet, and a preview fills the screen.
 */
test.skip(({ isMobile }) => !isMobile, 'Runs on the mobile-web project');

let stack: Stack;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...STACK_ENV });
  const api = await apiOn(playwright, stack, 'nadia');
  const dev = (await channelsOf(api))['dev'];
  const res = await api.ctx.post(`/api/channels/${dev}/files`, {
    headers: { ...(await api.headers()), 'content-type': 'application/pdf', 'x-file-name': 'handbook.pdf' },
    data: readFileSync(fileURLToPath(new URL('../fixtures/files/sample.pdf', import.meta.url))),
  });
  expect(res.status()).toBe(201);
  await api.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the list, a page and a PDF fit the phone; the tree is a sheet behind the breadcrumb', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages', { viewport: { width: 390, height: 844 }, mobile: true });
  try {
    await expect(page.getByTestId('file-row').first()).toBeVisible();
    await expect(page.getByTestId('tree-node')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);

    // the folders are a sheet
    await page.getByTestId('browse-folders').click();
    const sheet = page.getByTestId('folder-sheet');
    await sheet.locator('[data-testid="tree-node"][data-path="channels"]').getByTestId('tree-caret').click();
    await sheet.locator('[data-testid="tree-node"][data-path="channels/dev"]').click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/path=channels%2Fdev/);
    expect(await noSidewaysScroll(page)).toBe(true);

    // a PDF fills the screen
    await page.locator('[data-testid="file-row"][data-path="channels/dev/handbook.pdf"]').click();
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel.getByTestId('pdf-canvas')).toHaveAttribute('data-rendered', '1');
    expect((await panel.boundingBox())?.width).toBe(390);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByRole('button', { name: 'Close panel' }).click();

    // a page too
    await page.goto(`${stack.origin}/t/engineering/files?path=pages&panel=file:pages/runbook.md`);
    await expect(panel.locator('.md-prose h1')).toHaveText('Production deploy runbook');
    expect(await noSidewaysScroll(page)).toBe(true);
    // its History is the next screen, and Back returns
    await panel.getByTestId('open-history').click();
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(panel.locator('.md-prose h1')).toBeVisible();
  } finally {
    await close();
  }
});
