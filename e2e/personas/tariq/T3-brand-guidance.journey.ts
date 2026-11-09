// T3 · Tariq asks Brain for the brand voice and keeps the answer as a page for the team (PLAN block B, marker B; SPEC §6.4 "Save as page"). Brain's Hermes is the stand-in of
// support/hermes-tariq.mjs: it reads the team's #brand channel for real and cites what it finds.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { TARIQ_ENV, TEAM, allowKnownNoise, arrangeBrain } from './support/index.ts';

const QUESTION = 'What is our brand voice?';

export default defineJourney({
  id: 'T3',
  persona: 'tariq',
  goal: 'Ask Brain how our brand voice is meant to sound, check where the answer comes from, and save it as a page the team can open.',
  markers: ['B'],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  steps: [
    {
      id: 'brain-empty',
      expect: TID.chatEmpty,
      next: { testid: TID.chatMain, label: 'Message Brain' },
      run: async ({ pages, stack, page }) => {
        allowKnownNoise(page);
        await arrangeBrain(stack, [QUESTION, 'Which words do we avoid?']);
        await pages.inTeam(TEAM).brain.open('brain');
        await expect(pages.inTeam(TEAM).brain.input).toBeVisible();
      },
    },
    {
      id: 'question-typed',
      expect: TID.chatMain,
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
        await expect(brain.botMessages.first().getByTestId(TID.answer)).toBeVisible({ timeout: 90_000 });
        await expect(brain.thinking).toHaveCount(0, { timeout: 60_000 });
      },
    },
    {
      id: 'sources',
      expect: TID.answerCitations,
      next: { testid: 'answer-save-open', label: 'Save as page' },
      run: async ({ page }) => {
        const sources = page.getByTestId('answer-sources');
        if ((await sources.count()) > 0) await sources.locator('summary').click();
        await expect(page.getByTestId(TID.answerCitation).first()).toContainText(/voice/i);
      },
    },
    {
      id: 'save-as-page',
      expect: 'answer-share-dialog',
      next: { testid: 'answer-share-confirm', label: 'Save' },
      run: async ({ page }) => {
        await page.getByTestId('answer-save-open').click();
        await expect(page.getByTestId('answer-save-where')).toContainText('pages/answers/');
      },
    },
    {
      id: 'page-saved',
      expect: 'answer-share-done',
      next: { testid: 'answer-share-done', label: 'Open page' },
      run: async ({ page }) => {
        await page.getByTestId('answer-share-confirm').click();
        await expect(page.getByTestId('answer-share-done')).toContainText('Saved as a page.');
      },
    },
    {
      id: 'page-opened',
      expect: TID.fileView,
      run: async ({ page }) => {
        await page.getByRole('link', { name: 'Open page' }).click();
        await expect(page).toHaveURL(/\/t\/marketing\/files\?open=pages%2Fanswers%2F/);
        await expect(page.getByTestId('viewer-markdown')).toContainText('plain, specific and a little dry');
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const answers = await stack.sql<{ n: string; cites: string }>(
      `SELECT count(*)::text AS n, coalesce(max(jsonb_array_length(m.meta->'answer'->'citations')), 0)::text AS cites FROM app.messages m WHERE m.meta ? 'answer' AND m.body LIKE 'The voice is plain%'`,
    );
    expect(Number(answers[0]?.n), 'Brain posted one Answer').toBe(1);
    expect(Number(answers[0]?.cites), 'the Answer cites the #brand channel').toBeGreaterThanOrEqual(1);
    const priya = await api('priya');
    const tree = await priya.get<{ entries?: Array<{ path: string }>; items?: Array<{ path: string }> }>(`/api/teams/${TEAM}/repo/tree?path=${encodeURIComponent('pages/answers')}`);
    const saved = (tree.entries ?? tree.items ?? []).map((e) => e.path);
    expect(saved.some((p) => p.startsWith('pages/answers/')), 'the page is in the team\'s pages for a colleague too').toBe(true);
  },
});
