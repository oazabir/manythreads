// P1: Priya's first day. The welcome card and its two steps (she is already in #general), following a thread, and the switcher between her two teams (Engineering, Marketing).
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LOCAL } from '../omar/support/index.ts';

export default defineJourney({
  id: 'P1',
  persona: 'priya',
  goal: 'Find my way on the first day: read #general, follow a thread, and move between my two teams.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'welcome-card',
      expect: LOCAL.welcomeCard,
      next: { testid: LOCAL.welcomeStep, label: 'Follow a thread' },
      run: async ({ page, pages }) => {
        await page.goto('/t/engineering/threads');
        await pages.threads.expectLoaded();
        await expect(page.getByTestId(LOCAL.welcomeCard)).toContainText('Welcome, Priya');
      },
    },
    {
      id: 'general-open',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages, page, viewport }) => {
        if (viewport === 'mobile') await page.getByRole('button', { name: 'Open menu' }).click();
        await pages.shell.openChannelFromSidebar('general');
        await expect(page).toHaveURL(/\/c\/general/);
      },
    },
    {
      id: 'thread-open',
      expect: TID.threadView,
      next: { testid: TID.composer, label: 'Reply in thread' },
      run: async ({ pages }) => {
        await pages.channel.open('dev');
        const withThread = pages.channel.message(/\d+ repl(y|ies)/);
        await pages.channel.openThread(withThread);
      },
    },
    {
      id: 'thread-followed',
      expect: TID.threadView,
      next: { testid: LOCAL.followState },
      run: async ({ page }) => {
        const follow = page.getByRole('switch', { name: 'Follow thread' });
        if ((await follow.getAttribute('aria-checked')) !== 'true') await follow.click();
        await expect(page.getByTestId(LOCAL.followState)).toContainText('Following');
      },
    },
    {
      id: 'checklist-done',
      expect: TID.threadsInbox,
      next: { testid: LOCAL.threadRow, label: 'My followed thread' },
      run: async ({ page, pages }) => {
        // the first-day card shows only while the Followed list is empty: following a thread finishes it, and the thread is in the list now
        await page.goto('/t/engineering/threads');
        await pages.threads.expectLoaded();
        await expect(page.getByTestId(LOCAL.threadRow).first()).toBeVisible();
        await expect(page.getByTestId(LOCAL.welcomeCard)).toHaveCount(0);
      },
    },
    {
      id: 'teams-menu',
      expect: TID.threadsInbox,
      next: { testid: LOCAL.teamSwitch, unchecked: true },
      run: async ({ page, viewport }) => {
        if (viewport === 'mobile') await page.getByRole('button', { name: 'Open menu' }).click();
        await page.locator('.team-wrap > button.team').click();
        await expect(page.getByRole('menu', { name: 'Teams' })).toBeVisible();
      },
    },
    {
      id: 'marketing',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.getByRole('menuitemradio', { name: /Marketing/ }).click();
        await expect(page).toHaveURL(/\/t\/marketing\//);
        await expect(page.locator('[data-landmark="team-switch"]')).toContainText('Marketing');
      },
    },
  ],
  outcome: async ({ api }) => {
    const priya = await api('priya');
    const dir = await priya.get<{ groups: Array<{ channels: Array<{ id: string; name: string; unread: number }> }> }>('/api/teams/engineering/channels');
    const general = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'general');
    expect(general, '#general is in her channel list').toBeTruthy();
    const detail = await priya.get<{ channel?: { isMember: boolean }; isMember?: boolean }>(`/api/channels/${general!.id}`);
    expect(detail.channel?.isMember ?? detail.isMember, 'she is in #general').toBe(true);
    const followed = await priya.get<{ items: unknown[] }>('/api/teams/engineering/threads?tab=followed');
    expect(followed.items.length, 'she follows a thread').toBeGreaterThan(0);
    const marketing = await priya.status('GET', '/api/teams/marketing/channels');
    expect(marketing, 'she is on the Marketing team too').toBe(200);
  },
});
