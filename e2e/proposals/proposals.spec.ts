import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { BOTS_STACK_ENV, BOT_MD, definitionOf } from '../bots/support.ts';
import { actorOf, commitsOf } from '../files/support.ts';
import { apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Proposals (PLAN P7-01) end to end: a member proposes a change to a bot definition from the bot page's file, the lead sees the lines that change and applies
 * them, an invalid BOT.md shows the loader's own text and cannot be applied, and a stale proposal says why. Runs on its own stack because Omar commits.
 * Desktop and the phone width (390 px: no sideways scroll on the list, a proposal or the dialog).
 */

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

type Detail = { proposal: { id: string; status: string; checks: Array<{ name: string; ok: boolean; message: string }>; appliedCommitSha: string | null; selfApplied: boolean }; stale: boolean; canApply: boolean; cannotApplyReason: string | null };

test('a member proposes through the API, a lead applies it: the commit is the lead’s and the proposal says so', async ({ playwright }) => {
  const priya = await apiOn(playwright, stack, 'priya');
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const base = await definitionOf(omar);
    const content = `${base.content.trimEnd()}\n\nAlways say what changed.\n`;
    const made = await priya.ctx.post('/api/teams/engineering/proposals', { data: { path: BOT_MD, content, baseBlobSha: base.blobSha, title: 'Say what changed' }, headers: await priya.headers() });
    expect(made.status(), await made.text()).toBe(201);
    const { proposal } = (await made.json()) as { proposal: Detail };
    expect(proposal.proposal.status).toBe('open');
    expect(proposal.proposal.checks).toEqual([expect.objectContaining({ name: 'BOT.md loads', ok: true })]);
    expect(proposal.canApply).toBe(false);

    // nothing moved
    expect((await definitionOf(omar)).blobSha).toBe(base.blobSha);

    // a member cannot apply
    const refused = await priya.ctx.post(`/api/teams/engineering/proposals/${proposal.proposal.id}/approve`, { data: {}, headers: await priya.headers() });
    expect(refused.status()).toBe(403);

    const before = (await commitsOf(stack)).length;
    const done = await omar.ctx.post(`/api/teams/engineering/proposals/${proposal.proposal.id}/approve`, { data: {}, headers: await omar.headers() });
    expect(done.status(), await done.text()).toBe(200);
    const applied = ((await done.json()) as { proposal: Detail }).proposal;
    expect(applied.proposal.status).toBe('applied');
    const commits = await commitsOf(stack);
    expect(commits.length).toBe(before + 1);
    expect(commits[0]).toMatchObject({ authorId: actorOf('omar'), paths: [BOT_MD] });
    expect((await definitionOf(omar)).content).toBe(content);
  } finally {
    await priya.ctx.dispose();
    await omar.ctx.dispose();
  }
});

test('a BOT.md that does not load shows the loader’s words and cannot be applied; a moved file says so', async ({ browser, playwright }) => {
  const priya = await apiOn(playwright, stack, 'priya');
  const omar = await apiOn(playwright, stack, 'omar');
  let id = '';
  let stale = '';
  try {
    const base = await definitionOf(omar);
    const bad = await priya.ctx.post('/api/teams/engineering/proposals', { data: { path: BOT_MD, content: '---\nname: Broken\n---\n', baseBlobSha: base.blobSha, title: 'A broken definition' }, headers: await priya.headers() });
    expect(bad.status(), await bad.text()).toBe(201);
    id = ((await bad.json()) as { proposal: Detail }).proposal.proposal.id;
    const refused = await omar.ctx.post(`/api/teams/engineering/proposals/${id}/approve`, { data: {}, headers: await omar.headers() });
    expect(refused.status()).toBe(422);
    expect(await refused.text()).toContain('BOT.md loads');

    const ok = await priya.ctx.post('/api/teams/engineering/proposals', { data: { path: BOT_MD, content: `${base.content.trimEnd()}\n\nA second line.\n`, baseBlobSha: base.blobSha, title: 'Will go stale' }, headers: await priya.headers() });
    stale = ((await ok.json()) as { proposal: Detail }).proposal.proposal.id;
    // the lead changes the same file first (a proposal applied at once)
    const moved = await omar.ctx.post('/api/teams/engineering/proposals', { data: { path: BOT_MD, content: `${base.content.trimEnd()}\n\nSomething else.\n`, baseBlobSha: base.blobSha, title: 'Moves the file', applyNow: true }, headers: await omar.headers() });
    expect(moved.status(), await moved.text()).toBe(201);
    expect(((await moved.json()) as { proposal: Detail }).proposal.proposal.selfApplied).toBe(true);
  } finally {
    await priya.ctx.dispose();
    await omar.ctx.dispose();
  }

  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/proposals/${id}`);
  try {
    await expect(page.getByTestId('proposal-checks')).toContainText('BOT.md loads');
    await expect(page.getByTestId('proposal-checks')).toContainText('role');
    await expect(page.getByTestId('proposal-apply')).toHaveCount(0);
    await expect(page.getByTestId('proposal-check-failed')).toBeVisible();
    await page.goto(`${stack.origin}/t/engineering/proposals/${stale}`);
    await expect(page.getByTestId('proposal-stale')).toContainText('changed');
    await expect(page.getByTestId('proposal-apply')).toHaveCount(0);
    // the lead declines it, with the list showing it as decided
    await page.getByTestId('proposal-reject').click();
    await expect(page.getByTestId('proposal-status')).toHaveAttribute('data-status', 'rejected');
  } finally {
    await context.close();
  }
});

test('the bot page: Save as proposal leaves it waiting; the list shows it; the lead applies it from there', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/coder');
  try {
    await expect(page.getByTestId('bot-page')).toBeVisible();
    const role = page.getByTestId('bot-role');
    await role.fill('Reviews code for Engineering');
    await page.getByTestId('propose-bot').click();
    await expect(page.getByTestId('save-notice')).toContainText('Proposal saved');
    await page.getByTestId('open-proposal').click();
    await expect(page.getByTestId('proposal-diff')).toContainText('Reviews code for Engineering');
    await expect(page.getByTestId('proposal-status')).toHaveAttribute('data-status', 'open');
    // Omar is the only lead and admin, so he may apply what he saved for review
    await page.getByTestId('proposal-apply').click();
    await expect(page.getByTestId('proposal-status')).toHaveAttribute('data-status', 'applied');
    await page.goto(`${stack.origin}/t/engineering/proposals`);
    await page.getByTestId('proposals-filter-all').click();
    await expect(page.getByTestId('proposal-row').filter({ hasText: 'Update coder' })).toHaveAttribute('data-status', 'applied');
  } finally {
    await context.close();
  }
});

test('at 390 px the list, a proposal and the dialog do not scroll sideways', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/proposals');
  try {
    await page.getByTestId('proposals-filter-all').click();
    await expect(page.getByTestId('proposal-row').first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('proposal-row').first().click();
    await expect(page.getByTestId('proposal-diff')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.goto(`${stack.origin}/t/engineering/files?open=TEAM.md`);
    await page.getByTestId('change-by-pr').click();
    await expect(page.getByTestId('dialog-propose')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
