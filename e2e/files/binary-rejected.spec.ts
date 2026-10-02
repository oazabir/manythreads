import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, actorOf, apiOn, commitsOf, openFiles, row } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/binary-rejected.spec.ts` (criterion 4): a PNG offered to `pages/` is refused with the words of the screen and nothing
 * is committed; the same bytes sent straight to the commit route are 422 `attachment_not_in_repo`. A text file does go to git, and the PNG goes into
 * a channel folder as an attachment. Runs on its own stack because it writes.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');

const COPY = 'This folder is stored in git, which holds text only. Upload attachments to a channel folder.';
// a PNG signature and header: the length field of IHDR holds NUL bytes, as every PNG does
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'), Buffer.alloc(48)]);

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a PNG offered to pages/ is refused and nothing is committed', async ({ browser, playwright }) => {
  const before = (await commitsOf(stack)).length;
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages');
  try {
    await expect(row(page, 'pages/runbook.md')).toBeVisible();
    await page.getByTestId('upload-input').setInputFiles({ name: 'latency-chart.png', mimeType: 'image/png', buffer: PNG });
    const alert = page.getByTestId('upload-text-only');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(COPY);
    await expect(alert).toContainText('latency-chart.png was not uploaded.');
    // nothing was committed and the file is not in the list (after a moment for a wrong answer to show up)
    await page.waitForTimeout(500);
    expect((await commitsOf(stack)).length).toBe(before);
    await expect(page.locator('[data-testid="file-row"][data-path="pages/latency-chart.png"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(alert).toHaveCount(0);
  } finally {
    await close();
  }
});

test('the same bytes sent to the commit route are 422 attachment_not_in_repo', async ({ playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  try {
    const before = (await commitsOf(stack)).length;
    const res = await api.ctx.post('/api/teams/engineering/repo/commit', {
      data: { changes: [{ op: 'put', path: 'pages/latency-chart.png', content: PNG.toString('base64'), encoding: 'base64' }], message: 'Add a chart' },
      headers: await api.headers(),
    });
    expect(res.status()).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('attachment_not_in_repo');
    expect((await commitsOf(stack)).length).toBe(before);
  } finally {
    await api.ctx.dispose();
  }
});

test('a text file goes to git as a commit by the person; the PNG goes to a channel folder as an attachment', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages');
  try {
    const before = (await commitsOf(stack)).length;
    await page.getByTestId('upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes for the release.\n') });
    await expect(row(page, 'pages/notes.txt')).toBeVisible();
    await expect(page.getByTestId('upload-text-only')).toHaveCount(0);
    const commits = await commitsOf(stack);
    expect(commits.length).toBe(before + 1);
    expect(commits[0]?.authorId).toBe(actorOf('nadia'));
    expect(commits[0]?.paths).toEqual(['pages/notes.txt']);

    // in a channel folder the same PNG is an attachment
    await page.goto(`${stack.origin}/t/engineering/files?path=channels/dev`);
    await expect(page.getByTestId('file-row').first()).toBeVisible();
    await page.getByTestId('upload-input').setInputFiles({ name: 'latency-chart.png', mimeType: 'image/png', buffer: PNG });
    const uploaded = row(page, 'channels/dev/latency-chart.png');
    await expect(uploaded).toBeVisible();
    await expect(uploaded).toHaveAttribute('data-store', 'attachments');
    await expect(page.getByTestId('upload-text-only')).toHaveCount(0);
    // git did not get it
    expect((await commitsOf(stack)).length).toBe(before + 1);
  } finally {
    await close();
  }
});
