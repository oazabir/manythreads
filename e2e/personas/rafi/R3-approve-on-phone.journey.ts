// R3: Rafi approves from his phone (the 390 px client): the waiting list, one request, a note, the decision, and nothing sideways to scroll.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { noSidewaysScroll } from '../../support/stack-browser.ts';
import { BOTS_ENV, askCoderToWrite, readyCoderToAsk } from '../omar/support/index.ts';

const PATH = 'pages/hotfix-note.md';

export default defineJourney({
  id: 'R3',
  persona: 'rafi',
  goal: 'Approve a request from my phone while I am away from my desk.',
  markers: ['A'],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  viewports: ['mobile'],
  steps: [
    {
      id: 'phone-inbox',
      expect: TID.approvalsInbox,
      next: { testid: TID.approvalRow, label: 'A request' },
      run: async (ctx) => {
        await readyCoderToAsk(ctx.stack);
        await askCoderToWrite(ctx, 'nadia', PATH, 'Hotfix note: the retry cap is five attempts.', true);
        await ctx.pages.approvals.open();
        await expect(ctx.pages.approvals.rows.filter({ hasText: /hotfix-note/ })).toHaveCount(1);
      },
    },
    {
      id: 'request-open',
      expect: TID.approvalCard,
      next: { testid: TID.approvalApprove, label: 'Approve' },
      run: async ({ pages }) => {
        await pages.approvals.select(/hotfix-note/);
      },
    },
    {
      id: 'note-typed',
      expect: TID.approvalCard,
      next: { testid: TID.approvalApprove, label: 'Approve' },
      run: async ({ page }) => {
        await page.getByTestId(TID.approvalNote).fill('Looks right to me.');
      },
    },
    {
      id: 'approved',
      expect: TID.approvalOutcome,
      run: async ({ pages }) => {
        await pages.approvals.approve();
      },
    },
    {
      id: 'decided',
      expect: TID.approvalsInbox,
      run: async ({ page }) => {
        // the open request fills the phone screen; the list is behind the "Approvals" button
        const back = page.getByRole('button', { name: 'Approvals', exact: true });
        if (await back.isVisible()) await back.click();
        await page.getByTestId('approvals-tab-decided').click();
        await expect(page.getByTestId(TID.approvalRow).filter({ hasText: /hotfix-note/ })).toHaveCount(1);
      },
    },
  ],
  outcome: async ({ page, stack }) => {
    expect(await noSidewaysScroll(page), 'nothing to scroll sideways at 390 px').toBe(true);
    await expect
      .poll(async () => (await stack.sql<{ status: string; outcome: string }>(`SELECT status, outcome FROM app.approvals WHERE summary LIKE '%hotfix-note%'`))[0], { timeout: 30_000 })
      .toMatchObject({ status: 'approved', outcome: 'ran' });
  },
});
