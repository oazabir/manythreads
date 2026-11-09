// S2 · Sameera asks Brain how refunds work and opens the source it cites (PLAN block B, marker B). Brain's Hermes is the stand-in of ../nadia/support/hermes-persona.mjs.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOT_STACK_ENV, allowKnownNoise, arrangeBrain } from '../nadia/support/brain.ts';

const TEAM = 'customer-support';
const QUESTION = 'What is our refund policy?';

export default defineJourney({
  id: 'S2',
  persona: 'sameera',
  goal: 'Ask Brain what the refund policy is and open the source it cites so I can quote it to a customer.',
  markers: ['B'],
  start: 'week-2',
  stackEnv: BOT_STACK_ENV,
  steps: [
    {
      id: 'open-brain',
      expect: TID.chatScreen,
      next: { testid: TID.chatMain, label: 'Ask Brain' },
      run: async ({ pages, stack, page }) => {
        allowKnownNoise(page);
        await arrangeBrain(stack, ['What is our refund policy?', 'How fast do we have to reply?']);
        await pages.inTeam(TEAM).brain.open('brain');
        await expect(pages.inTeam(TEAM).brain.input).toBeVisible();
      },
    },
    {
      id: 'question-typed',
      expect: TID.chatScreen,
      composer: true,
      run: async ({ pages }) => {
        await pages.inTeam(TEAM).brain.input.fill(QUESTION);
      },
    },
    {
      id: 'answer',
      expect: TID.answer,
      next: { testid: TID.answerCitation, label: 'A numbered source' },
      composer: true,
      run: async ({ pages }) => {
        const brain = pages.inTeam(TEAM).brain;
        await brain.input.press('Enter');
        await expect(brain.botMessages.first().getByTestId(TID.answer)).toBeVisible({ timeout: 60_000 });
        await expect(brain.thinking).toHaveCount(0, { timeout: 60_000 });
      },
    },
    {
      id: 'sources',
      expect: TID.answerCitations,
      next: { testid: TID.answerCitation, label: 'The source' },
      run: async ({ page }) => {
        const sources = page.getByTestId('answer-sources');
        if ((await sources.count()) > 0) await sources.locator('summary').click();
        await expect(page.getByTestId(TID.answerCitation).first()).toBeVisible();
      },
    },
    {
      id: 'open-source',
      expect: TID.frame,
      run: async ({ page }) => {
        // the first source is a memory item when the memory engine found one, else the message the refund rule was written in (it opens its thread): either opens where it lives
        await page.getByTestId(TID.answerCitation).first().click();
        await expect(page.getByTestId(TID.conceptDetail).or(page.getByTestId(TID.channelView)).or(page.getByTestId(TID.threadView)).or(page.getByTestId(TID.chatScreen)).first(), `the source opened (now at ${page.url()})`).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/refund/i).first()).toBeVisible();
      },
    },
  ],
  outcome: async ({ stack }) => {
    const answers = await stack.sql<{ n: string }>(`select count(*)::text as n from app.messages where meta ? 'answer' and body like 'Refunds up to 30 days%'`);
    expect(Number(answers[0]?.n ?? 0), 'Brain posted the Answer').toBe(1);
  },
});
