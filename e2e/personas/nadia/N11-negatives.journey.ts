// N11 · What Nadia must never be able to do (PLAN §4): approve her own request, open the terminal, see Customer support's or Marketing's channels.
// Each step shows the screen that does not offer it; the ones that can also be tried by hand send the request from her own page and show the server's refusal.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { arrangeApprovals, rowOfApproval, type ArrangedApproval } from '../../approvals/support.ts';
import { askFromPage } from './support/denied.ts';

let own: ArrangedApproval | undefined;
const SUPPORT_CHANNEL = '/t/customer-support/c/support';
const MARKETING_CHANNEL = '/t/marketing/c/campaigns';

export default defineJourney({
  id: 'N11',
  persona: 'nadia',
  goal: 'Check that I cannot approve my own release request, open a terminal, or read Support and Marketing channels.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'own-request-no-buttons',
      expect: TID.approvalCard,
      run: async ({ stack, page }) => {
        [own] = await arrangeApprovals(stack, [{ path: 'pages/nadia-release-notes.md', requester: 'nadia', approvers: ['role:on-call'] }]);
        await page.goto(`/t/engineering/approvals?approval=${own!.id}`);
        await expect(page.getByTestId('approval-blocked')).toHaveText('You asked for this, so someone else has to decide it.');
        await expect(page.getByTestId(TID.approvalApprove)).toHaveCount(0);
        await expect(page.getByTestId(TID.approvalDeny)).toHaveCount(0);
      },
    },
    {
      id: 'own-request-refused',
      expect: TID.approvalCard,
      expectDenied: 403,
      run: async ({ page }) => {
        expect(await askFromPage(page, 'POST', `/api/teams/engineering/approvals/${own!.id}/approve`, { note: '' })).toBe(403);
      },
    },
    {
      id: 'terminal-denied',
      expect: 'ws-terminal-denied',
      run: async ({ page }) => {
        await page.goto('/t/engineering/bots/coder/chat?view=workshop&terminal=1');
        await expect(page.getByTestId('ws-terminal-open')).toHaveCount(0);
      },
    },
    {
      id: 'terminal-refused',
      expect: 'ws-terminal-denied',
      expectDenied: 403,
      run: async ({ page }) => {
        expect(await askFromPage(page, 'POST', '/api/teams/engineering/bots/coder/workshop/terminal', {})).toBe(403);
      },
    },
    {
      id: 'support-channel-no-access',
      expect: TID.frame,
      run: async ({ pages }) => {
        await pages.channel.openExpectingRefusal(SUPPORT_CHANNEL);
      },
    },
    {
      id: 'marketing-channel-no-access',
      expect: TID.frame,
      run: async ({ pages }) => {
        await pages.channel.openExpectingRefusal(MARKETING_CHANNEL);
      },
    },
    {
      id: 'other-teams-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        await page.goto('/t/engineering/threads');
        const support = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'customer-support' AND c.name = 'support'`);
        expect(support[0]?.id, 'the Support channel exists').toBeTruthy();
        expect(await askFromPage(page, 'GET', `/api/channels/${support[0]!.id}/messages`), 'messages of #support').toBe(403);
      },
    },
    {
      id: 'sidebar-engineering-only',
      expect: TID.frame,
      run: async ({ pages, page }) => {
        await pages.shell.open('/t/engineering/threads');
        await expect(pages.shell.channelLink('support')).toHaveCount(0);
        await expect(pages.shell.channelLink('campaigns')).toHaveCount(0);
        await expect(page.locator('[data-landmark="sidebar"]').getByText('Customer support')).toHaveCount(0);
      },
    },
  ],
  outcome: async ({ stack, api }) => {
    expect((await rowOfApproval(stack, own!.id))?.status, 'her own request still waits').toBe('pending');
    const nadia = await api('nadia');
    const support = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'customer-support' AND c.name = 'support'`);
    expect(await nadia.status('GET', `/api/channels/${support[0]!.id}/messages`), 'messages of #support').toBeGreaterThanOrEqual(400);
    const listed = await nadia.get<{ groups: Array<{ channels: unknown[] }> }>('/api/teams/customer-support/channels');
    expect(listed.groups.flatMap((g) => g.channels), 'Customer support lists no channel to her').toHaveLength(0);
    const sessions = await stack.sql<{ n: string }>(`select count(*)::text as n from app.terminal_sessions`);
    // no `.catch`: a missing table must fail the journey, not read as "no terminal"
    expect(Number(sessions[0]!.n), 'no terminal was opened').toBe(0);
  },
});
