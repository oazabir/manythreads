// R2 (B): an incident is open in #incidents; Rafi asks Brain what the team did last time and opens the source it cites.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, allowChatStateRace, readyForBots } from '../omar/support/index.ts';

const QUESTION = 'The search index is behind again. What did we do in the last indexer incident?';

export default defineJourney({
  id: 'R2',
  persona: 'rafi',
  goal: 'An incident is open: ask Brain what we did last time, and check the source it cites.',
  markers: ['B'],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  steps: [
    {
      id: 'incidents',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async (ctx) => {
        allowChatStateRace(ctx);
        await readyForBots(ctx.stack);
        await ctx.pages.channel.open('incidents');
        await expect(ctx.pages.channel.message('INC-32')).toBeVisible();
      },
    },
    {
      id: 'brain-open',
      expect: TID.chatEmpty,
      next: { testid: TID.chatMain, label: 'Message Brain' },
      run: async ({ pages }) => {
        await pages.brain.open();
      },
    },
    {
      id: 'question-typed',
      expect: TID.chatMain,
      next: { testid: TID.chatMain, label: 'Send with Enter' },
      run: async ({ pages }) => {
        await pages.brain.input.fill(QUESTION);
      },
    },
    {
      id: 'answer',
      expect: TID.answer,
      next: { testid: TID.answerCitation, label: 'Source 1' },
      run: async ({ pages }) => {
        await pages.brain.input.press('Enter');
        await expect(pages.brain.botMessages.last().getByTestId(TID.answerCitation).first()).toBeVisible({ timeout: 90_000 });
        await expect(pages.brain.thinking).toHaveCount(0, { timeout: 30_000 });
      },
    },
    {
      id: 'sources-open',
      expect: TID.answer,
      next: { testid: TID.answerCitation },
      run: async ({ pages }) => {
        await pages.brain.botMessages.last().getByTestId('answer-sources').locator('summary').click();
        await expect(pages.brain.botMessages.last().getByTestId('answer-lineage-row').first()).toBeVisible();
      },
    },
    {
      id: 'source-in-channel',
      expect: TID.channelView,
      next: { testid: TID.message },
      run: async ({ pages, page }) => {
        // on a phone the answer is scrolled under the header by now and the chip cannot be brought into view: the tap is sent to the link itself
        await pages.brain.botMessages.last().getByTestId(TID.answerCitation).first().evaluate((el) => (el as HTMLElement).click());
        await expect(page).toHaveURL(/\/t\/engineering\/c\/[a-z-]+\?message=/);
      },
    },
  ],
  outcome: async ({ stack }) => {
    // Rafi's own question and the Answer that came after it in his chat with Brain (other journeys of the stack have Answers too: this one is found by his words)
    const rows = await stack.sql<{ citations: Array<{ kind: string; messageId?: string; channelName?: string | null }> }>(
      `SELECT a.meta->'answer'->'citations' AS citations
         FROM app.messages q
         JOIN app.actors qa ON qa.id = q.author_id
         JOIN app.people p ON p.id = qa.ref_id AND p.display_name = 'Rafi'
         JOIN app.messages a ON a.channel_id = q.channel_id AND a.meta ? 'answer' AND a.created_at > q.created_at
        WHERE q.body = $1
        ORDER BY a.created_at LIMIT 1`,
      [QUESTION],
    );
    expect(rows, "Rafi's question has an Answer after it").toHaveLength(1);
    const cited = rows[0]!.citations.filter((c) => c.kind === 'message');
    expect(cited.length, 'the Answer to his question cites at least one message').toBeGreaterThan(0);
    // what it cites is a message of a channel he can open, found in the database (not the stand-in's word for it)
    const real = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE c.kind = 'channel' AND m.id = ANY($1::uuid[])`, [cited.map((c) => c.messageId)]);
    expect(Number(real[0]!.n), 'every cited message is a message of a channel').toBe(cited.length);
  },
});
