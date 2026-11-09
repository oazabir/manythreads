// L2 · Lena reads what the bots said in #releases (PLAN block B, markers B and A; her contact with bots is read-only, SPEC §6.3): a release post that Coder wrote when Nadia asked,
// and a Brain answer Nadia shared into the channel with the source from a private room masked. Search finds only #releases.
// Before the first picture the part of the story that is not Lena's happens in other windows through the real screens: Nadia asks Coder, asks Brain and shares the answer.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LENA_ENV, allowKnownNoise, channelId, grantTools, messageWith, readyForBots, say } from './support/index.ts';

const ASK_CODER = '@coder write the release post for v2.14.0: search cache TTL change, canary first, then promote.';
const PUBLIC_LINE = 'Rollback test for v2.11.0 passed on staging%';
const PRIVATE_LINE = 'Good. Keep the on-call expectation realistic%';
const PRIVATE_WORDS = 'on-call expectation realistic';

export default defineJourney({
  id: 'L2',
  persona: 'lena',
  goal: 'Read the release post Coder wrote and the answer Nadia shared with the team, and find them again by searching.',
  markers: ['B', 'A'],
  start: 'week-2',
  stackEnv: LENA_ENV,
  steps: [
    {
      id: 'releases-channel',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async (ctx) => {
        allowKnownNoise(ctx.page);
        await readyForBots(ctx.stack);
        await grantTools(ctx.stack, 'coder', ['messages.search', 'messages.post', 'answer.post']);
        const releases = await channelId(ctx, 'nadia', 'releases');
        // Nadia asks Coder for the release post, in the channel
        await say(ctx, 'nadia', releases, ASK_CODER);
        // Nadia asks Brain, citing a line of #releases and a line of the private #eng-leads, and shares the answer into #releases
        const publicId = await messageWith(ctx.stack, PUBLIC_LINE);
        const privateId = await messageWith(ctx.stack, PRIVATE_LINE);
        const nadia = await ctx.also('nadia', '/t/engineering/chat?bot=brain');
        const brain = nadia.pages.brain;
        await expect(brain.input).toBeVisible();
        const answer = await brain.ask(`ANSWER-WITH-SOURCES ${publicId} ${privateId} SEARCH rollback; ${PRIVATE_WORDS}`, { timeoutMs: 90_000 });
        await expect(answer.getByTestId(TID.answer)).toBeVisible();
        await nadia.page.getByTestId('answer-share-open').click();
        await nadia.page.getByTestId('answer-share-target').selectOption({ label: '# releases · Engineering' });
        await expect(nadia.page.getByTestId('answer-share-item').nth(1)).toHaveAttribute('data-status', 'masked');
        await nadia.page.getByTestId('answer-share-confirm').click();
        await expect(nadia.page.getByTestId('answer-share-done')).toContainText('Shared to # releases.');
        // Lena opens the channel
        await ctx.pages.channel.open('releases');
        await expect(ctx.pages.channel.message(/write the release post/)).toBeVisible();
      },
    },
    {
      id: 'coder-release-post',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages, page }) => {
        // Coder's reply is in the thread of Nadia's request; a guest may open a thread to read it, never to answer
        const request = pages.channel.message('write the release post for v2.14.0');
        const replies = request.getByRole('button', { name: /repl(y|ies)/ });
        await expect(replies).toBeVisible({ timeout: 60_000 });
        await replies.click();
        const thread = page.getByTestId(TID.threadView);
        await expect(thread).toBeVisible();
        const post = thread.getByTestId(TID.message).filter({ hasText: /deploy rollback v2\.13\.2/ }).first();
        await expect(post).toBeVisible({ timeout: 30_000 });
        await expect(post).toContainText('canary');
        await expect(thread.getByText('You can read this thread but not reply.')).toBeVisible();
      },
    },
    {
      id: 'shared-answer',
      expect: TID.answer,
      next: { testid: TID.answerCitation, label: 'A source' },
      run: async ({ pages, page }) => {
        // the thread of the last step covers the channel at 390 px: close it (the Back arrow there, "Close panel" on the wide screen)
        const leave = page.getByRole('button', { name: /^(Close panel|Back to the channel)$/ });
        if (await leave.count()) await leave.first().click();
        const shared = pages.channel.messages.filter({ has: pages.page.getByTestId(TID.answer) }).first();
        await expect(shared).toBeVisible({ timeout: 30_000 });
        await shared.scrollIntoViewIfNeeded();
        await expect(shared).toContainText('canary at 10%');
        await expect(shared.getByTestId('answer-share-note')).toContainText('Shared by Nadia');
      },
    },
    {
      id: 'masked-source',
      expect: TID.answerCitations,
      run: async ({ pages, page }) => {
        const shared = pages.channel.messages.filter({ has: page.getByTestId(TID.answer) }).first();
        const sources = shared.getByTestId('answer-sources');
        if ((await sources.count()) > 0) await sources.locator('summary').click();
        await expect(shared.locator('[data-testid="answer-citation"][data-kind="masked"]')).toContainText('not shared');
        await expect(shared.locator('[data-testid="answer-citation"][data-kind="message"]')).toContainText('Rollback test');
        await expect(page.locator('body')).not.toContainText('on-call expectation');
        // nothing to act on: no share button, no hand-off chip
        await expect(shared.getByTestId('answer-share-open')).toHaveCount(0);
        await expect(shared.getByTestId('answer-chips').locator('[data-bot]')).toHaveCount(0);
      },
    },
    {
      id: 'search-releases-only',
      expect: TID.searchResults,
      next: { testid: TID.searchHit, label: 'A hit in #releases' },
      run: async ({ pages }) => {
        await pages.search.open('rollback');
        await expect(pages.search.hits.first()).toBeVisible();
        const texts = await pages.search.hits.evaluateAll((els) => els.map((e) => e.textContent ?? ''));
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) expect(text, 'a hit from a channel she was not given').not.toMatch(/#dev|#incidents|#general|#alerts|#eng-leads|on-call expectation/);
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const lena = await api('lena');
    const releases = (await lena.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels')).groups
      .flatMap((g) => g.channels)
      .find((c) => c.name.replace(/^#/, '') === 'releases')!;
    const list = await lena.get<{ items?: Array<{ body?: string }>; messages?: Array<{ body?: string }> }>(`/api/channels/${releases.id}/messages`);
    const bodies = (list.items ?? list.messages ?? []).map((m) => m.body ?? '');
    expect(bodies.join('\n'), 'the private line never reaches her through the channel').not.toContain('on-call expectation');
    const shared = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages WHERE meta ? 'answer' AND channel_id = $1`, [releases.id]);
    expect(Number(shared[0]?.n), 'the answer was shared into #releases').toBe(1);
    const coder = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = 'coder' AND r.status = 'done'`);
    expect(Number(coder[0]?.n), 'Coder wrote the post').toBeGreaterThanOrEqual(1);
  },
});
