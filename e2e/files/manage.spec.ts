import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, actorOf, apiOn, blobOf, commitsOf, openFiles, row, tree } from './support.ts';

/*
 * PLAN P4-11, the Files screen's management of the repo: a new page, a new folder, rename, move and delete (with its confirm), each one commit by the
 * person. Nadia works in pages/; the attachments of a channel can be deleted by their uploader but neither renamed nor moved. Runs on its own stack.
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

test('a new page, a new folder, rename, move and delete: one commit each, by Nadia', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages');
  try {
    const before = (await commitsOf(stack)).length;

    // a new page: the name without an extension is a Markdown page, and it opens in the centre
    await page.getByTestId('new-page').click();
    const dialog = page.getByTestId('dialog-new-file');
    await dialog.getByLabel('Name').fill('retro');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('file-view-path')).toHaveText('pages/retro.md');
    expect(await blobOf(api, 'pages/retro.md')).toBe('# Retro\n\n');
    let commits = await commitsOf(stack);
    expect(commits.length).toBe(before + 1);
    expect(commits[0]).toMatchObject({ authorId: actorOf('nadia'), paths: ['pages/retro.md'] });

    // the same name is refused, in words, and nothing is committed
    await page.getByTestId('close-file').click();
    await page.getByTestId('new-page').click();
    await page.getByTestId('dialog-new-file').getByLabel('Name').fill('retro.md');
    await page.getByTestId('dialog-new-file').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('dialog-new-file').getByRole('alert')).toContainText('already here');
    expect((await commitsOf(stack)).length).toBe(before + 1);
    await page.getByTestId('dialog-new-file').getByRole('button', { name: 'Cancel' }).click();

    // a name with a slash is not a name
    await page.getByTestId('new-folder').click();
    await page.getByTestId('dialog-new-folder').getByLabel('Name').fill('a/b');
    await expect(page.getByTestId('dialog-new-folder').getByRole('alert')).toContainText('slash');
    await expect(page.getByTestId('dialog-new-folder').getByRole('button', { name: 'Create' })).toBeDisabled();

    // a new folder: it opens, empty to the eye (the placeholder file is hidden)
    await page.getByTestId('dialog-new-folder').getByLabel('Name').fill('retros');
    await page.getByTestId('dialog-new-folder').getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/path=pages%2Fretros/);
    await expect(page.getByTestId('files-empty')).toContainText('Nothing here yet.');
    expect((await commitsOf(stack)).length).toBe(before + 2);

    // rename
    await page.goto(`${stack.origin}/t/engineering/files?path=pages`);
    await row(page, 'pages/retro.md').hover();
    await row(page, 'pages/retro.md').getByTestId('row-menu').click();
    await page.getByTestId('row-action-rename').click();
    await page.getByTestId('dialog-rename').getByLabel('New name').fill('retrospective.md');
    await page.getByTestId('dialog-rename').getByRole('button', { name: 'Rename' }).click();
    await expect(row(page, 'pages/retrospective.md')).toBeVisible();
    await expect(row(page, 'pages/retro.md')).toHaveCount(0);
    commits = await commitsOf(stack);
    expect(commits.length).toBe(before + 3);
    expect(commits[0]).toMatchObject({ authorId: actorOf('nadia'), message: 'Rename pages/retro.md to retrospective.md' });
    expect(commits[0]?.paths.sort()).toEqual(['pages/retro.md', 'pages/retrospective.md']);
    expect(await blobOf(api, 'pages/retrospective.md')).toBe('# Retro\n\n');

    // move into the new folder
    await row(page, 'pages/retrospective.md').hover();
    await row(page, 'pages/retrospective.md').getByTestId('row-menu').click();
    await page.getByTestId('row-action-move').click();
    await page.getByTestId('dialog-move').getByLabel('Move to folder').fill('pages/retros');
    await page.getByTestId('dialog-move').getByRole('button', { name: 'Move' }).click();
    await expect(row(page, 'pages/retrospective.md')).toHaveCount(0);
    expect(await blobOf(api, 'pages/retros/retrospective.md')).toBe('# Retro\n\n');
    expect((await commitsOf(stack)).length).toBe(before + 4);

    // delete asks first; Cancel keeps it, Delete commits the removal
    await page.goto(`${stack.origin}/t/engineering/files?path=pages/retros`);
    const doomed = row(page, 'pages/retros/retrospective.md');
    await doomed.hover();
    await doomed.getByTestId('row-menu').click();
    await page.getByTestId('row-action-delete').click();
    const confirm = page.getByTestId('dialog-delete');
    await expect(confirm).toContainText('Delete retrospective.md?');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(doomed).toBeVisible();
    expect((await commitsOf(stack)).length).toBe(before + 4);
    await doomed.hover();
    await doomed.getByTestId('row-menu').click();
    await page.getByTestId('row-action-delete').click();
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(doomed).toHaveCount(0);
    commits = await commitsOf(stack);
    expect(commits.length).toBe(before + 5);
    expect(commits[0]).toMatchObject({ authorId: actorOf('nadia'), message: 'Delete pages/retros/retrospective.md' });
    expect((await api.ctx.get('/api/teams/engineering/repo/blob?path=pages/retros/retrospective.md')).status()).toBe(404);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('an attachment can be deleted by its uploader; it has no Rename or Move', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'rafi', '?path=channels/dev');
  try {
    // Rafi uploaded the PNG (seed v4)
    const png = row(page, 'channels/dev/latency-before-after.png');
    await expect(png).toBeVisible();
    await png.hover();
    await png.getByTestId('row-menu').click();
    await expect(page.getByTestId('row-action-rename')).toHaveCount(0);
    await expect(page.getByTestId('row-action-move')).toHaveCount(0);
    await expect(page.getByTestId('row-action-download')).toHaveAttribute('href', /\/api\/files\/.+\/content\?download=1$/);
    await page.getByTestId('row-action-delete').click();
    await expect(page.getByTestId('dialog-delete')).toContainText('removed from its channel for everyone');
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(png).toHaveCount(0);
    await expect(row(page, 'channels/dev/canary-rollout.mp4')).toBeVisible();
  } finally {
    await close();
  }
});

test('a folder is picked from the tree: arrow keys walk it, Enter opens', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia');
  try {
    await tree(page, 'bots').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tree(page, 'bots/coder')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(tree(page, 'bots/coder')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/path=bots%2Fcoder/);
    await expect(row(page, 'bots/coder/BOT.md')).toBeVisible();
  } finally {
    await close();
  }
});
