// L1 · Lena accepts the guest invitation Omar sent and finds exactly one channel, #releases (PLAN block B; phase 3 criterion 3). The invitation page is opened in a window nobody
// is signed in on, as a link from an email would be; her own window then shows what the invitation gave her.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LENA_ENV, allowKnownNoise } from './support/index.ts';

const EMAIL = 'lena@kahf.example';

export default defineJourney({
  id: 'L1',
  persona: 'lena',
  goal: 'Accept the invitation to read the release announcements and see that #releases is all I was given.',
  markers: [],
  start: 'week-2',
  stackEnv: LENA_ENV,
  steps: [
    {
      id: 'invitation-link',
      expect: 'auth-card',
      next: { testid: 'accept-invitation', label: 'Accept invitation', unchecked: true },
      run: async (ctx) => {
        const omar = await ctx.api('omar');
        const invite = await omar.post<{ token: string }>('/api/invitations', { email: EMAIL, role: 'guest', channels: [{ teamSlug: 'engineering', channel: '#releases' }] });
        const link = await ctx.anonymous(`/invite/${invite.token}`);
        ctx.page = link.page;
        await expect(link.page.getByRole('heading', { name: /^Join / })).toBeVisible();
      },
    },
    {
      id: 'invitation-accepted',
      expect: 'auth-card',
      run: async ({ page }) => {
        await page.getByRole('button', { name: 'Accept invitation' }).click();
        await expect(page.getByRole('heading', { name: /^You joined / })).toBeVisible();
      },
    },
    {
      id: 'lands-in-releases',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async (ctx) => {
        const own = await ctx.also('lena', '/');
        allowKnownNoise(own.page);
        ctx.page = own.page;
        await expect(own.page).toHaveURL(/\/c\/releases$/);
        await expect(own.pages.channel.messages.first()).toBeVisible();
      },
    },
    {
      id: 'only-releases',
      expect: TID.frame,
      run: async ({ page }) => {
        const sidebar = page.locator('[data-landmark="sidebar"]');
        await expect(sidebar.locator('a.it')).toHaveCount(1);
        await expect(sidebar.locator('a.it')).toContainText('releases');
        for (const hidden of ['Files', 'Boards', 'Threads', 'Approvals', 'Direct messages', 'Bots', 'general', 'dev']) {
          await expect(sidebar.getByText(hidden, { exact: true })).toHaveCount(0);
        }
      },
    },
    {
      id: 'read-only',
      expect: TID.readOnly,
      run: async ({ pages, page }) => {
        await expect(page.getByTestId(TID.readOnly)).toHaveText('You can read this channel.');
        expect(await pages.channel.hasComposer(), 'the message box').toBe(false);
        await expect(page.locator('.msg .who b').filter({ hasText: 'Someone' })).toHaveCount(0);
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const lena = await api('lena');
    const dir = await lena.get<{ groups: Array<{ channels: Array<{ name: string }> }> }>('/api/teams/engineering/channels');
    expect(dir.groups.flatMap((g) => g.channels).map((c) => c.name.replace(/^#/, '')), 'the channels she was given').toEqual(['releases']);
    const grants = await stack.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.acl_entries a JOIN app.people p ON p.id = a.subject_id WHERE a.resource_type = 'channel' AND a.subject_type = 'person' AND p.primary_email = $1`,
      [EMAIL],
    );
    expect(Number(grants[0]?.n), 'one grant, not a second one for the same channel').toBe(1);
  },
});
