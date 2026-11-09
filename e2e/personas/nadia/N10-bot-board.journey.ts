// N10 · Nadia asks the orchestrating bot in #dev for a small change (PLAN §4, P10-16): the channel header gains a Bot Board link, the bot's cards for the run are on it, and a second
// request in the same channel lands on the same board. The seeded Engineering team has no Orchestrator, so Coder (re-committed with the two tools) plays it; the Hermes behind it is the
// stand-in of ./support/hermes-persona.mjs, which calls boards.ensure and tasks.create through the run's own door like the real one. The platform parts (board, cards, link) are real.
// Not shown: the cards moving column by column as Coder, Reviewer, Tester, Deployer and Browser tester hand them on (that needs the whole chain of bots; E33 keeps it out).
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOT_STACK_ENV, allowKnownNoise, arrangeBot, talkingBotMd } from './support/brain.ts';

const FIRST = '@coder orchestrate: add a Reset filters button to the search page';
const SECOND = '@coder orchestrate: show the number of results above the search list';

export default defineJourney({
  id: 'N10',
  persona: 'nadia',
  goal: 'Ask for a small change in #dev, find the cards of the bots on the channel\'s Bot Board, and see that a second request uses the same board.',
  markers: ['A'],
  start: 'week-2',
  stackEnv: BOT_STACK_ENV,
  steps: [
    {
      id: 'open-dev',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Message box' },
      run: async ({ pages, stack, page, api }) => {
        allowKnownNoise(page);
        await arrangeBot(
          stack,
          await api('omar'),
          'engineering',
          'coder',
          talkingBotMd('Coder', 'Writes, tests and ships a change; makes the cards for it on the Bot Board', ['mention'], undefined, ['boards.ensure', 'tasks.create']),
        );
        await pages.channel.open('dev');
        await expect(page.getByTestId(TID.botBoardLink), 'no board before the first request').toHaveCount(0);
      },
    },
    {
      id: 'request-typed',
      expect: TID.channelView,
      composer: true,
      run: async ({ pages }) => {
        await pages.channel.input.fill(FIRST);
      },
    },
    {
      id: 'board-link-appears',
      expect: TID.channelView,
      next: { testid: TID.botBoardLink, label: 'Bot Board' },
      composer: true,
      run: async ({ pages, page }) => {
        await pages.channel.input.press('Enter');
        await expect(pages.channel.message('Reset filters button').first()).toBeVisible();
        await expect(page.getByTestId(TID.botBoardLink)).toBeVisible({ timeout: 90_000 });
      },
    },
    {
      id: 'bot-board',
      expect: TID.boardView,
      next: { testid: TID.boardCard, label: 'A card' },
      run: async ({ pages, page }) => {
        await page.getByTestId(TID.botBoardLink).click();
        await expect(page.getByTestId('board-select').locator('option:checked')).toContainText('Bot Board');
        await expect(pages.boards.cards().filter({ hasText: 'Reset filters' }), 'the cards of the first request').toHaveCount(5, { timeout: 60_000 });
      },
    },
    {
      id: 'card-opened',
      expect: TID.cardPanel,
      run: async ({ pages }) => {
        await pages.boards.openCard(/Review: add a Reset filters button/);
      },
    },
    {
      id: 'second-request',
      expect: TID.boardView,
      composer: true,
      run: async ({ pages, page, stack }) => {
        await pages.channel.open('dev');
        await pages.channel.input.fill(SECOND);
        await pages.channel.input.press('Enter');
        await expect(pages.channel.message('number of results').first()).toBeVisible();
        await expect(page.getByTestId(TID.botBoardLink)).toHaveCount(1);
        await expect.poll(async () => Number((await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.tasks WHERE title LIKE '%number of results%'`))[0]?.n), { timeout: 90_000 }).toBe(5);
        await pages.channel.open('dev');
        await page.getByTestId(TID.botBoardLink).click();
        await expect(pages.boards.cards().filter({ hasText: /Reset filters|number of results/ }), 'the cards of both requests').toHaveCount(10, { timeout: 60_000 });
      },
    },
  ],
  outcome: async ({ stack }) => {
    const boards = await stack.sql<{ id: string }>(
      `SELECT b.id FROM app.boards b JOIN app.channels c ON c.id = b.channel_id WHERE c.name = 'dev' AND b.name = 'Bot Board'`,
    );
    expect(boards.length, 'one Bot Board for #dev, made once').toBe(1);
    const cards = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.tasks WHERE board_id = $1::uuid AND (title LIKE '%Reset filters%' OR title LIKE '%number of results%')`, [boards[0]!.id]);
    expect(Number(cards[0]?.n), 'five cards for each of the two requests, all on that board').toBe(10);
  },
});
