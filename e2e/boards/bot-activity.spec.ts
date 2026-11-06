import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, type StackApi } from '../support/stack-browser.ts';

/*
 * The bot icon on a card (PLAN P6-13): a card with a bot run in progress wears an icon whose label names the bot; it moves when the run
 * ends, with no reload (the server's hint push makes the board read again); with reduced motion it is still and has a ring. The run row
 * is written straight into the database, as the run service would, because a real bot run needs a model.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

let stack: Stack;
let omar: StackApi;
let boardId = '';
let cardId = '';
let botId = '';
let runId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  boardId = (await omar.post<{ board: { id: string } }>('/api/teams/engineering/boards', { name: 'Activity board' })).board.id;
  cardId = (await omar.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title: 'Plan the rota', description: '', kind: 'other', priority: 'normal', branch: 'task/plan' })).task.id;
  const [team] = await stack.sql<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM app.teams WHERE slug = 'engineering'`);
  botId = randomUUID();
  const actorId = randomUUID();
  await stack.sql(
    `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, 'icon-bot', 'Icon bot', 'agent', 'hermes', 'team', $4, 'active')`,
    [botId, team!.workspace_id, team!.id, 'a'.repeat(64)],
  );
  await stack.sql(`INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [actorId, team!.workspace_id, botId]);
  await stack.sql(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team!.id, actorId, team!.workspace_id]);
  runId = (
    await stack.sql<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, task_id) VALUES ($1, $2, $3, 'task_assigned', 'running', $4) RETURNING id`,
      [team!.workspace_id, botId, team!.id, cardId],
    )
  )[0]!.id;
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('a running bot shows on the card and in the panel, still with a ring under reduced motion, and goes when the run ends', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${boardId}&card=${cardId}`);
  try {
    const onCard = page.locator(`[data-testid="board-card"][data-task="${cardId}"] [data-testid="bot-activity"]`);
    await expect(onCard).toHaveAccessibleName('Icon bot is working on this');
    await expect(page.getByTestId('card-panel').getByTestId('bot-activity')).toBeVisible();

    // openOn asks for reduced motion: still, with a ring
    expect(await onCard.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await onCard.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await onCard.evaluate((el) => getComputedStyle(el).animationName)).toBe('bd-bot-pulse');

    // the run ends: the board read again on the push hint, no reload (the stack's run service is not involved, so ask the page to look again)
    await stack.sql(`UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1`, [runId]);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(onCard).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});
