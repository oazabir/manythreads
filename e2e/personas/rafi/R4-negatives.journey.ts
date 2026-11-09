// R4: what Rafi must never be able to do: approve his own request, approve outside his scope (Support's email.send), change a bot's guard or approvers.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, askCoderToWrite, openTeamRefused, readyCoderToAsk } from '../omar/support/index.ts';

const OWN = 'pages/rafi-own-request.md';

export default defineJourney({
  id: 'R4',
  persona: 'rafi',
  goal: 'Check what I cannot do: decide my own request, decide for Support, or change a bot\'s guard.',
  markers: [],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  steps: [
    {
      id: 'own-request-waits',
      expect: TID.approvalsInbox,
      next: { testid: TID.approvalRow },
      run: async (ctx) => {
        await readyCoderToAsk(ctx.stack);
        await askCoderToWrite(ctx, 'rafi', OWN, 'A page Rafi asked Coder to write.', true);
        await ctx.pages.approvals.open();
        await expect(ctx.pages.approvals.rows.filter({ hasText: /rafi-own-request/ })).toHaveCount(1);
      },
    },
    {
      id: 'own-request-blocked',
      expect: TID.approvalCard,
      run: async ({ pages }) => {
        const card = await pages.approvals.select(/rafi-own-request/);
        await expect(card.getByTestId(TID.approvalApprove)).toHaveCount(0);
        await expect(card.getByTestId('approval-blocked')).toBeVisible();
      },
    },
    {
      id: 'support-approvals-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await openTeamRefused(page, '/t/customer-support/approvals', '/api/teams/customer-support/approvals');
      },
    },
    {
      id: 'guard-read-only',
      expect: TID.botPage,
      run: async ({ pages, page }) => {
        await pages.bot.open('coder');
        await page.getByRole('tab', { name: 'Safety' }).click();
        await expect(page.getByText('You can read this definition but not change it')).toBeVisible();
        await expect(page.getByRole('button', { name: /Save|Propose|Apply/ })).toHaveCount(0);
      },
    },
    {
      id: 'what-it-can-do-read-only',
      expect: TID.botPage,
      run: async ({ page }) => {
        await page.getByRole('tab', { name: 'What it can do' }).click();
        await expect(page.getByRole('button', { name: /Save|Propose|Apply/ })).toHaveCount(0);
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const rafi = await api('rafi');
    const own = await stack.sql<{ id: string }>(`SELECT id FROM app.approvals WHERE summary LIKE '%rafi-own-request%'`);
    expect(await rafi.status('POST', `/api/teams/engineering/approvals/${own[0]!.id}/approve`, {}), 'approving his own request').toBe(403);
    expect(await rafi.status('GET', '/api/teams/customer-support/approvals'), 'reading Support approvals').toBeGreaterThanOrEqual(403);
    const guard = await rafi.status('POST', '/api/teams/engineering/proposals', { path: 'bots/coder/BOT.md', content: 'x', message: 'change guard' });
    expect(guard, 'changing the guard of a bot').toBeGreaterThanOrEqual(400);
  },
});
