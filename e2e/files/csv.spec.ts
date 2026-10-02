import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, actorOf, apiOn, blobOf, commitsOf, openFiles } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/csv.spec.ts` (criterion 7, "a CSV cell edit changes that cell only"): Rafi opens `pages/reports/signups.csv` in the
 * right panel, edits one cell, saves. The commit is one, by Rafi, and the file differs from before in that cell and nowhere else.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('editing one cell commits that cell only', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const before = await blobOf(api, 'pages/reports/signups.csv');
  const commitsBefore = (await commitsOf(stack)).length;
  const { page, close } = await openFiles(browser, playwright, stack, 'rafi', '?path=pages/reports&panel=file:pages/reports/signups.csv');
  try {
    const csv = page.locator('[data-landmark="right-panel"]').getByTestId('viewer-csv');
    await expect(csv.getByTestId('csv-cell')).toHaveCount(15);
    const cell = csv.getByLabel('Row 3, column B');
    const was = await cell.inputValue();
    expect(was).toBe('455');
    await cell.fill('460');
    await expect(csv).toHaveAttribute('data-dirty', 'true');
    await csv.getByRole('button', { name: 'Save' }).click();
    await expect(csv.getByRole('status')).toContainText('Saved. A commit by Rafi was made.');

    // one commit, by Rafi, touching this file
    const commits = await commitsOf(stack);
    expect(commits.length).toBe(commitsBefore + 1);
    expect(commits[0]?.authorId).toBe(actorOf('rafi'));
    expect(commits[0]?.paths).toEqual(['pages/reports/signups.csv']);

    // the file differs in one cell: the same rows, the same columns, every other value untouched
    const after = await blobOf(api, 'pages/reports/signups.csv');
    const grid = (text: string): string[][] => text.trimEnd().split('\n').map((l) => l.split(','));
    const a = grid(before);
    const b = grid(after);
    expect(b.length).toBe(a.length);
    const changed: string[] = [];
    a.forEach((r, i) => r.forEach((v, j) => v !== b[i]?.[j] && changed.push(`${i + 1},${j}: ${v} -> ${b[i]?.[j]}`)));
    expect(changed).toEqual(['3,1: 455 -> 460']);

    // after a reload the grid shows the saved value
    await page.reload();
    await expect(page.locator('[data-landmark="right-panel"]').getByLabel('Row 3, column B')).toHaveValue('460');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});
