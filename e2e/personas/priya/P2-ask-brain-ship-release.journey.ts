// P2 (B, A): Priya, new to the team, asks Brain how a release is shipped, opens the source it cites, and reads Coder's release post and follows its thread.
// B: the Answer is cited with sources she may open. A: Coder (acting bot) posted the release post after Nadia asked it in #releases.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, allowChatStateRace, channelId, grantTools, readyForBots, say } from '../omar/support/index.ts';

const QUESTION = 'How do we ship a release?';
const ASK_CODER = '@coder write the release post for v2.14.0: search cache TTL change, canary first, then promote.';

export default defineJourney({
  id: 'P2',
  persona: 'priya',
  goal: 'Ask Brain how we ship a release, open the source it cites, and read the release post Coder wrote.',
  markers: ['B', 'A'],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  steps: [
    {
      id: 'brain-empty',
      expect: TID.chatEmpty,
      next: { testid: TID.chatMain, label: 'Message Brain' },
      run: async (ctx) => {
        allowChatStateRace(ctx);
        await readyForBots(ctx.stack);
        await grantTools(ctx.stack, 'coder', ['messages.search', 'messages.post', 'answer.post']);
        // Nadia asks Coder for the release post in #releases while Priya is still finding her way: the bot's reply is there when she gets to the channel.
        const releases = await channelId(ctx, 'nadia', 'releases');
        await say(ctx, 'nadia', releases, ASK_CODER);
        await ctx.pages.brain.open();
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
      id: 'source-opened',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages, page }) => {
        await pages.brain.botMessages.last().getByTestId(TID.answerCitation).first().click();
        await expect(page).toHaveURL(/\/t\/engineering\/c\/[a-z0-9-]+\?message=/);
      },
    },
    {
      id: 'coder-release-post',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages }) => {
        await pages.channel.open('releases');
        // Coder's reply is in the thread of Nadia's request
        const request = pages.channel.message('write the release post for v2.14.0');
        await expect(request).toBeVisible();
        await expect(request).toContainText(/1 reply/, { timeout: 60_000 });
      },
    },
    {
      id: 'thread-followed',
      expect: TID.threadView,
      next: { testid: TID.composer, label: 'Reply in thread' },
      run: async ({ pages, page }) => {
        const request = pages.channel.message('write the release post for v2.14.0');
        const thread = await pages.channel.openThread(request);
        await expect(thread.replies).toHaveCount(2, { timeout: 60_000 });
        const follow = page.getByRole('switch', { name: 'Follow thread' });
        if ((await follow.getAttribute('aria-checked')) !== 'true') await follow.click();
        await expect(page.getByTestId('follow-state')).toContainText('Following');
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const priya = await api('priya');
    const answered = await stack.sql<{ n: string; cites: string }>(
      `SELECT count(*)::text AS n, coalesce(max(jsonb_array_length(m.meta->'answer'->'citations')), 0)::text AS cites
         FROM app.messages m WHERE m.meta ? 'answer' AND m.meta->'answer'->>'answeredFor' IS NOT NULL`,
    );
    expect(Number(answered[0]?.n ?? 0), 'Brain posted an Answer').toBeGreaterThan(0);
    expect(Number(answered[0]?.cites ?? 0), 'the Answer cites at least one source').toBeGreaterThan(0);
    const followed = await priya.get<{ items: Array<{ followed: boolean }> }>('/api/teams/engineering/threads?tab=followed');
    expect(followed.items.length, 'Priya follows the release thread').toBeGreaterThan(0);
  },
});
