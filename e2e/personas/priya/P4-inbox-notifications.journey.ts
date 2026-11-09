// P4: the Threads inbox and the bell. A colleague mentions Priya, the bell counts it, the notification opens the message.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LOCAL, channelId, say } from '../omar/support/index.ts';

const MENTION = '@priya the new canary dashboard link is under "Watching a deploy" in the runbook.';

export default defineJourney({
  id: 'P4',
  persona: 'priya',
  goal: 'See what is waiting for me: the threads I follow and the things that mention me.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'threads-inbox',
      expect: TID.threadsInbox,
      next: { testid: LOCAL.bell, label: 'Notifications' },
      run: async (ctx) => {
        // she follows the thread of the stand-up announcement, and a colleague answers in it: that is what the inbox shows
        const dev = await channelId(ctx, 'priya', 'dev');
        const api = await ctx.api('priya');
        const threads = await api.get<{ items: Array<{ rootMessageId: string }> }>('/api/teams/engineering/threads?tab=unread');
        void threads;
        const rows = await ctx.stack.sql<{ id: string }>(`SELECT m.id FROM app.messages m WHERE m.channel_id = $1 AND m.thread_root_id IS NULL AND m.body LIKE '%flag%' ORDER BY m.created_at LIMIT 1`, [dev]);
        const root = rows[0]?.id;
        expect(root, 'a message in #dev about the flag').toBeTruthy();
        await say(ctx, 'priya', dev, 'I will read the flag notes tomorrow.', root!);
        await say(ctx, 'nadia', dev, 'Good. The flag notes are in the wiki under Releases.', root!);
        await ctx.pages.threads.open();
      },
    },
    {
      id: 'thread-row-opened',
      expect: TID.threadView,
      next: { testid: TID.composer, label: 'Reply' },
      run: async ({ page }) => {
        await page.getByTestId(LOCAL.threadRow).first().click();
        await expect(page.getByTestId(TID.threadView)).toBeVisible();
      },
    },
    {
      id: 'mention-arrives',
      expect: LOCAL.bellCount,
      next: { testid: LOCAL.bell, label: 'Notifications' },
      run: async (ctx) => {
        const dev = await channelId(ctx, 'nadia', 'dev');
        await say(ctx, 'nadia', dev, MENTION);
        await ctx.pages.threads.open();
        await expect(ctx.page.getByTestId(LOCAL.bellCount)).toBeVisible({ timeout: 30_000 });
      },
    },
    {
      id: 'bell-open',
      expect: LOCAL.notifications,
      next: { testid: LOCAL.notificationOpen, label: 'Open' },
      run: async ({ page }) => {
        await page.getByTestId(LOCAL.bell).click();
        await expect(page.getByTestId(LOCAL.notification).first()).toBeVisible();
      },
    },
    {
      id: 'mention-opened',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ page }) => {
        await page.getByTestId(LOCAL.notification).filter({ hasText: /canary dashboard/ }).first().click();
        await expect(page.getByTestId(TID.message).filter({ hasText: 'canary dashboard link' }).first()).toBeVisible();
      },
    },
  ],
  outcome: async ({ api }) => {
    const priya = await api('priya');
    const mine = await priya.get<{ items: unknown[] }>('/api/teams/engineering/threads?tab=followed');
    expect(mine.items.length, 'the thread she answered is in her inbox').toBeGreaterThan(0);
  },
});
