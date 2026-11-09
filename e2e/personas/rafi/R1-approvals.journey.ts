// R1 (A): Rafi, the on-call approver, clears Approvals. Coder (an acting bot) asked to write a release page and a second page; he approves one, and declines the
// other with a note. The decision is what the platform does next: the first page is written by the bot, the second never is.
import { expect, type Page } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, askCoderToWrite, readyCoderToAsk } from '../omar/support/index.ts';

/** On a phone the open request fills the screen and the list is behind the "Approvals" button; on a desktop the list is beside it and nothing is pressed. */
async function backToList(page: Page): Promise<void> {
  const back = page.getByRole('button', { name: 'Approvals', exact: true });
  if (await back.isVisible()) await back.click();
}

const RELEASE = 'pages/release-v2-15.md';
const DRAFT = 'pages/rollout-draft.md';

export default defineJourney({
  id: 'R1',
  persona: 'rafi',
  goal: 'Clear my approvals: allow the release page Coder asked for and decline the draft, with a reason.',
  markers: ['A'],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  steps: [
    {
      id: 'waiting',
      expect: TID.approvalsInbox,
      next: { testid: TID.approvalRow, label: 'A request' },
      run: async (ctx) => {
        await readyCoderToAsk(ctx.stack);
        await askCoderToWrite(ctx, 'nadia', RELEASE, 'Release v2.15 notes: the canary starts Thursday at 10:00.', true);
        await askCoderToWrite(ctx, 'nadia', DRAFT, 'Draft rollout plan.', true);
        await ctx.pages.approvals.open();
        await expect(ctx.pages.approvals.rows.filter({ hasText: /release-v2-15|rollout-draft/ })).toHaveCount(2);
      },
    },
    {
      id: 'request-open',
      expect: TID.approvalCard,
      next: { testid: TID.approvalApprove, label: 'Approve' },
      run: async ({ pages }) => {
        await pages.approvals.select(/release-v2-15/);
      },
    },
    {
      id: 'approved',
      expect: TID.approvalOutcome,
      next: { testid: TID.approvalRow, label: 'The next request', unchecked: true },
      run: async ({ pages }) => {
        await pages.approvals.approve('Canary window agreed with Nadia.');
      },
    },
    {
      id: 'second-open',
      expect: TID.approvalCard,
      next: { testid: TID.approvalDeny, label: 'Decline' },
      run: async ({ page, pages }) => {
        await backToList(page);
        await pages.approvals.select(/rollout-draft/);
      },
    },
    {
      id: 'declined',
      expect: TID.approvalOutcome,
      run: async ({ pages }) => {
        await pages.approvals.deny('Not this week: the draft has no rollback step.');
      },
    },
    {
      id: 'decided-list',
      expect: TID.approvalsInbox,
      run: async ({ page }) => {
        await backToList(page);
        await page.getByTestId('approvals-tab-decided').click();
        await expect(page.getByTestId(TID.approvalRow).filter({ hasText: /release-v2-15|rollout-draft/ })).toHaveCount(2);
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const rows = await stack.sql<{ summary: string; status: string; outcome: string }>(
      `SELECT summary, status, outcome FROM app.approvals WHERE summary LIKE '%release-v2-15%' OR summary LIKE '%rollout-draft%' ORDER BY summary`,
    );
    const by = (needle: string) => rows.find((r) => r.summary.includes(needle));
    expect(by('release-v2-15')).toMatchObject({ status: 'approved' });
    await expect
      .poll(async () => (await stack.sql<{ outcome: string }>(`SELECT outcome FROM app.approvals WHERE summary LIKE '%release-v2-15%'`))[0]?.outcome, { timeout: 30_000 })
      .toBe('ran');
    expect(by('rollout-draft')).toMatchObject({ status: 'denied', outcome: 'none' });
    const omar = await api('omar');
    expect(await omar.status('GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(RELEASE)}`), 'the approved page exists').toBe(200);
    expect(await omar.status('GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(DRAFT)}`), 'the declined page was never written').toBe(404);
  },
});
