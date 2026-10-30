import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { BOTS_STACK_ENV, definitionOf, openBot } from '../bots/support.ts';
import { apiOn, applyGuarded, noSidewaysScroll } from '../support/stack-browser.ts';

/*
 * Bot evals (PLAN P7-08) end to end: a lead runs a bot's scenario set from its Evals tab and reads "Eval 2 of 2 passed"; a worse BOT.md applied
 * through a proposal starts a run of its own and the tab flags a score below the minimum, with the reason per case; a member reads it and is not
 * offered the button (the API refuses them too). Own stack, because Omar commits. Runs at the desktop and the phone width.
 */

const BOT = 'eval-demo';
const BOT_PATH = `bots/${BOT}/BOT.md`;

const botMd = (native: string): string => `---
schema: 1
name: Eval Demo
role: Answers in the evals spec
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [${native}]
model:
  aliases: [smart]
evals:
  set: qa
  minScore: 0.9
---

# Eval Demo

Answer from the sources you can open. Say so when you do not know.
`;

const SET = `schema: 1
set: qa
cases:
  - id: posts-its-answer
    question: What is the release step?
    expect:
      toolCalls:
        required: [answer.post]
    rationale: The bot has to post its answer.
  - id: closes-the-task
    question: Is the task done?
    expect:
      toolCalls:
        required: [tasks.complete]
    rationale: The bot has to be able to close the task it was given.
`;

type Evals = {
  canRun: boolean;
  latest: { status: string; ok: boolean | null; passed: number; judged: number; trigger: string; results: Array<{ caseId: string; passed: boolean; reasons: string[] }> } | null;
  recent: Array<{ id: string; status: string; trigger: string; ok: boolean | null }>;
};

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a lead runs the set; a worse BOT.md applied through a proposal is flagged below its minimum; a member cannot run', async ({ browser, playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    expect((await applyGuarded(omar, BOT_PATH, botMd('answer.post, tasks.complete'), 'Add the eval demo bot')).status).toBe(201);
    expect((await applyGuarded(omar, `bots/${BOT}/evals/qa.yaml`, SET, 'Add its scenarios')).status).toBe(201);
    const evals = () => omar.get<Evals>(`/api/teams/engineering/bots/${BOT}/evals`);
    const settled = async (pick: (e: Evals) => boolean): Promise<Evals> => {
      await expect.poll(async () => pick(await evals()), { timeout: 30_000 }).toBe(true);
      return evals();
    };
    await settled((e) => e.recent.some((r) => r.status !== 'running') && !e.recent.some((r) => r.status === 'running'));

    // the lead runs it from the tab
    const lead = await openBot(browser, playwright, stack, 'omar', BOT, '?tab=evals');
    try {
      await expect(lead.page.getByTestId('eval-panel')).toBeVisible();
      await lead.page.getByTestId('eval-run').click();
      await expect(lead.page.getByTestId('eval-score')).toHaveText('Eval 2 of 2 passed', { timeout: 30_000 });
      await expect(lead.page.getByTestId('eval-summary')).toContainText('minimum 0.90');
      await expect(lead.page.getByTestId('eval-flag')).toHaveCount(0);
      expect(await noSidewaysScroll(lead.page)).toBe(true);
    } finally {
      await lead.close();
    }

    // a member reads the verdict and is not offered the button; the server refuses them as well
    const member = await openBot(browser, playwright, stack, 'priya', BOT, '?tab=evals');
    try {
      await expect(member.page.getByTestId('eval-score')).toHaveText('Eval 2 of 2 passed', { timeout: 15_000 });
      await expect(member.page.getByTestId('eval-run')).toHaveCount(0);
    } finally {
      await member.close();
    }
    expect(await priya.status('POST', `/api/teams/engineering/bots/${BOT}/evals/run`, {})).toBe(403);

    // a worse definition (the bot can no longer close a task) applied through a proposal runs the set on its own
    const base = await definitionOf(omar, BOT_PATH);
    const before = (await evals()).recent.filter((r) => r.trigger === 'on_commit').length;
    expect((await applyGuarded(omar, BOT_PATH, botMd('answer.post'), 'Take away tasks.complete', { baseBlobSha: base.blobSha })).status).toBe(201);
    const after = await settled((e) => e.recent.filter((r) => r.trigger === 'on_commit').length > before && e.recent[0]?.status !== 'running' && e.recent[0]?.trigger === 'on_commit');
    expect(after.latest).toMatchObject({ trigger: 'on_commit', status: 'finished', ok: false, passed: 1, judged: 2 });
    expect(after.latest?.results.find((r) => !r.passed)?.reasons[0]).toContain('tasks.complete');

    const page = await openBot(browser, playwright, stack, 'omar', BOT, '?tab=evals');
    try {
      await expect(page.page.getByTestId('eval-score')).toHaveText('Eval 1 of 2 passed', { timeout: 15_000 });
      await expect(page.page.getByTestId('eval-flag')).toContainText('Below the minimum score');
      await page.page.getByTestId('eval-view-failures').click();
      const failure = page.page.getByTestId('eval-case');
      await expect(failure).toHaveCount(1);
      await expect(failure).toContainText('closes-the-task');
      await expect(failure).toContainText('tasks.complete');
      expect(await noSidewaysScroll(page.page)).toBe(true);
    } finally {
      await page.close();
    }
  } finally {
    await omar.ctx.dispose();
    await priya.ctx.dispose();
  }
});
