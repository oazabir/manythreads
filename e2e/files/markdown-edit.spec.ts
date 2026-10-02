import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, actorOf, apiOn, blobOf, commitsOf, openFiles, tree } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/markdown-edit.spec.ts` (criterion 3 and the Markdown viewer): Nadia opens `pages/runbook.md` in the centre, edits it
 * in the WYSIWYG editor, adds a table with `/`, looks at the Raw text, saves: one commit, authored by Nadia, with her words in it. The raw text
 * is what the file holds (it round-trips). Runs on its own stack because it commits.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('WYSIWYG edit, a table from the slash menu, the Raw toggle, one save is one commit by Nadia', async ({ browser, playwright }) => {
  const before = (await commitsOf(stack)).length;
  const api = await apiOn(playwright, stack, 'nadia');
  const original = await blobOf(api, 'pages/runbook.md');
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages');
  try {
    // open it from the tree: the page fills the middle column
    await tree(page, 'pages/runbook.md').click();
    const view = page.getByTestId('file-view');
    await expect(view.getByTestId('file-view-path')).toHaveText('pages/runbook.md');
    const md = view.getByTestId('viewer-markdown');
    await expect(md.locator('.md-prose h1')).toHaveText('Production deploy runbook');
    await expect(md.getByRole('button', { name: 'Save' })).toBeDisabled();

    // type at the end of the page
    const editor = md.locator('.md-prose');
    await editor.click();
    await page.keyboard.press('Control+End');
    // the page ends in a list: a second Enter leaves it
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Reviewed by Nadia on release day.');
    await expect(md.getByRole('button', { name: 'Save' })).toBeEnabled();

    // `/` opens the block menu; Table inserts a 3 by 3 table with a header row
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table');
    await expect(md.locator('[data-slash="table"]')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(md.locator('.md-prose table')).toHaveCount(1);
    await expect(md.locator('.md-prose table tr')).toHaveCount(3);

    // Raw shows the Markdown the page will be saved as: her sentence and a pipe table
    await md.getByRole('button', { name: 'Raw', exact: true }).click();
    const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
    const text = await raw.inputValue();
    expect(text).toContain('Reviewed by Nadia on release day.');
    expect(text).toMatch(/\|[ ]+\|[ ]+\|[ ]+\|\n\| --- \| --- \| --- \|/);
    expect(text.startsWith('# Production deploy runbook')).toBe(true);

    // a change made in Raw comes back in the editor, and the page saves what Raw shows (the round trip)
    await raw.fill(`${text.trimEnd()}\n\nSecond reviewer: Rafi.\n`);
    await md.getByRole('button', { name: 'Raw', exact: true }).click();
    await expect(md.locator('.md-prose')).toContainText('Second reviewer: Rafi.');
    await md.getByRole('button', { name: 'Raw', exact: true }).click();
    const rawAgain = await md.getByRole('textbox', { name: 'Raw Markdown' }).inputValue();
    expect(rawAgain).toContain('Second reviewer: Rafi.');
    expect(rawAgain).toContain('Reviewed by Nadia on release day.');
    expect(rawAgain.match(/\|/g)?.length).toBe(text.match(/\|/g)?.length);

    await md.getByRole('button', { name: 'Save' }).click();
    await expect(md.getByRole('status')).toContainText('Saved. A commit by Nadia was made.');

    // one commit, by Nadia, whose content is what Raw showed
    const after = await commitsOf(stack);
    expect(after.length).toBe(before + 1);
    expect(after[0]?.authorId).toBe(actorOf('nadia'));
    expect(after[0]?.paths).toEqual(['pages/runbook.md']);
    const saved = await blobOf(api, 'pages/runbook.md');
    expect(saved).not.toBe(original);
    expect(saved.trimEnd()).toBe(rawAgain.trimEnd());
    expect(saved).toContain('Reviewed by Nadia on release day.');

    // reopened after a reload, the Raw view holds the same text
    await page.reload();
    const again = page.getByTestId('file-view').getByTestId('viewer-markdown');
    await expect(again.locator('.md-prose')).toContainText('Second reviewer: Rafi.');
    await again.getByRole('button', { name: 'Raw', exact: true }).click();
    expect((await again.getByRole('textbox', { name: 'Raw Markdown' }).inputValue()).trimEnd()).toBe(saved.trimEnd());
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a page opened in the right panel reads as a page, and Edit makes it editable', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages&panel=file:pages/weekly-digest.md');
  try {
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel.getByTestId('panel-title')).toHaveText('weekly-digest.md');
    // the read view has no editor controls
    await expect(panel.getByTestId('file-preview')).toHaveClass(/reading/);
    await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(panel.locator('.md-prose')).toHaveAttribute('contenteditable', 'false');
    await panel.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(panel.locator('.md-prose')).toHaveAttribute('contenteditable', 'true');
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(panel.locator('.md-prose')).toHaveAttribute('contenteditable', 'false');
  } finally {
    await close();
  }
});
