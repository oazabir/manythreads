// The harness's own example (PLAN P12-01 "one short example journey"): Omar opens #dev, writes a line, then looks at the bot roster and the approvals inbox.
// It exists to prove the harness end to end (sign-in, steps, pictures, manifest, completeness, canary). The real journeys are written in P12-03.
// The two middle steps use the message box, so the canary build (`VITE_MANYTHREADS_CANARY=hide-composer`) must fail exactly those and the step before them.
import { expect } from '@playwright/test';
import { defineJourney } from '../journey.ts';
import { TID } from '../../../pages/index.ts';

const LINE = 'Release notes are ready for a look, thanks both.';

export default defineJourney({
  id: 'O1',
  persona: 'omar',
  goal: 'Say something to the team in #dev, then check what my bots and approvals are doing.',
  markers: [],
  start: 'week-2',
  fewerShots: 'harness example: a short journey that proves the harness',
  steps: [
    {
      id: 'open-dev',
      expect: TID.channelView,
      next: { testid: TID.composer, label: 'Message box' },
      run: async ({ pages }) => {
        await pages.channel.open('dev');
      },
    },
    {
      id: 'typed',
      expect: TID.composer,
      next: { testid: TID.send, label: 'Send' },
      run: async ({ pages }) => {
        await pages.channel.input.fill(LINE);
      },
    },
    {
      id: 'posted',
      expect: TID.message,
      composer: true,
      run: async ({ pages }) => {
        await pages.channel.input.press('Enter');
        await expect(pages.channel.message(LINE)).toBeVisible();
      },
    },
    {
      id: 'bots',
      expect: TID.botsRoster,
      next: { testid: TID.botRow, label: 'A bot' },
      run: async ({ pages }) => {
        await pages.bots.open();
      },
    },
    {
      id: 'approvals',
      expect: TID.approvalsInbox,
      run: async ({ pages }) => {
        await pages.approvals.open();
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const omar = await api('omar');
    const dev = await omar.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels');
    const channel = dev.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'dev');
    expect(channel, 'the #dev channel is in the directory').toBeTruthy();
    const rows = await stack.sql<{ n: string }>("select count(*)::text as n from app.messages where body ilike '%' || $1 || '%'", [LINE.slice(0, 20)]);
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
  },
});
