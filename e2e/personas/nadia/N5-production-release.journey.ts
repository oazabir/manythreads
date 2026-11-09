// N5 · Nadia's release waits for someone else (PLAN §4: she asks for a production release and watches it wait for Rafi). The request is a held Coder call that only an on-call person may
// decide (the same row a protected environment makes; it is arranged as the database owner because the real way to raise one needs a model). Nadia sees it wait and cannot decide it;
// Rafi decides it through the server; Nadia sees it approved. The deploy itself (P6-05 protected environments) is not part of this journey.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { arrangeApprovals, rowOfApproval, type ArrangedApproval } from '../../approvals/support.ts';

let release: ArrangedApproval | undefined;

export default defineJourney({
  id: 'N5',
  persona: 'nadia',
  goal: 'Ask for a production release, see that it waits for Rafi and that I cannot decide it myself, then see it approved.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'request-waits',
      expect: TID.approvalCard,
      run: async ({ stack, pages, page }) => {
        [release] = await arrangeApprovals(stack, [{ path: 'releases/v2.14-production.md', requester: 'nadia', approvers: ['role:on-call'] }]);
        await pages.approvals.open();
        const card = await pages.approvals.select(/v2\.14-production/);
        await expect(page.getByTestId('approval-blocked')).toHaveText('You asked for this, so someone else has to decide it.');
        await expect(card.getByTestId(TID.approvalApprove)).toHaveCount(0);
      },
    },
    {
      id: 'rafi-decides',
      expect: TID.approvalsInbox,
      run: async ({ api, pages }) => {
        const rafi = await api('rafi');
        await rafi.post(`/api/teams/engineering/approvals/${release!.id}/approve`, { note: 'Canary is green. Go ahead.' });
        await pages.approvals.open();
      },
    },
    {
      id: 'release-approved',
      expect: TID.approvalCard,
      run: async ({ pages, page }) => {
        await page.goto('/t/engineering/approvals?tab=decided');
        const card = await pages.approvals.select(/v2\.14-production/);
        await expect(card.getByTestId(TID.approvalOutcome)).toBeVisible();
      },
    },
  ],
  outcome: async ({ stack }) => {
    const row = await rowOfApproval(stack, release!.id);
    expect(row?.status, 'Rafi, not Nadia, decided it').toBe('approved');
  },
});
