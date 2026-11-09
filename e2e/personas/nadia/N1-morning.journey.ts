// N1 · Nadia's morning (PLAN block B): the Threads inbox, the channel where the release is planned, the thread panel on the Deploy plan, a reply.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';

const REPLY = 'Morning. Canary dashboards are open, I will post in #releases when it starts.';

export default defineJourney({
  id: 'N1',
  persona: 'nadia',
  goal: 'Start my day: see which threads I follow, read the Deploy plan thread in #dev and answer in it.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'threads-inbox',
      expect: TID.threadsInbox,
      next: { testid: 'thread-row', label: 'A thread I follow' },
      run: async ({ pages }) => {
        await pages.threads.open();
      },
    },
    {
      id: 'deploy-plan-thread',
      expect: TID.threadView,
      next: { testid: TID.composer, label: 'Reply box' },
      run: async ({ page }) => {
        await page.getByTestId('thread-row').filter({ hasText: 'Deploy plan' }).first().click();
        await expect(page.getByTestId(TID.threadView).getByTestId(TID.message).first()).toBeVisible();
      },
    },
    {
      id: 'reply',
      expect: TID.threadView,
      composer: true,
      run: async ({ pages }) => {
        await pages.thread.reply(REPLY);
      },
    },
    {
      id: 'open-dev',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Message box' },
      run: async ({ pages }) => {
        await pages.channel.open('dev');
      },
    },
    {
      id: 'releases-channel',
      expect: TID.channelView,
      run: async ({ pages }) => {
        await pages.channel.open('releases');
      },
    },
  ],
  outcome: async ({ stack }) => {
    const rows = await stack.sql<{ n: string }>("select count(*)::text as n from app.messages where body = $1 and thread_root_id is not null", [REPLY]);
    expect(Number(rows[0]?.n ?? 0), 'Nadia\'s reply sits inside the Deploy plan thread').toBe(1);
  },
});
