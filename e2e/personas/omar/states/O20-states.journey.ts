// O20 · Omar's main screens in their empty, error, loading and denied states, and the Bot Board in each of its four (PLAN P13-01): no board yet, cards in every column, a card handed
// back, a card its owner left idle. The server's answer is forced for the one request that fills a screen; the Bot Board's cards are made through the platform's own tables so that the screen reads
// what a team that had used its bots would show. Nothing is left behind that another journey reads.
import { expect } from '@playwright/test';
import { defineJourney, type JourneyContext, type StepDeclaration } from '../../harness/journey.ts';
import { TID } from '../../../pages/index.ts';
import { actorOf } from '../../../files/support.ts';
import { channelId, openRefused, say, waitForBot } from '../support/index.ts';
import { statesSweep } from '../support/sweep.ts';
import { emptyRequests } from '../../harness/states.ts';

const AUDIT = '**/api/admin/audit?*';
const INBOX = '**/api/teams/engineering/threads?*';
const APPROVALS = '**/api/teams/engineering/approvals?*';
const BOTS = '**/api/teams/engineering/bots';

const sweep = statesSweep([
  { id: 'audit-empty', path: '/settings/workspace/audit', expect: TID.frame, state: 'empty', pattern: AUDIT, emptyBody: { entries: [], nextCursor: null }, see: (page) => expect(page.getByTestId('audit-empty')).toBeVisible() },
  { id: 'audit-error', path: '/settings/workspace/audit', expect: TID.frame, state: 'error', pattern: AUDIT },
  { id: 'audit-loading', path: '/settings/workspace/audit', expect: TID.frame, state: 'loading', pattern: AUDIT },
  { id: 'threads-empty', path: '/t/engineering/threads', expect: TID.threadsInbox, state: 'empty', pattern: INBOX, emptyBody: { items: [], nextCursor: null }, see: (page) => expect(page.getByTestId('threads-empty')).toBeVisible() },
  { id: 'threads-error', path: '/t/engineering/threads', expect: TID.threadsInbox, state: 'error', pattern: INBOX, see: (page) => expect(page.getByText('Could not load threads.')).toBeVisible() },
  { id: 'approvals-empty', path: '/t/engineering/approvals', expect: TID.approvalsInbox, state: 'empty', pattern: APPROVALS, emptyBody: { items: [], waiting: 0 }, see: (page) => expect(page.getByTestId('approvals-empty')).toBeVisible() },
  { id: 'approvals-loading', path: '/t/engineering/approvals', expect: TID.frame, state: 'loading', pattern: APPROVALS },
  { id: 'bots-error', path: '/t/engineering/bots', expect: TID.frame, state: 'error', pattern: BOTS },
  { id: 'bots-loading', path: '/t/engineering/bots', expect: TID.frame, state: 'loading', pattern: BOTS },
  { id: 'llm-error', path: '/settings/workspace/llm', expect: TID.frame, state: 'error', pattern: '**/api/workspace/llm/providers' },
]);

/** The Bot Board of #dev as a team that has used its bots would have it. Cards are filed on it by SQL because the bots that file them are not part of this journey. */
async function seedBotBoard(ctx: JourneyContext): Promise<string> {
  const dev = await channelId(ctx, 'omar', 'dev');
  // the seeded world already has the Bot Board of #dev (with one card of Coder's); the cards of this journey go on it
  let boardId = (await ctx.stack.sql<{ id: string }>(`SELECT id FROM app.boards WHERE channel_id = $1 AND name = 'Bot Board'`, [dev]))[0]?.id;
  if (!boardId) {
    const made = await (await ctx.api('omar')).post<{ board: { id: string } }>('/api/teams/engineering/boards', { name: 'Bot Board' });
    boardId = made.board.id;
    await ctx.stack.sql(`UPDATE app.boards SET channel_id = $2 WHERE id = $1`, [boardId, dev]);
  }
  const coder = await waitForBot(ctx.stack, 'coder');
  const rafi = actorOf('rafi');
  await ctx.stack.sql(
    `INSERT INTO app.tasks (workspace_id, team_id, title, state, kind, branch, owner_id, created_by, board_id, blocker_reason, rework_count, handoff_count, updated_at, completed_at)
     SELECT b.workspace_id, b.team_id, v.title, v.state, 'other', 'work/' || v.slug, v.owner::uuid, b.created_by, b.id, v.blocker, v.rework, v.handoff, now() - v.age::interval, CASE WHEN v.state = 'done' THEN now() END
       FROM app.boards b, (VALUES
         ('Draft the release notes', 'draft-notes', 'open', NULL, '', 0, 0, '1 hour'),
         ('Review release 2.15', 'review-215', 'in_progress', $2, '', 0, 0, '2 hours'),
         ('Check the dashboards after the canary', 'check-dashboards', 'verify', $2, '', 0, 0, '3 hours'),
         ('Waiting for the on-call approval', 'wait-approval', 'waiting_on_person', $2, 'Needs an on-call person to approve the deploy', 0, 0, '30 minutes'),
         ('Ship v2.14', 'ship-214', 'done', $2, '', 0, 0, '1 day'),
         ('Fix the flaky search test', 'flaky-search', 'open', NULL, 'Handed back: the test needs the staging data', 1, 1, '4 hours'),
         ('Update the runbook links', 'runbook-links', 'in_progress', $3, '', 0, 0, '6 days')
       ) AS v(title, slug, state, owner, blocker, rework, handoff, age)
      WHERE b.id = $1`,
    [boardId, coder.actorId, rafi],
  );
  return boardId;
}

let noBoards: (() => Promise<void>) | undefined;

const customSteps: StepDeclaration[] = [
  {
    id: 'dm-denied',
    expect: TID.noAccess,
    expectDenied: 403,
    run: async (ctx: JourneyContext) => {
      await sweep.finish();
      // a conversation between two colleagues: the admin has no way in
      const rafi = await (await ctx.api('rafi')).get<{ person: { id: string } }>('/api/session');
      const dm = await (await ctx.api('nadia')).post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [rafi.person.id] });
      await say(ctx, 'nadia', dm.dm.channel.id, 'Can you cover the handover on Friday?');
      await openRefused(ctx.page, `/t/engineering/dm/${dm.dm.channel.id}`, dm.dm.channel.id);
    },
  },
  {
    id: 'bot-board-none',
    expect: TID.channelView,
    run: async (ctx: JourneyContext) => {
      // a channel whose bots have not made a board yet: the seeded world has one in #dev, so the list of the channel's boards is answered empty for this picture
      noBoards = await emptyRequests(ctx.page, '**/api/channels/*/boards', { items: [] });
      const asked = ctx.page.waitForResponse((r) => /\/api\/channels\/[^/]+\/boards$/.test(r.url()));
      await ctx.pages.channel.open('dev');
      await asked;
      await expect(ctx.page.getByTestId(TID.botBoardLink), 'no Bot Board link while the channel has no board').toHaveCount(0);
    },
  },
  {
    id: 'bot-board-columns',
    expect: TID.boardView,
    next: { testid: TID.boardCard, label: 'A card' },
    run: async (ctx: JourneyContext) => {
      await noBoards?.();
      noBoards = undefined;
      const boardId = await seedBotBoard(ctx);
      await ctx.page.goto(`/t/engineering/boards?board=${boardId}`);
      await expect(ctx.pages.boards.columns).toHaveCount(5);
      for (const column of ['Open', 'In progress', 'Verify', 'Waiting', 'Done']) {
        await expect(ctx.pages.boards.columns.filter({ hasText: column }).first().getByTestId(TID.boardCard).first(), `a card in ${column}`).toBeVisible();
      }
    },
  },
  {
    id: 'bot-board-handed-back',
    expect: TID.cardPanel,
    run: async (ctx: JourneyContext) => {
      const panel = await ctx.pages.boards.openCard(/Fix the flaky search test/);
      await expect(panel).toContainText('Handed back');
      await expect(ctx.pages.boards.card(/Fix the flaky search test/)).toContainText('1 rework');
    },
  },
  {
    id: 'bot-board-idle',
    expect: TID.cardPanel,
    run: async (ctx: JourneyContext) => {
      const panel = await ctx.pages.boards.openCard(/Update the runbook links/);
      await expect(panel.getByTestId('card-owner')).toContainText('Rafi');
      // nobody is working on it: no bot icon on the card
      await expect(ctx.pages.boards.card(/Update the runbook links/).getByTestId('bot-activity')).toHaveCount(0);
    },
  },
];

export default defineJourney({
  id: 'O20',
  persona: 'omar',
  goal: 'See what the audit log, threads, approvals, bots, model settings and the Bot Board say when there is nothing, when the server fails, while they load, and when I may not look.',
  markers: [],
  start: 'week-2',
  steps: [...sweep.steps, ...customSteps],
  outcome: async ({ page, stack }) => {
    await sweep.finish();
    await page.goto('/t/engineering/threads');
    await expect(page.getByTestId(TID.threadsInbox), 'the forced answers were removed').toBeVisible();
    const cards = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.tasks t JOIN app.boards b ON b.id = t.board_id WHERE b.name = 'Bot Board'`);
    expect(Number(cards[0]?.n), 'the Bot Board holds the seven cards made here and the seeded one').toBeGreaterThanOrEqual(7);
  },
});
