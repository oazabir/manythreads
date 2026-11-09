// T1 · Tariq asks the Content drafter for a post and edits the draft together with a colleague (PLAN block B, marker A): the brief in #content, the draft as a page, then the
// live editor with Priya in it. Hermes behind the Content drafter is the stand-in of support/hermes-tariq.mjs.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { TARIQ_ENV, TEAM, allowKnownNoise, arrangeBot, contentDrafterMd } from './support/index.ts';

const BRIEF = '@content-drafter write a launch announcement for the saved filters on the orders page, for people who check orders every morning.';
const PAGE = 'pages/drafts/launch-announcement.md';
const TARIQ_LINE = 'Tariq: add the date once engineering confirms it.';
const PRIYA_LINE = 'Priya: check the name of the feature with support.';

let colleague: import('@playwright/test').Page | undefined;

export default defineJourney({
  id: 'T1',
  persona: 'tariq',
  goal: 'Ask the Content drafter for a launch announcement, then fix the draft together with a colleague in the live editor.',
  markers: ['A'],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  steps: [
    {
      id: 'content-channel',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Message box' },
      run: async ({ pages, stack, page, api }) => {
        allowKnownNoise(page);
        await arrangeBot(stack, await api('omar'), TEAM, 'content-drafter', contentDrafterMd());
        await pages.inTeam(TEAM).channel.open('content');
      },
    },
    {
      id: 'brief-typed',
      expect: TID.composer,
      next: { testid: TID.send, label: 'Send' },
      composer: true,
      run: async ({ pages }) => {
        const channel = pages.inTeam(TEAM).channel;
        await channel.input.fill(BRIEF);
      },
    },
    {
      id: 'brief-sent',
      expect: TID.message,
      composer: true,
      run: async ({ pages }) => {
        const channel = pages.inTeam(TEAM).channel;
        await channel.input.press('Enter');
        await expect(channel.message('write a launch announcement')).toBeVisible();
      },
    },
    {
      id: 'draft-reply',
      expect: TID.threadView,
      next: { testid: 'go-live', label: 'Live', unchecked: true },
      run: async ({ pages }) => {
        const channel = pages.inTeam(TEAM).channel;
        await expect(channel.message('write a launch announcement')).toContainText(/1 reply/, { timeout: 90_000 });
        const thread = await channel.openThread(channel.message('write a launch announcement'));
        await expect(thread.replies.filter({ hasText: PAGE })).toBeVisible({ timeout: 30_000 });
      },
    },
    {
      id: 'draft-page',
      expect: TID.fileView,
      next: { testid: 'go-live', label: 'Live' },
      run: async ({ page }) => {
        // the file tree folds away at 390 px, so both viewports open the page by its address, the one the bot's reply links to
        await page.goto(`/t/${TEAM}/files?open=${encodeURIComponent(PAGE)}`);
        await expect(page.getByTestId('viewer-markdown').locator('.md-prose h1')).toContainText('Launch announcement');
      },
    },
    {
      id: 'live-editor',
      expect: 'live-page',
      next: { testid: 'leave-live', label: 'Done' },
      run: async ({ page }) => {
        await page.getByTestId('go-live').click();
        await expect(page.getByTestId('live-status')).toHaveText('Live');
        await page.getByLabel('Page source, edited live').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(`\n${TARIQ_LINE}\n`);
      },
    },
    {
      id: 'colleague-joins',
      expect: 'live-people',
      run: async (ctx) => {
        const priya = await ctx.also('priya', `/t/${TEAM}/files?open=${encodeURIComponent(PAGE)}`);
        await priya.page.getByTestId('go-live').click();
        await expect(priya.page.getByTestId('live-status')).toHaveText('Live');
        await priya.page.getByLabel('Page source, edited live').click();
        await priya.page.keyboard.press('Control+End');
        await priya.page.keyboard.type(`${PRIYA_LINE}\n`);
        await expect(ctx.page.getByTestId('live-people')).toContainText('Priya');
        await expect(ctx.page.getByLabel('Page source, edited live')).toHaveValue(new RegExp(PRIYA_LINE));
        // she stays in the page until the next step: Tariq's list of people is only there while she is
        colleague = priya.page;
      },
    },
    {
      id: 'saved-to-history',
      expect: 'viewer-markdown',
      run: async ({ page }) => {
        await colleague?.getByTestId('leave-live').click();
        await page.getByTestId('leave-live').click();
        await expect(page.getByTestId('viewer-markdown').locator('.md-prose')).toContainText(PRIYA_LINE);
      },
    },
  ],
  outcome: async ({ api }) => {
    const tariq = await api('tariq');
    // the page is committed a moment after both of them leave the live editor
    await expect
      .poll(async () => (await tariq.get<{ content: string }>(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(PAGE)}`)).content, { timeout: 30_000, message: 'the saved page' })
      .toContain(PRIYA_LINE);
    const blob = await tariq.get<{ content: string }>(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(PAGE)}`);
    expect(blob.content, 'the draft the bot wrote is still the base').toContain('Launch announcement');
    expect(blob.content, "Tariq's line is in the saved page").toContain(TARIQ_LINE);
  },
});
