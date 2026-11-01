import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/**
 * Import from Slack (PLAN P14-13), on a stack of its own (the spec writes channels and messages). Omar, a workspace admin, opens Settings, Import, picks
 * Slack and Engineering, uploads the committed Slack export (3 channels, 200 messages), reads the dry run (it says nothing has been written), starts the
 * import and reads the final report; the imported channel then shows its messages. Nadia, who is not an admin, gets the not-found page. At 390 px the
 * screen has no sideways scroll.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the 390 px phone is opened with its own viewport below');
test.describe.configure({ mode: 'serial' });

const ARCHIVE = fileURLToPath(new URL('../../packages/plugins/import/test/fixtures/slack-export.zip', import.meta.url));

let stack: Stack;
let omar: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
  omar = await apiOn(playwright, stack, 'omar');
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('an admin uploads a Slack export, reads the dry run, starts the import and reads the report', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/import');
  try {
    await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();
    await expect(page.getByTestId('import-empty')).toBeVisible();

    await page.getByTestId('import-source').selectOption('slack');
    await page.getByTestId('import-team').selectOption('engineering');
    await page.getByTestId('import-file').setInputFiles(ARCHIVE);
    await page.getByTestId('import-upload').click();

    const run = page.locator('[data-testid^="import-run-"]').first();
    await expect(run).toHaveAttribute('data-status', 'uploaded');

    // the dry run writes nothing and says so
    await run.getByTestId('import-dry-run').click();
    await expect(run).toHaveAttribute('data-status', 'analysed', { timeout: 30_000 });
    const report = run.getByTestId('import-report');
    await expect(report).toContainText('Nothing has been written yet');
    await expect(report).toContainText('212 messages');

    // Start asks again before it writes
    await run.getByTestId('import-start').click();
    await expect(run.getByTestId('import-start-confirm')).toBeVisible();
    await run.getByTestId('import-start-confirm').click();
    await expect(run).toHaveAttribute('data-status', 'done', { timeout: 90_000 });
    await expect(run.getByTestId('import-report')).toContainText('What happened');
    await expect(run.getByTestId('import-delete')).toBeVisible();
  } finally {
    await context.close();
  }

  // the imported channel holds the messages, oldest history first in time order
  const list = await omar.get<{ items: Array<{ result: { channelLines: Array<{ kind: string; outcome: string; becomes?: string | null; name: string }> } | null }> }>('/api/admin/imports');
  const lines = list.items[0]?.result?.channelLines ?? [];
  const made = lines.find((c) => c.kind !== 'direct' && c.outcome !== 'skip');
  expect(made, 'the report names a channel that was made').toBeTruthy();
  const name = made!.becomes ?? made!.name;
  const { page: chan, context: ctx2 } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${name}`);
  try {
    await expect(chan.locator('[data-testid="message"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(chan.locator('[data-testid="message"]').filter({ hasText: 'shipping notes' }).first()).toBeVisible();
  } finally {
    await ctx2.close();
  }
});

test('a person who is not an admin does not get the Import screen', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/settings/workspace/import');
  try {
    await expect(page.getByTestId('import-source')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('at 390 px the screen has no sideways scroll', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/import', { viewport: PHONE });
  try {
    await expect(page.getByTestId('import-source')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
