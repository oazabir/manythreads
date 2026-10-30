import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn } from '../support/stack-browser.ts';
import { STACK_ENV, actorOf, apiOn, blobOf, commitsOf, openFiles, row, tree } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/member-readonly-bots.spec.ts` (criterion 9), as P7-01 changed it: bots/, skills/, routines/ and TEAM.md take no direct
 * commit from anybody. Priya (a member who does not lead Engineering) sees them read-only with "Change by proposal" and proposes a change; a direct write
 * is 403 and commits nothing; the proposal waits until Omar (the lead) looks at the lines and applies it, and then the commit is his. Runs on its own
 * stack because Omar commits.
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

test('Priya reads bots/ and TEAM.md but cannot change them: the edit is a proposal, a direct write is 403', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const before = (await commitsOf(stack)).length;
  const original = await blobOf(api, BOT);
  const { page, close } = await openFiles(browser, playwright, stack, 'priya', '?path=bots/coder');
  try {
    // the folder says so, and so does every row in it
    await expect(page.getByTestId('read-only-note')).toContainText('Change by proposal');
    await expect(row(page, BOT)).toContainText('Change by proposal');
    await expect(row(page, BOT).getByRole('cell', { name: 'Change by proposal' })).toBeVisible();

    // the file opens and reads, but the page has no Save and cannot be typed in
    await tree(page, BOT).click();
    const view = page.getByTestId('file-view');
    await expect(view.getByTestId('read-only-note')).toContainText('Change by proposal');
    await expect(view.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(view.getByTestId('viewer-markdown')).toContainText('You can read this file but not change it.');
    await expect(view.locator('.md-prose')).toHaveAttribute('contenteditable', 'false');
    // no Rename, Move or Delete in its menu: the only change on offer is a proposal
    await view.getByTestId('row-menu').click();
    await expect(page.getByTestId('row-action-rename')).toHaveCount(0);
    await expect(page.getByTestId('row-action-move')).toHaveCount(0);
    await expect(page.getByTestId('row-action-delete')).toHaveCount(0);
    await page.getByTestId('row-action-pull-request').click();

    // she proposes a change: the whole file, the lines that change, and only "Save as proposal" (she cannot apply)
    const dialog = page.getByTestId('dialog-propose');
    await expect(dialog.getByTestId('propose-apply')).toHaveCount(0);
    const text = dialog.getByTestId('propose-text');
    await expect(text).not.toHaveValue('');
    await text.fill(`${(await text.inputValue()).trimEnd()}\n\nNever merges without a review.\n`);
    await expect(dialog.getByTestId('propose-preview')).toContainText('2 lines added, 0 removed');
    await dialog.getByTestId('propose-title').fill('Coder reviews before it merges');
    await dialog.getByTestId('propose-save').click();
    await expect(page.getByTestId('propose-done-text')).toContainText('Nothing changes until then');
    await page.getByRole('button', { name: 'Done' }).click();

    // TEAM.md is the same
    await page.goto(`${stack.origin}/t/engineering/files?open=TEAM.md`);
    const team = page.getByTestId('file-view');
    await expect(team.getByTestId('read-only-note')).toContainText('Change by proposal');
    await expect(team.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // a page of pages/ is hers to change: no note there
    await page.goto(`${stack.origin}/t/engineering/files?path=pages`);
    await expect(row(page, 'pages/runbook.md')).toBeVisible();
    await expect(page.getByTestId('read-only-note')).toHaveCount(0);
  } finally {
    await close();
  }

  // direct writes to the guarded paths: 403, nothing committed, nothing changed; the proposal changed nothing either
  for (const path of [BOT, 'TEAM.md', 'skills/x/SKILL.md', 'routines/x.yaml']) {
    const res = await api.ctx.post('/api/teams/engineering/repo/commit', { data: { changes: [{ op: 'put', path, content: 'changed\n', encoding: 'utf8' }], message: `Change ${path}` }, headers: await api.headers() });
    expect(res.status(), path).toBe(403);
  }
  expect((await commitsOf(stack)).length).toBe(before);
  expect(await blobOf(api, BOT)).toBe(original);
  await api.ctx.dispose();
});

test("Omar leads the team: he applies Priya's proposal after looking at the lines, and the commit is Omar's", async ({ browser, playwright }) => {
  const before = (await commitsOf(stack)).length;
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/proposals');
  try {
    await expect(page.getByTestId('proposals-list')).toBeVisible();
    const waiting = page.getByTestId('proposal-row').filter({ hasText: 'Coder reviews before it merges' });
    await expect(waiting).toBeVisible();
    await waiting.click();
    await expect(page.getByTestId('proposal-diff')).toContainText('Never merges without a review.');
    await expect(page.getByTestId('proposal-checks')).toContainText('BOT.md loads');
    await page.getByTestId('proposal-apply').click();
    await expect(page.getByTestId('proposal-status')).toHaveAttribute('data-status', 'applied');
    await expect(page.getByTestId('proposal-outcome')).toContainText('Applied by Omar');
  } finally {
    await context.close();
  }
  const commits = await commitsOf(stack);
  expect(commits.length).toBe(before + 1);
  expect(commits[0]?.authorId).toBe(actorOf('omar'));
  expect(commits[0]?.paths).toEqual([BOT]);
});

test('Omar edits a file in Files with Propose and apply: one step, still on record as a proposal', async ({ browser, playwright }) => {
  const before = (await commitsOf(stack)).length;
  const { page, close } = await openFiles(browser, playwright, stack, 'omar', '?open=TEAM.md');
  try {
    const view = page.getByTestId('file-view');
    await expect(view.getByTestId('read-only-note')).toContainText('Change by proposal');
    await view.getByTestId('change-by-pr').click();
    const dialog = page.getByTestId('dialog-propose');
    const text = dialog.getByTestId('propose-text');
    await text.fill(`${(await text.inputValue()).trimEnd()}\n\nWe ship on Thursdays.\n`);
    await dialog.getByTestId('propose-apply').click();
    await expect(page.getByTestId('propose-done-text')).toContainText('on record as a proposal');
  } finally {
    await close();
  }
  const commits = await commitsOf(stack);
  expect(commits.length).toBe(before + 1);
  expect(commits[0]?.authorId).toBe(actorOf('omar'));
  expect(commits[0]?.paths).toEqual(['TEAM.md']);
});
