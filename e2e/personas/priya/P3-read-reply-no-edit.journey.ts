// P3: Priya reads and replies, but has no way to edit what only leads and admins change. Negatives of PLAN §4: approve anything, change a bot's definition through the
// screen, open a terminal, release a held inbox item, see a private channel she was not added to. Repeats at 390 px.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { arrangeApprovals } from '../../approvals/support.ts';
import { askFromPage, openRefused, waitForBot } from '../omar/support/index.ts';

const REPLY = 'Thank you, that answers my question about the flag.';

export default defineJourney({
  id: 'P3',
  persona: 'priya',
  goal: 'Read the team, reply where I may, and see that I cannot change what only a lead can.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'dev-channel',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages }) => {
        await pages.channel.open('dev');
      },
    },
    {
      id: 'reply-sent',
      expect: TID.threadView,
      composer: true,
      run: async ({ pages }) => {
        const thread = await pages.channel.openThread(pages.channel.message(/\d+ repl(y|ies)/));
        await thread.reply(REPLY);
      },
    },
    {
      id: 'bot-read-only',
      expect: TID.botPage,
      next: { testid: 'open-conversation', label: 'Talk' },
      run: async ({ pages, page }) => {
        await pages.bot.open('coder');
        await expect(page.getByTestId('read-only-note')).toContainText('You can read this definition but not change it');
        await expect(page.getByTestId('bot-name')).toHaveAttribute('readonly', '');
        await expect(page.getByRole('button', { name: /Save|Propose|Apply/ })).toHaveCount(0);
      },
    },
    {
      id: 'approval-view-only',
      expect: TID.approvalCard,
      run: async ({ stack, pages }) => {
        await waitForBot(stack, 'coder');
        await arrangeApprovals(stack, [{ path: 'pages/priya-view-only.md', requester: 'nadia', approvers: ['role:on-call'] }]);
        await pages.approvals.open();
        const card = await pages.approvals.select(/priya-view-only/);
        await expect(card.getByTestId(TID.approvalApprove)).toHaveCount(0);
        await expect(card.getByTestId(TID.approvalDeny)).toHaveCount(0);
      },
    },
    {
      id: 'private-channel-refused',
      expect: TID.noAccess,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        const rows = await stack.sql<{ id: string }>(`SELECT id FROM app.channels WHERE name = 'eng-leads'`);
        await openRefused(page, '/t/engineering/c/eng-leads', rows[0]!.id);
      },
    },
    {
      id: 'members-page-gone',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/settings/workspace/members');
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
        expect(await askFromPage(page, 'GET', '/api/admin/audit'), 'the admin API refuses her as well').toBe(403);
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const priya = await api('priya');
    // her reply is in the thread
    const rows = await stack.sql<{ n: string }>('SELECT count(*)::text AS n FROM app.messages WHERE body = $1 AND thread_root_id IS NOT NULL', [REPLY]);
    expect(Number(rows[0]?.n)).toBe(1);
    // the refusals hold at the door, not only on the screen
    const pending = await stack.sql<{ id: string }>("SELECT id FROM app.approvals WHERE summary LIKE '%priya-view-only%'");
    expect(pending.length).toBe(1);
    expect(await priya.status('POST', `/api/teams/engineering/approvals/${pending[0]!.id}/approve`, {}), 'approving').toBe(403);
    expect(await priya.status('POST', '/api/teams/engineering/bots/coder/workshop/terminal', {}), 'opening a terminal').toBeGreaterThanOrEqual(403);
    const channels = await priya.get<{ groups: Array<{ channels: Array<{ name: string }> }> }>('/api/teams/engineering/channels');
    expect(channels.groups.flatMap((g) => g.channels).map((c) => c.name.replace(/^#/, '')), 'the private channel is not in her list').not.toContain('eng-leads');
  },
});
