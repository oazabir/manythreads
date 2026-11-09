// S5 · What Sameera must never be able to do (PLAN §4): read Engineering's channels, memory or inbox, run Coder, read other people's conversations.
// Each step shows the screen that refuses; the ones a hand-made request could try send it from her own page and show the server's refusal.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { askFromPage } from '../nadia/support/denied.ts';

async function refused(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /You do not have access|Page not found/ }).or(page.getByTestId(TID.noAccess)).first()).toBeVisible();
}

export default defineJourney({
  id: 'S5',
  persona: 'sameera',
  goal: 'Check that Engineering is closed to me: its channels, its memory, its inbox and its bots, and that nobody else\'s conversation opens for me.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'own-team-only',
      expect: TID.frame,
      run: async ({ pages }) => {
        await pages.inTeam('customer-support').shell.open('/t/customer-support/threads');
        await expect(pages.inTeam('customer-support').shell.channelLink('support')).toBeVisible();
        await expect(pages.inTeam('customer-support').shell.channelLink('dev')).toHaveCount(0);
        await expect(pages.inTeam('customer-support').shell.channelLink('releases')).toHaveCount(0);
      },
    },
    {
      id: 'engineering-channel-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/c/dev');
        await refused(page);
      },
    },
    {
      id: 'engineering-memory-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/memory');
        await refused(page);
      },
    },
    {
      id: 'engineering-inbox-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/memory?tab=inbox');
        await refused(page);
      },
    },
    {
      id: 'coder-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/bots/coder/chat');
        await refused(page);
      },
    },
    {
      id: 'engineering-api-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        await page.goto('/t/customer-support/threads');
        const dev = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`);
        expect(dev[0]?.id, 'the #dev channel exists').toBeTruthy();
        expect(await askFromPage(page, 'GET', `/api/channels/${dev[0]!.id}/messages`), 'messages of #dev').toBe(403);
      },
    },
    {
      id: 'back-to-support',
      expect: TID.frame,
      run: async ({ pages, page }) => {
        await pages.inTeam('customer-support').channel.open('support');
        await expect(page.getByTestId(TID.channelView)).toBeVisible();
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const sameera = await api('sameera');
    const dev = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`);
    expect(await sameera.status('GET', `/api/channels/${dev[0]!.id}/messages`), '#dev messages').toBeGreaterThanOrEqual(400);
    const listed = await sameera.get<{ groups: Array<{ channels: unknown[] }> }>('/api/teams/engineering/channels');
    expect(listed.groups.flatMap((g) => g.channels), 'Engineering lists no channel to her').toHaveLength(0);
    expect(await sameera.status('GET', '/api/teams/customer-support/channels'), 'her own team still opens').toBeLessThan(400);
  },
});
