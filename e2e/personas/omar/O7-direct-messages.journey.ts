// O7: direct messages are private even from the admin. Omar reads the message Priya sent him, and cannot open the conversation between Nadia and Rafi (an admin does not bypass it).
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import type { JourneyContext, Persona } from '../harness/journey.ts';
import { openRefused, say } from './support/index.ts';

let theirsId = '';
const HELLO = 'Hi Omar, a quick question about my laptop setup when you have a minute.';
const PRIVATE = 'Can you cover the on-call handover on Friday?';

async function openDm(ctx: JourneyContext, from: Persona, to: Persona): Promise<string> {
  const target = await (await ctx.api(to)).get<{ person: { id: string } }>('/api/session');
  const api = await ctx.api(from);
  const made = await api.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [target.person.id] });
  return made.dm.channel.id;
}

export default defineJourney({
  id: 'O7',
  persona: 'omar',
  goal: 'Read the message Priya sent me, and see that the conversation between Nadia and Rafi stays closed to me.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'dm-waiting',
      expect: TID.threadsInbox,
      next: { testid: TID.threadsInbox, label: 'Direct messages' },
      run: async (ctx) => {
        const mine = await openDm(ctx, 'priya', 'omar');
        await say(ctx, 'priya', mine, HELLO);
        const theirs = await openDm(ctx, 'nadia', 'rafi');
        theirsId = theirs;
        await say(ctx, 'nadia', theirs, PRIVATE);
        await ctx.pages.threads.open();
        if (ctx.viewport === 'mobile') await ctx.page.getByRole('button', { name: 'Open menu' }).click();
        await expect(ctx.page.locator('[data-slot="direct-messages"] a.it').filter({ hasText: 'Priya' })).toHaveCount(1, { timeout: 30_000 });
      },
    },
    {
      id: 'only-mine-listed',
      expect: TID.threadsInbox,
      next: { testid: TID.threadsInbox, label: 'Open the message from Priya' },
      run: async ({ page, viewport }) => {
        // the list of direct messages holds the one that is mine; the conversation of the two colleagues is not in it
        const list = page.locator('[data-slot="direct-messages"] a.it');
        if (viewport === 'mobile' && !(await list.first().isVisible())) await page.getByRole('button', { name: 'Open menu' }).click();
        await expect(list.filter({ hasText: 'Priya' })).toHaveCount(1);
        await expect(page.locator(`[data-slot="direct-messages"] a[href$="/${theirsId}"]`)).toHaveCount(0);
      },
    },
    {
      id: 'my-dm-open',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Reply' },
      run: async ({ page, pages, viewport }) => {
        const row = page.locator('[data-slot="direct-messages"] a.it').filter({ hasText: 'Priya' });
        if (viewport === 'mobile' && !(await row.isVisible())) await page.getByRole('button', { name: 'Open menu' }).click();
        await row.click();
        await expect(page).toHaveURL(/\/t\/engineering\/dm\/[0-9a-f-]{36}$/);
        await expect(pages.channel.message('laptop setup')).toBeVisible();
      },
    },
    {
      id: 'reply-sent',
      expect: TID.channelView,
      composer: true,
      run: async ({ page, pages }) => {
        await page.getByRole('textbox', { name: /Message Priya/ }).fill('Of course: come by at 3 and we will set it up.');
        await page.keyboard.press('Enter');
        await expect(pages.channel.message('come by at 3')).toBeVisible();
      },
    },
    {
      id: 'their-dm-refused',
      expect: TID.noAccess,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        const rows = await stack.sql<{ channel_id: string }>(`SELECT channel_id FROM app.messages WHERE body = $1`, [PRIVATE]);
        await openRefused(page, `/t/engineering/dm/${rows[0]!.channel_id}`, rows[0]!.channel_id);
        await expect(page.getByTestId(TID.noAccess)).toContainText('You cannot see this channel.');
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const omar = await api('omar');
    const rows = await stack.sql<{ channel_id: string }>(`SELECT channel_id FROM app.messages WHERE body = $1`, [PRIVATE]);
    expect(await omar.status('GET', `/api/channels/${rows[0]!.channel_id}/messages`), 'the API refuses too').toBe(403);
    const mine = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages WHERE body LIKE 'Of course: come by at 3%'`);
    expect(Number(mine[0]?.n)).toBe(1);
  },
});
