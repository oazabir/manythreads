// N2 · Nadia asks Brain what the team decided about the cache TTL, reads the sources, then hands the answer to Coder (PLAN block B, markers B and A).
// The Hermes behind Brain and Coder is the stand-in of support/hermes-persona.mjs: the platform runs, reads sources and posts the Answer for real, only the model is missing.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOT_STACK_ENV, allowKnownNoise, arrangeBot, arrangeBrain, talkingBotMd } from './support/brain.ts';

const QUESTION = 'What did we decide about the cache TTL?';

export default defineJourney({
  id: 'N2',
  persona: 'nadia',
  goal: 'Find out what we decided about the cache TTL, check where the answer comes from, and give it to Coder.',
  markers: ['B', 'A'],
  start: 'week-2',
  stackEnv: BOT_STACK_ENV,
  steps: [
    {
      id: 'open-brain',
      expect: TID.chatScreen,
      next: { testid: TID.chatMain, label: 'Ask Brain' },
      run: async ({ pages, stack, page, api }) => {
        allowKnownNoise(page);
        await arrangeBot(stack, await api('omar'), 'engineering', 'coder', talkingBotMd('Coder', 'Writes and reviews code changes for the Engineering team', ['mention', 'conversation']));
        await arrangeBrain(stack, ['What did we decide about the cache TTL?', 'What is blocking the release?']);
        await pages.brain.open('brain');
        await expect(pages.brain.input).toBeVisible();
      },
    },
    {
      id: 'question-typed',
      expect: TID.chatScreen,
      composer: true,
      run: async ({ pages }) => {
        await pages.brain.input.fill(QUESTION);
      },
    },
    {
      id: 'answer',
      expect: TID.answer,
      next: { testid: TID.answerCitation, label: 'A numbered source' },
      composer: true,
      run: async ({ pages }) => {
        await pages.brain.input.press('Enter');
        await expect(pages.brain.botMessages.first().getByTestId(TID.answer)).toBeVisible({ timeout: 60_000 });
        await expect(pages.brain.thinking).toHaveCount(0, { timeout: 60_000 });
      },
    },
    {
      id: 'sources',
      expect: TID.answerCitations,
      next: { testid: 'answer-chips', label: 'Hand to a bot' },
      run: async ({ page }) => {
        const sources = page.getByTestId('answer-sources');
        if ((await sources.count()) > 0) await sources.locator('summary').click();
        await expect(page.getByTestId(TID.answerCitation).first()).toBeVisible();
      },
    },
    {
      id: 'hand-to-coder',
      expect: TID.conversationView,
      run: async ({ page }) => {
        await page.getByTestId('answer-chips').locator('[data-bot="coder"]').click();
        await expect(page).toHaveURL(/\/bots\/coder\/chat/);
        await expect(page.getByTestId(TID.message).first()).toBeVisible({ timeout: 30_000 });
      },
    },
    {
      id: 'coder-replies',
      expect: TID.conversationView,
      run: async ({ page }) => {
        await expect(page.getByTestId(TID.message).filter({ hasText: 'Got it. I have the answer' }).first()).toBeVisible({ timeout: 60_000 });
      },
    },
  ],
  outcome: async ({ stack }) => {
    const answers = await stack.sql<{ n: string }>(`select count(*)::text as n from app.messages where meta ? 'answer' and body like 'The team agreed to lower the search cache TTL%'`);
    expect(Number(answers[0]?.n ?? 0), 'Brain posted one Answer').toBe(1);
    const coder = await stack.sql<{ n: string }>(
      `select count(*)::text as n from app.bot_runs r join app.bots b on b.id = r.bot_id where b.slug = 'coder' and r.status = 'done'`,
    );
    expect(Number(coder[0]?.n ?? 0), 'Coder answered the handed-over question').toBeGreaterThanOrEqual(1);
  },
});
