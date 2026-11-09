// S8 · Sameera asks Support responder in #support for a draft reply (PLAN §4 acting-bot journey). The draft is the bot's own post and its definition says a post waits for a lead:
// Sameera sees it wait (the one who asks may not decide), a lead approves it, and the reply is in the thread. The Hermes behind Support responder is the stand-in of
// ../nadia/support/hermes-persona.mjs: the platform's run, tool and approval are real, only the model is missing. The mail door of S1 (a customer's email) is pending P8-19.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOT_STACK_ENV, allowKnownNoise, arrangeBot, talkingBotMd } from '../nadia/support/brain.ts';

const TEAM = 'customer-support';
const ASK = '@support-responder Draft a reply to the customer who wants to change the delivery address of their order.';

export default defineJourney({
  id: 'S8',
  persona: 'sameera',
  goal: 'Ask Support responder in #support for a draft reply, see that it waits for a lead, and read it in the thread once it is approved.',
  markers: ['A'],
  start: 'week-2',
  stackEnv: BOT_STACK_ENV,
  steps: [
    {
      id: 'open-support',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Message box' },
      run: async ({ pages, stack, page, api }) => {
        allowKnownNoise(page);
        await arrangeBot(
          stack,
          await api('omar'),
          TEAM,
          'support-responder',
          talkingBotMd('Support responder', 'Drafts first replies to customer enquiries from the knowledge base', ['mention', 'conversation'], { tools: ['messages.post'], approvers: [] }),
        );
        await pages.inTeam(TEAM).channel.open('support');
      },
    },
    {
      id: 'ask-typed',
      expect: TID.channelView,
      composer: true,
      run: async ({ pages }) => {
        await pages.inTeam(TEAM).channel.input.fill(ASK);
      },
    },
    {
      id: 'draft-waits',
      expect: TID.threadView,
      composer: true,
      run: async ({ pages, page, stack }) => {
        const channel = pages.inTeam(TEAM).channel;
        await channel.input.press('Enter');
        const asked = channel.message('Draft a reply to the customer').first();
        await expect(asked).toBeVisible();
        await channel.openThread(asked);
        try {
          await expect(page.getByTestId(TID.approvalCard)).toBeVisible({ timeout: 60_000 });
        } catch (err) {
          const runs = await stack.sql(`SELECT row_to_json(r) AS r FROM app.bot_runs r ORDER BY r.id DESC LIMIT 1`);
          const approvals = await stack.sql(`SELECT tool, status FROM app.approvals ORDER BY id DESC LIMIT 3`);
          throw new Error(`the draft did not wait for approval: ${JSON.stringify({ runs, approvals })} (${(err as Error).message.slice(0, 80)})`);
        }
        await expect(page.getByTestId('approval-blocked')).toHaveText('You asked for this, so someone else has to decide it.');
        await expect(page.getByTestId(TID.approvalApprove)).toHaveCount(0);
      },
    },
    {
      id: 'approvals-inbox',
      expect: TID.approvalCard,
      run: async ({ pages }) => {
        const approvals = pages.inTeam(TEAM).approvals;
        await approvals.open();
        await approvals.select(/messages\.post/);
      },
    },
    {
      id: 'lead-approves',
      expect: TID.approvalCard,
      run: async ({ pages, page, stack, api }) => {
        const waiting = await stack.sql<{ id: string }>(`SELECT id FROM app.approvals WHERE tool = 'messages.post' AND status = 'pending' AND args_preview::text LIKE '%thanks for writing in%' ORDER BY id DESC LIMIT 1`);
        expect(waiting[0]?.id, 'one post waits').toBeTruthy();
        await (await api('omar')).post(`/api/teams/${TEAM}/approvals/${waiting[0]!.id}/approve`, { note: 'Looks right.' });
        await pages.inTeam(TEAM).approvals.open();
        await page.goto(`/t/${TEAM}/approvals?tab=decided`);
        await pages.inTeam(TEAM).approvals.select(/messages\.post/);
        await expect(page.getByTestId(TID.approvalOutcome)).toBeVisible();
      },
    },
    {
      id: 'reply-posted',
      expect: TID.threadView,
      run: async ({ pages, page, stack }) => {
        // the approved call is made by a job a moment after the decision: wait for the message itself, not for the card that shows its preview
        await expect
          .poll(async () => Number((await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages WHERE body LIKE 'Hi, thanks for writing in.%'`))[0]?.n ?? 0), { timeout: 60_000 })
          .toBe(1);
        const channel = pages.inTeam(TEAM).channel;
        await channel.open('support');
        await channel.openThread(channel.message('Draft a reply to the customer').first());
        await expect(page.getByTestId(TID.threadView).getByText(/Hi, thanks for writing in/).first()).toBeVisible({ timeout: 60_000 });
      },
    },
  ],
  outcome: async ({ stack }) => {
    const rows = await stack.sql<{ status: string }>(`SELECT status FROM app.approvals WHERE tool = 'messages.post' AND args_preview::text LIKE '%thanks for writing in%' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]?.status, 'the lead decided it').toBe('approved');
    const posted = await stack.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE a.kind = 'bot' AND m.body LIKE 'Hi, thanks for writing in.%'`,
    );
    expect(Number(posted[0]?.n ?? 0), 'the approved draft was posted once, by the bot').toBe(1);
  },
});
