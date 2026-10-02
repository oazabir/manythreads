import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, actorOf, apiOn, blobOf, commitsOf, openFiles, tree } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/history-restore.spec.ts` (criterion 7): Nadia edits `pages/runbook.md` twice, opens History, reads the diff of the newest
 * commit as lines and as rendered text, restores the first version of the page. Restore adds a commit and keeps every old one; the page holds the
 * old words again. Runs on its own stack because it commits.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Appends a sentence in the Raw text of the open page and saves it. */
async function editRaw(page: Page, sentence: string): Promise<void> {
  const md = page.getByTestId('file-view').getByTestId('viewer-markdown');
  if ((await md.getAttribute('data-mode')) !== 'raw') await md.getByRole('button', { name: 'Raw', exact: true }).click();
  const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
  await raw.fill(`${(await raw.inputValue()).trimEnd()}\n\n${sentence}\n`);
  await md.getByRole('button', { name: 'Save' }).click();
  await expect(md.getByRole('status')).toContainText('Saved. A commit by Nadia was made.');
}

test('edit twice, read the diff, restore the first version: a new commit, the old ones kept', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  // the first version of the page: the oldest commit that touched it
  const log = await api.get<{ commits: { sha: string }[] }>('/api/teams/engineering/repo/history?path=pages/runbook.md');
  const oldest = log.commits.at(-1)?.sha ?? '';
  const first = (await api.get<{ content: string }>(`/api/teams/engineering/repo/blob?path=pages/runbook.md&ref=${oldest}`)).content;
  expect(first).toContain('# Production deploy runbook');
  const seeded = (await commitsOf(stack)).length;
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages');
  try {
    await tree(page, 'pages/runbook.md').click();
    await expect(page.getByTestId('file-view').getByTestId('viewer-markdown')).toBeVisible();
    await editRaw(page, 'Edit one: the canary hold is thirty minutes.');
    await editRaw(page, 'Edit two: page the on-call before promoting.');
    expect((await commitsOf(stack)).length).toBe(seeded + 2);

    // History opens in the right panel: the page's commits, newest first, the newest selected
    await page.getByTestId('file-view').getByTestId('open-history').click();
    const history = page.getByTestId('history');
    await expect(history).toBeVisible();
    const commits = history.getByTestId('commit-row');
    await expect(commits).toHaveCount(4);
    await expect(commits.first()).toHaveAttribute('data-selected', 'true');
    await expect(commits.first()).toContainText('Nadia');

    // the text diff of the newest commit: the sentence of edit two as an added line, nothing deleted
    const diff = history.getByTestId('text-diff');
    await expect(diff.locator('[data-line="add"]', { hasText: 'Edit two: page the on-call before promoting.' })).toHaveCount(1);
    await expect(diff.locator('[data-line="del"]')).toHaveCount(0);

    // the rendered diff shows the same change as text on a green wash
    await history.getByRole('button', { name: 'Rendered', exact: true }).click();
    const rendered = history.getByTestId('rendered-diff');
    await expect(rendered.locator('[data-change="add"]', { hasText: 'Edit two: page the on-call before promoting.' })).toHaveCount(1);
    await expect(rendered.locator('[data-change="del"]')).toHaveCount(0);
    await history.getByRole('button', { name: 'Text', exact: true }).click();

    // the current version cannot be restored; the first one (the oldest commit) can
    await expect(history.getByTestId('restore-version')).toBeDisabled();
    await commits.last().getByRole('button').first().click();
    await expect(commits.last()).toHaveAttribute('data-selected', 'true');
    await history.getByTestId('restore-version').click();
    const dialog = page.getByTestId('dialog-restore');
    await expect(dialog.getByTestId('restore-question')).toHaveText(/^Restore runbook\.md to [A-Z][a-z]{2} \d{2}:\d{2}\? A new commit will be made\.$/);
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(history.getByRole('status')).toContainText('Restored. A new commit was made.');

    // one more commit by Nadia, every old one still there, the page as it was at the first commit
    await expect(commits).toHaveCount(5);
    const after = await commitsOf(stack);
    expect(after.length).toBe(seeded + 3);
    expect(after[0]?.authorId).toBe(actorOf('nadia'));
    expect(after[0]?.message).toMatch(/^Restore runbook\.md to /);
    expect(after.map((c) => c.message)).toEqual(expect.arrayContaining(['Add the production deploy runbook']));
    expect(await blobOf(api, 'pages/runbook.md')).toBe(first);
    // the page open in the middle shows the restored text, without a reload
    await expect(page.getByTestId('file-view').getByTestId('viewer-markdown').locator('.md-prose')).not.toContainText('Edit two');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a page nobody wrote to has history that opens from the row menu', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'rafi', '?path=pages');
  try {
    const row = page.locator('[data-testid="file-row"][data-path="pages/changelog.md"]');
    await row.hover();
    await row.getByTestId('row-menu').click();
    await page.getByTestId('row-action-history').click();
    await expect(page.getByTestId('history')).toHaveAttribute('data-path', 'pages/changelog.md');
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
  } finally {
    await close();
  }
});
