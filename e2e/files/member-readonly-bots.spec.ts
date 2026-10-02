import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, actorOf, apiOn, blobOf, commitsOf, openFiles, row, tree } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/member-readonly-bots.spec.ts` (criterion 9): Priya (a member who does not lead Engineering) sees `bots/` and `TEAM.md`
 * read-only with "Change by pull request"; the edit is offered only as a pull request; a direct write call is 403 and commits nothing. Omar (the
 * lead) edits the bot in the UI and the commit is his. Runs on its own stack because Omar commits.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');

const BOT = 'bots/coder/BOT.md';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Priya reads bots/ and TEAM.md but cannot change them: the edit is a pull request, a direct write is 403', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const before = (await commitsOf(stack)).length;
  const original = await blobOf(api, BOT);
  const { page, close } = await openFiles(browser, playwright, stack, 'priya', '?path=bots/coder');
  try {
    // the folder says so, and so does every row in it
    await expect(page.getByTestId('read-only-note')).toContainText('Change by pull request');
    await expect(row(page, BOT)).toContainText('Change by pull request');
    await expect(row(page, BOT).getByRole('cell', { name: 'Change by pull request' })).toBeVisible();

    // the file opens and reads, but the page has no Save and cannot be typed in
    await tree(page, BOT).click();
    const view = page.getByTestId('file-view');
    await expect(view.getByTestId('read-only-note')).toContainText('Change by pull request');
    await expect(view.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(view.getByTestId('viewer-markdown')).toContainText('You can read this file but not change it.');
    await expect(view.locator('.md-prose')).toHaveAttribute('contenteditable', 'false');
    // no Rename, Move or Delete in its menu: the only change on offer is the pull request
    await view.getByTestId('row-menu').click();
    await expect(page.getByTestId('row-action-rename')).toHaveCount(0);
    await expect(page.getByTestId('row-action-move')).toHaveCount(0);
    await expect(page.getByTestId('row-action-delete')).toHaveCount(0);
    await page.getByTestId('row-action-pull-request').click();
    const dialog = page.getByTestId('dialog-pull-request');
    await expect(dialog).toContainText('is changed by a pull request to the team repo');
    await dialog.getByRole('button', { name: 'Close' }).click();

    // TEAM.md is the same
    await page.goto(`${stack.origin}/t/engineering/files?open=TEAM.md`);
    const team = page.getByTestId('file-view');
    await expect(team.getByTestId('read-only-note')).toContainText('Change by pull request');
    await expect(team.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // a page of pages/ is hers to change: no note there
    await page.goto(`${stack.origin}/t/engineering/files?path=pages`);
    await expect(row(page, 'pages/runbook.md')).toBeVisible();
    await expect(page.getByTestId('read-only-note')).toHaveCount(0);
  } finally {
    await close();
  }

  // direct writes to the guarded paths: 403, nothing committed, nothing changed
  for (const path of [BOT, 'TEAM.md', 'skills/x/SKILL.md', 'routines/x.yaml']) {
    const res = await api.ctx.post('/api/teams/engineering/repo/commit', { data: { changes: [{ op: 'put', path, content: 'changed\n', encoding: 'utf8' }], message: `Change ${path}` }, headers: await api.headers() });
    expect(res.status(), path).toBe(403);
  }
  expect((await commitsOf(stack)).length).toBe(before);
  expect(await blobOf(api, BOT)).toBe(original);
  await api.ctx.dispose();
});

test("Omar leads the team: he edits the bot in the UI and the commit is Omar's", async ({ browser, playwright }) => {
  const before = (await commitsOf(stack)).length;
  const { page, close } = await openFiles(browser, playwright, stack, 'omar', '?path=bots/coder');
  try {
    await expect(page.getByTestId('read-only-note')).toHaveCount(0);
    await tree(page, BOT).click();
    const view = page.getByTestId('file-view');
    await expect(view.getByTestId('read-only-note')).toHaveCount(0);
    const md = view.getByTestId('viewer-markdown');
    await md.getByRole('button', { name: 'Raw', exact: true }).click();
    const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
    await raw.fill(`${(await raw.inputValue()).trimEnd()}\n\nNever merges a pull request without a review.\n`);
    await md.getByRole('button', { name: 'Save' }).click();
    await expect(md.getByRole('status')).toContainText('Saved. A commit by Omar was made.');
  } finally {
    await close();
  }
  const commits = await commitsOf(stack);
  expect(commits.length).toBe(before + 1);
  expect(commits[0]?.authorId).toBe(actorOf('omar'));
  expect(commits[0]?.paths).toEqual([BOT]);
});
