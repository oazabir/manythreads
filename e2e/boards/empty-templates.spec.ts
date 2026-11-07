import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * The empty Boards, Jobs and Org chart pages (PLAN P21-15). A team with no board shows three templates (Delivery, Support queue, Content
 * calendar), each with a picture and a button; the button makes a board with that template's columns through the usual create-board call. A
 * team with no job shows three tiles (Heartbeat, Routine, Task) whose Create opens the form already filled in. A member who may not create
 * either sees the same pictures and words with no button. The org chart is a grid of equal columns with a picture on every person and bot.
 * One stack for the file; the specs run in order because the first lead action makes the board the later ones look for.
 */
test.skip(({ isMobile }) => isMobile, 'the tests set their own viewport; the mobile-web project adds nothing');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

let stack: Stack;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  // a team that has never had a board or a job: the seeded Engineering team might gain one from another spec's idea, a team of its own never does
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post('/api/teams', { name: 'Blank Team' });
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

const blankSlug = async (): Promise<string> => (await stack.sql<{ slug: string }>(`SELECT slug FROM app.teams WHERE name = 'Blank Team'`))[0]!.slug;

const noSidewaysScroll = async (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('a lead sees three board templates and starts the Support queue: its five columns appear and stay after a reload', async ({ browser, playwright }) => {
  const slug = await blankSlug();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/${slug}/boards`);
  try {
    await expect(page.getByTestId('boards-empty')).toBeVisible();
    await expect(page.getByTestId('board-template')).toHaveCount(3);
    await expect(page.getByTestId('board-template').locator('h3')).toHaveText(['Delivery', 'Support queue', 'Content calendar']);
    await expect(page.getByTestId('board-template-start')).toHaveCount(3);
    // each card has a picture
    await expect(page.getByTestId('board-template').first().locator('svg')).toHaveCount(1);

    const support = page.locator('[data-testid="board-template"][data-template="support"]');
    await support.getByTestId('board-template-start').click();
    await expect(page.getByTestId('board-view')).toBeVisible();
    await expect(page.getByTestId('board-column')).toHaveCount(5);
    await expect(page.getByTestId('column-name')).toHaveText(['New', 'Being answered', 'Checking', 'Waiting on the customer', 'Solved']);
    await expect(page.getByTestId('board-select').locator('option:checked')).toHaveText(/Support queue/);

    await page.reload();
    await expect(page.getByTestId('board-column')).toHaveCount(5);
    await expect(page.getByTestId('column-name').first()).toHaveText('New');
  } finally {
    await context.close();
  }
});

test('a member of a team with no board sees the page without any start button', async ({ browser, playwright }) => {
  // Marketing has no board in the seeded world, and Priya is a member of it, not a lead
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/marketing/boards');
  try {
    await expect(page.getByTestId('boards-empty')).toBeVisible();
    await expect(page.getByTestId('boards-empty')).toContainText('A team lead or a workspace admin creates the first one');
    await expect(page.getByTestId('board-template-start')).toHaveCount(0);
    await expect(page.getByTestId('create-board')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the three templates fit a phone with no sideways scroll, one under the other', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/teams', { name: 'Blank Phone Team' });
  } finally {
    await api.ctx.dispose();
  }
  const slug = (await stack.sql<{ slug: string }>(`SELECT slug FROM app.teams WHERE name = 'Blank Phone Team'`))[0]!.slug;
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/${slug}/boards`, { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('board-template')).toHaveCount(3);
    expect(await noSidewaysScroll(page)).toBe(true);
    const boxes = await page.getByTestId('board-template').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    expect(new Set(boxes.map((b) => Math.round(b.left))).size).toBe(1);
    expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.bottom - 1);
  } finally {
    await context.close();
  }
});

test('an empty Jobs page shows three tiles; a lead’s Create opens the form already filled in, a member gets no button', async ({ browser, playwright }) => {
  const slug = await blankSlug();
  const lead = await openOn(browser, playwright, stack, 'omar', `/t/${slug}/jobs`);
  try {
    await expect(lead.page.getByTestId('scheduled-jobs-empty')).toBeVisible();
    await expect(lead.page.getByTestId('job-tile')).toHaveCount(3);
    await expect(lead.page.getByTestId('job-tile').locator('h3')).toHaveText(['Heartbeat', 'Routine', 'Task']);
    await expect(lead.page.getByTestId('job-tile-create')).toHaveCount(3);

    await lead.page.locator('[data-testid="job-tile"][data-kind="routine"]').getByTestId('job-tile-create').click();
    await expect(lead.page.getByTestId('new-scheduled-job-form')).toBeVisible();
    await expect(lead.page.getByTestId('scheduled-job-name')).toHaveValue('Weekly numbers');
    await expect(lead.page.getByTestId('scheduled-job-kind')).toHaveValue('routine');
    await expect(lead.page.getByTestId('scheduled-job-schedule')).toHaveValue('0 8 * * mon');
    await expect(lead.page.getByTestId('scheduled-job-contract')).toHaveValue('routines/weekly.yaml');
    // the tile for a heartbeat has no contract fields
    await lead.page.getByRole('button', { name: 'Cancel' }).click();
    await lead.page.locator('[data-testid="job-tile"][data-kind="heartbeat"]').getByTestId('job-tile-create').click();
    await expect(lead.page.getByTestId('scheduled-job-kind')).toHaveValue('heartbeat');
    await expect(lead.page.getByTestId('scheduled-job-contract')).toHaveCount(0);
  } finally {
    await lead.context.close();
  }

  const member = await openOn(browser, playwright, stack, 'priya', '/t/marketing/jobs');
  try {
    await expect(member.page.getByTestId('job-tile')).toHaveCount(3);
    await expect(member.page.getByTestId('job-tile-create')).toHaveCount(0);
  } finally {
    await member.context.close();
  }
});


test('the org chart is a grid: every person and bot has a picture, and the cards of one row are the same size', async ({ browser, playwright }) => {
  const { page: p, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/org');
  try {
    await expect(p.getByTestId('org-chart')).toBeVisible();
    const people = p.getByTestId('org-person');
    await expect(people.first()).toBeVisible();
    // a picture (or the initials disc) sits on every person card and on every bot card
    const naked = await p.locator('[data-testid="org-person"], [data-testid="org-bot"]').evaluateAll((els) => els.filter((e) => e.querySelector('.av') === null).length);
    expect(naked).toBe(0);
    // cards that share a row share a height and a width
    const rows = await p.locator('.bd-org-grid').evaluateAll((grids) =>
      grids.map((g) => {
        const cards = [...g.children].map((c) => c.getBoundingClientRect());
        const byTop = new Map<number, DOMRect[]>();
        for (const r of cards) byTop.set(Math.round(r.top), [...(byTop.get(Math.round(r.top)) ?? []), r]);
        return [...byTop.values()].map((row) => ({ heights: new Set(row.map((r) => Math.round(r.height))).size, widths: new Set(row.map((r) => Math.round(r.width))).size }));
      }),
    );
    for (const band of rows) for (const row of band) expect(row).toEqual({ heights: 1, widths: 1 });
    // a bot with nobody to hand work to says so; one with targets draws an arrow for each
    for (const bot of await p.getByTestId('org-bot').all()) {
      const edges = await bot.locator('.bd-edge').count();
      if (edges === 0) await expect(bot.locator('.bd-edges')).toContainText('Cannot hand work to other bots yet.');
      else await expect(bot.locator('.bd-edge svg')).toHaveCount(edges);
    }
    expect(await noSidewaysScroll(p)).toBe(true);
  } finally {
    await context.close();
  }
});

test('the org chart has no sideways scroll on a phone', async ({ browser, playwright }) => {
  const { page: p, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/org', { viewport: PHONE, mobile: true });
  try {
    await expect(p.getByTestId('org-person').first()).toBeVisible();
    expect(await noSidewaysScroll(p)).toBe(true);
  } finally {
    await context.close();
  }
});
