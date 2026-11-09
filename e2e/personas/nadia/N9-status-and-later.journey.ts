// N9 · Nadia tells people where she is and keeps her place (PLAN block 14-18 additions): a status, Do not disturb, a reminder, a thread saved for later (P14-01, P14-04, P14-06).
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';

export default defineJourney({
  id: 'N9',
  persona: 'nadia',
  goal: 'Set my status, pause notifications while I watch the canary, ask to be reminded, and save the Deploy plan thread for later.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'open-standup',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Message box' },
      run: async ({ pages }) => {
        await pages.channel.open('standup');
      },
    },
    {
      id: 'status-set',
      expect: TID.channelView,
      composer: true,
      run: async ({ pages, page }) => {
        await pages.channel.input.fill('/status 🔨 Release owner this week');
        await pages.channel.input.press('Enter');
        await expect(page.getByTestId('slash-notice')).toBeVisible();
      },
    },
    {
      id: 'dnd-on',
      expect: TID.channelView,
      composer: true,
      run: async ({ pages, page }) => {
        await pages.channel.input.fill('/dnd 2h');
        await pages.channel.input.press('Enter');
        await expect(page.getByTestId('slash-notice')).toContainText(/notifications|paused|do not disturb/i);
      },
    },
    {
      id: 'reminder-set',
      expect: TID.channelView,
      composer: true,
      run: async ({ pages, page }) => {
        await pages.channel.input.fill('/remind me in 20 minutes check the canary dashboards');
        await pages.channel.input.press('Enter');
        await expect(page.getByTestId('slash-notice')).toBeVisible();
      },
    },
    {
      id: 'thread-actions',
      expect: TID.threadsInbox,
      next: { testid: 'thread-action-save', label: 'Save' },
      run: async ({ pages, page }) => {
        await pages.threads.open();
        const row = page.getByTestId('thread-row').filter({ hasText: 'Deploy plan' }).first();
        await expect(row).toBeVisible();
        // the Actions menu closes on any scroll or resize of the window (ThreadCard.tsx); a late scroll of the list probably shuts it
        // just after the click (cause not proven; seen once in a full run: "thread-action-save" not found). The step opens it again until it stays open; the menu must still show.
        const save = page.getByTestId('thread-action-save');
        await expect(async () => {
          if (!(await save.isVisible())) await page.getByRole('option', { name: /Deploy plan/ }).getByTestId('thread-actions').click();
          await expect(save).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
      },
    },
    {
      id: 'saved-for-later',
      expect: TID.threadsInbox,
      run: async ({ page }) => {
        await page.getByTestId('thread-action-save').click();
        await expect(page.getByRole('status').filter({ hasText: 'Saved for later' }).first()).toBeVisible();
      },
    },
    {
      id: 'later-tab',
      expect: TID.threadsInbox,
      run: async ({ page }) => {
        await page.getByRole('tab', { name: /Later/ }).click();
        await expect(page.getByTestId('later-row').first()).toBeVisible();
      },
    },
  ],
  outcome: async ({ stack }) => {
    const status = await stack.sql<{ t: string }>(`select s.status_text as t from app.person_status s join app.people p on p.id = s.person_id where p.display_name = 'Nadia'`);
    expect(status[0]?.t, 'her status is set').toContain('Release owner');
    const dnd = await stack.sql<{ until: string | null }>(`select d.paused_until::text as until from app.dnd_settings d join app.people p on p.id = d.person_id where p.display_name = 'Nadia'`);
    expect(dnd[0]?.until, 'notifications are paused').toBeTruthy();
    const reminder = await stack.sql<{ n: string }>(`select count(*)::text as n from app.reminders where state = 'pending' and text like '%canary dashboards%'`);
    expect(Number(reminder[0]?.n ?? 0), 'the reminder waits').toBe(1);
    const later = await stack.sql<{ n: string }>(`select count(*)::text as n from app.later_items where state = 'open'`);
    expect(Number(later[0]?.n ?? 0), 'a thread is saved for later').toBeGreaterThanOrEqual(1);
  },
});
