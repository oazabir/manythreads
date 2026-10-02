import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, openFiles, row, tree } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/tree.spec.ts` (criterion 6): Nadia expands `pages/`, `memory/` and `channels/dev/` and sees one tree over the two
 * stores: repo folders and files, memory's two subfolders, and the attachments of #dev, in rows that look alike (the same cells, the same
 * test ids). Read-only, but on a stack of its own because it runs against seed v4 content.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone layout is files/mobile-web.spec.ts');

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('one tree over the repo and the attachments of #dev', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia');
  try {
    // the root: the repo's folders and TEAM.md, and the folder of channels beside them; the placeholder files of empty folders are hidden
    for (const p of ['bots', 'skills', 'routines', 'knowledge', 'pages', 'apps', 'memory', 'channels']) await expect(tree(page, p)).toBeVisible();
    await expect(tree(page, 'TEAM.md')).toBeVisible();
    await expect(page.locator('[data-testid="tree-node"][data-path$=".gitkeep"]')).toHaveCount(0);

    // pages/: git files and folders
    await tree(page, 'pages').getByTestId('tree-caret').click();
    for (const p of ['pages/reports', 'pages/diagrams', 'pages/runbook.md', 'pages/weekly-digest.md']) await expect(tree(page, p)).toBeVisible();

    // memory/: exactly the two subfolders, and the folder says who maintains it
    await tree(page, 'memory').getByTestId('tree-caret').click();
    await expect(tree(page, 'memory/journal')).toBeVisible();
    await expect(tree(page, 'memory/facts')).toBeVisible();
    await expect(page.locator('[data-testid="tree-node"][data-path^="memory/"][data-kind="folder"]')).toHaveCount(2);
    await expect(tree(page, 'memory')).toHaveAttribute('title', 'Managed by team memory');

    // channels/dev/: the channel folder opens in the same tree; its attachments are the rows of the list
    await tree(page, 'channels').getByTestId('tree-caret').click();
    await expect(tree(page, 'channels/dev')).toBeVisible();
    await tree(page, 'channels/dev').click();
    await expect(page).toHaveURL(/path=channels%2Fdev/);
    const attachments = page.locator('[data-testid="file-row"][data-store="attachments"]');
    await expect(attachments).toHaveCount(4);
    for (const name of ['deploy-plan-v2.14.pdf', 'latency-before-after.png', 'canary-rollout.mp4', 'release-notes-v2.14.docx']) {
      await expect(page.locator(`[data-testid="file-row"][data-path="channels/dev/${name}"]`)).toBeVisible();
    }
    await expect(page.getByTestId('breadcrumb')).toContainText('Engineering / channels / dev');

    // a git folder and a channel folder draw the same rows: same cells, same test ids, same attributes
    await tree(page, 'pages').click();
    const gitRow = row(page, 'pages/runbook.md');
    await expect(gitRow).toBeVisible();
    await expect(gitRow).toHaveAttribute('data-kind', 'file');
    await expect(gitRow).toHaveAttribute('data-store', 'git');
    const cells = await gitRow.getByRole('cell').count();
    expect(cells).toBe(7);
    await tree(page, 'channels/dev').click();
    const attRow = row(page, 'channels/dev/latency-before-after.png');
    await expect(attRow.getByRole('cell')).toHaveCount(cells);
    for (const r of await page.getByTestId('file-row').all()) {
      await expect(r).toHaveAttribute('data-path', /.+/);
      await expect(r).toHaveAttribute('data-kind', /^(file|folder)$/);
      await expect(r).toHaveAttribute('data-store', /^(git|attachments)$/);
    }
  } finally {
    await close();
  }
});

test('the list opens a folder and a file; the breadcrumb walks back', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages');
  try {
    await row(page, 'pages/reports').click();
    await expect(page).toHaveURL(/path=pages%2Freports/);
    await expect(row(page, 'pages/reports/signups.csv')).toBeVisible();
    // a file row opens its preview in the right panel, and the row is the selected one
    await row(page, 'pages/reports/signups.csv').click();
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel.getByTestId('panel-title')).toHaveText('signups.csv');
    await expect(panel.getByTestId('viewer-csv')).toBeVisible();
    await expect(row(page, 'pages/reports/signups.csv')).toHaveAttribute('aria-selected', 'true');
    // the breadcrumb goes back up
    await page.getByTestId('breadcrumb').getByRole('button', { name: 'pages', exact: true }).click();
    await expect(page).toHaveURL(/path=pages(&|$)/);
    await expect(row(page, 'pages/runbook.md')).toBeVisible();
    await page.getByTestId('breadcrumb').getByRole('button', { name: 'Engineering', exact: true }).click();
    await expect(row(page, 'pages')).toBeVisible();
  } finally {
    await close();
  }
});

test('an empty folder says so', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=channels/alerts');
  try {
    await expect(page.getByTestId('files-empty')).toContainText('Nothing here yet.');
    await expect(page.getByTestId('file-row')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('the type and source filters narrow the list, and Show all brings it back', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=channels/dev');
  try {
    await expect(page.getByTestId('file-row')).toHaveCount(4);
    await page.getByRole('button', { name: 'Images', exact: true }).click();
    await expect(page.getByTestId('file-row')).toHaveCount(1);
    await expect(row(page, 'channels/dev/latency-before-after.png')).toBeVisible();
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await expect(page.getByTestId('files-no-match')).toBeVisible();
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(page.getByTestId('file-row')).toHaveCount(4);
  } finally {
    await close();
  }
});
