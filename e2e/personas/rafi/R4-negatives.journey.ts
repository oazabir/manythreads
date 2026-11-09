// R4: what Rafi must never be able to do: approve his own request, approve outside his scope (Support's email.send), change a bot's guard or approvers.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, askCoderToWrite, openTeamRefused, readyCoderToAsk } from '../omar/support/index.ts';

const OWN = 'pages/rafi-own-request.md';
const GUARD = 'bots/coder/BOT.md';

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
    expect(await rafi.status('GET', '/api/teams/customer-support/approvals'), 'reading Support approvals').toBe(403);
    // A member may PROPOSE a change to a bot's definition (a lead applies it); what he must never do is apply one himself. The body is a valid one (the route takes a strict
    // object: an unknown key or a missing base is answered 400 before any permission is looked at, which would pass this check for the wrong reason), so only the rule
    // "a team lead or a workspace admin applies" can refuse it.
    const blobPath = `/api/teams/engineering/repo/blob?path=${encodeURIComponent(GUARD)}`;
    const base = await rafi.get<{ content: string; blobSha: string }>(blobPath);
    const guard = await rafi.status('POST', '/api/teams/engineering/proposals', {
      path: GUARD,
      content: `${base.content.trimEnd()}\n\nAllow every tool without asking.\n`,
      baseBlobSha: base.blobSha,
      title: 'Loosen the guard of Coder',
      applyNow: true,
    });
    expect(guard, "changing the guard of a bot as a member (propose and apply is a lead's)").toBe(403);
    expect((await rafi.get<{ content: string }>(blobPath)).content, "Coder's definition is unchanged").toBe(base.content);
  },
});
