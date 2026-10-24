import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiAs, openAs } from '../channels/support.ts';

/*
 * The Boards screen (PLAN P6-07/P6-08, SPEC §6.5): the five columns of a saved view, the card panel with its history, the move a drag
 * makes, the freshness rule a code card cannot bypass, and — on their own sidebar entries, not tabs inside Boards — the org chart and
 * Rhythms.
 *
 * The cards are made through the task API as Omar (the lead) and the screen is read and driven as Nadia, a member: what is asserted is
 * what a person gets, not what the API returns. The board is made by the route the screen uses, because the seed has no board yet.
 */

test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const suffix = randomUUID().slice(0, 6);
const contentTitle = `Write the release note ${suffix}`;
const codeTitle = `Fix the redirect ${suffix}`;
let boardId = '';
let contentId = '';
let codeId = '';

type Made = { board: { id: string } };
type Card = { task: { id: string } };

test.beforeAll(async () => {
  const omar = await apiAs('omar');
  try {
    const board = (await omar.post('/api/teams/engineering/boards', { name: `Board ${suffix}` })) as Made;
    boardId = board.board.id;
    const content = (await omar.post('/api/teams/engineering/tasks', {
      title: contentTitle,
      description: 'A content card: there is no commit to test.',
      kind: 'content',
      priority: 'high',
      branch: `task/note-${suffix}`,
    })) as Card;
    contentId = content.task.id;
    const code = (await omar.post('/api/teams/engineering/tasks', {
      title: codeTitle,
      description: '',
      kind: 'code',
      priority: 'normal',
      branch: `task/fix-${suffix}`,
    })) as Card;
    codeId = code.task.id;
  } finally {
    await omar.ctx.dispose();
  }
});

const cardIn = (page: import('@playwright/test').Page, column: string, id: string) =>
  page.locator(`[data-testid="board-column"][data-state="${column}"] [data-testid="board-card"][data-task="${id}"]`);

test('the saved view draws its five columns and the cards in them', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'nadia', `/t/engineering/boards?board=${boardId}`);
  try {
    await expect(page.getByTestId('boards-screen')).toBeVisible();
    await expect(page.getByTestId('board-column')).toHaveCount(5);
    await expect(page.getByTestId('board-column')).toContainText(['Open', 'In progress', 'Verify', 'Waiting on a person', 'Done']);
    await expect(cardIn(page, 'open', contentId)).toContainText(contentTitle);
    await expect(cardIn(page, 'open', codeId)).toContainText(codeTitle);
    // the sidebar entry is the way back to it
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Boards/ }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/boards$/);
    await expect(page.getByTestId('boards-screen')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('claiming a card starts it, a move follows the rules, and the history says so', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'nadia', `/t/engineering/boards?board=${boardId}&card=${contentId}`);
  try {
    await expect(page.getByTestId('card-panel')).toBeVisible();
    await expect(page.getByTestId('card-title')).toHaveText(contentTitle);
    await expect(page.getByTestId('card-owner')).toHaveText('nobody yet');
    await expect(page.getByTestId('card-history')).toContainText('created the card');

    // claiming is taking the work up: the card starts, it does not stay in Open
    await page.getByTestId('card-claim').click();
    await expect(page.getByTestId('card-owner')).toHaveText('Nadia');
    await expect(page.getByTestId('card-history')).toContainText('claimed it');
    await expect(cardIn(page, 'in_progress', contentId)).toBeVisible();
    await expect(cardIn(page, 'open', contentId)).toHaveCount(0);

    // the same request a drag sends: the board's own move route
    await page.getByTestId('card-move-target').selectOption('verify');
    await page.getByTestId('card-move').click();
    await expect(cardIn(page, 'verify', contentId)).toBeVisible();
    await expect(page.getByTestId('card-history')).toContainText('In progress → Verify');
  } finally {
    await context.close();
  }
});

test('a code card cannot reach Done without its tested commit, on the screen or at the route', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'nadia', `/t/engineering/boards?board=${boardId}&card=${codeId}`);
  try {
    // the screen does not offer the move the rule refuses
    const targets = await page.getByTestId('card-move-target').locator('option').allTextContents();
    expect(targets).not.toContain('Done');

    // and the route refuses it in its own words, whatever a client sends
    const nadia = await apiAs('nadia');
    try {
      const res = await nadia.ctx.post(`/api/teams/engineering/boards/${boardId}/move`, {
        data: { taskId: codeId, to: 'done' },
        headers: await nadia.headers(),
      });
      expect(res.status()).toBe(409);
      expect(await res.text()).toContain('tested');
    } finally {
      await nadia.ctx.dispose();
    }

    // completing it with the sha that was tested is the path the rules leave open
    await page.getByTestId('card-claim').click();
    await expect(page.getByTestId('card-owner')).toHaveText('Nadia');
    await page.getByTestId('card-tested-sha').fill('abcdef1');
    await page.getByTestId('card-note').fill('the suite is green');
    await page.getByTestId('card-complete').click();
    await expect(cardIn(page, 'done', codeId)).toBeVisible();
    await expect(page.getByTestId('card-history')).toContainText('completed it, tested at abcdef1');
  } finally {
    await context.close();
  }
});

test('the org chart has its own page, and puts the lead above the member', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'nadia', '/t/engineering/org');
  try {
    await expect(page.getByTestId('org-screen')).toBeVisible();
    await expect(page.getByTestId('org-chart')).toBeVisible();
    await expect(page.getByTestId('org-leads')).toContainText('Omar');
    await expect(page.getByTestId('org-members')).toContainText('Nadia');
    await expect(page.getByTestId('org-count')).toContainText('1 lead');
    // the sidebar entry is where it lives now, and Boards no longer carries it as a tab
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Org chart/ }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/org$/);
    await page.goto(`/t/engineering/boards?board=${boardId}`);
    await expect(page.getByTestId('boards-screen')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Rhythms has its own page, and only a lead may add one', async ({ browser }) => {
  const nadia = await openAs(browser, 'nadia', '/t/engineering/rhythms');
  try {
    await expect(nadia.page.getByTestId('rhythms-screen')).toBeVisible();
    await expect(nadia.page.getByTestId('rhythms')).toBeVisible();
    await expect(nadia.page.getByTestId('new-rhythm')).toHaveCount(0);
    await expect(nadia.page.getByTestId('rhythms')).toContainText('A lead saves a new one');
  } finally {
    await nadia.context.close();
  }
  const omar = await openAs(browser, 'omar', '/t/engineering/rhythms');
  try {
    await omar.page.getByTestId('new-rhythm').click();
    await expect(omar.page.getByTestId('new-rhythm-form')).toBeVisible();
    await expect(omar.page.getByTestId('rhythm-cron-note')).toContainText('Next run');
    await expect(omar.page.getByTestId('rhythm-kind')).toHaveValue('heartbeat');
    // it is a page of its own, so it can be linked to and survives a reload
    await expect(omar.page).toHaveURL(/\/t\/engineering\/rhythms$/);
    await omar.page.reload();
    await expect(omar.page.getByTestId('rhythms-screen')).toBeVisible();
  } finally {
    await omar.context.close();
  }
});
