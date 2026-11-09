// R2 (B): an incident is open in #incidents; Rafi asks Brain what the team did last time and opens the source it cites.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, allowChatStateRace, readyForBots } from '../omar/support/index.ts';

const QUESTION = 'The search index is behind again. What did we do in the last indexer incident?';

export default defineJourney({
  id: 'R2',
  persona: 'rafi',
  goal: 'An incident is open: ask Brain what we did last time, and check the source it cites.',
  markers: ['B'],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  steps: [
    {
      id: 'incidents',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async (ctx) => {
        allowChatStateRace(ctx);
        await readyForBots(ctx.stack);
        await ctx.pages.channel.open('incidents');
        await expect(ctx.pages.channel.message('INC-32')).toBeVisible();
      },
    },
    {
      id: 'brain-open',
      expect: TID.chatEmpty,
      next: { testid: TID.chatMain, label: 'Message Brain' },
      run: async ({ pages }) => {
        await pages.brain.open();
      },
    },
    {
      id: 'question-typed',
      expect: TID.chatMain,
      next: { testid: TID.chatMain, label: 'Send with Enter' },
      run: async ({ pages }) => {
        await pages.brain.input.fill(QUESTION);
      },
    },
    {
      id: 'answer',
      expect: TID.answer,
      next: { testid: TID.answerCitation, label: 'Source 1' },
      run: async ({ pages }) => {
        await pages.brain.input.press('Enter');
        await expect(pages.brain.botMessages.last().getByTestId(TID.answerCitation).first()).toBeVisible({ timeout: 90_000 });
        await expect(pages.brain.thinking).toHaveCount(0, { timeout: 30_000 });
      },
    },
    {
      id: 'sources-open',
      expect: TID.answer,
      next: { testid: TID.answerCitation },
      run: async ({ pages }) => {
        await pages.brain.botMessages.last().getByTestId('answer-sources').locator('summary').click();
        await expect(pages.brain.botMessages.last().getByTestId('answer-lineage-row').first()).toBeVisible();
      },
    },
    {
      id: 'source-in-channel',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages, page }) => {
        // on a phone the answer is scrolled under the header by now and the chip cannot be brought into view: the tap is sent to the link itself
        await pages.brain.botMessages.last().getByTestId(TID.answerCitation).first().evaluate((el) => (el as HTMLElement).click());
        await expect(page).toHaveURL(/\/t\/engineering\/c\/[a-z-]+\?message=/);
      },
    },
  ],
  outcome: async ({ stack }) => {
    const rows = await stack.sql<{ cites: string }>(
      `SELECT coalesce(max(jsonb_array_length(m.meta->'answer'->'citations')), 0)::text AS cites FROM app.messages m WHERE m.meta ? 'answer'`,
    );
    expect(Number(rows[0]?.cites), 'the Answer cites at least one source of the incident').toBeGreaterThan(0);
  },
});
