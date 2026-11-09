// O6 (A): Priya proposes a change to Coder's definition; Omar, who leads Engineering, reads the lines that change and the checks, applies it, and the bot's
// definition is his commit. Negative: nobody commits to bots/ directly, the admin included; the file says "Change by proposal".
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { waitForBot } from './support/index.ts';

const BOT = 'bots/coder/BOT.md';
const LINE = 'Always name the pull request you reviewed.';
const TITLE = 'Coder names the pull request';

export default defineJourney({
  id: 'O6',
  persona: 'omar',
  goal: "Review the change Priya proposed to Coder's definition, apply it, and see that nothing writes to bots/ any other way.",
  markers: ['A'],
  start: 'week-2',
  steps: [
    {
      id: 'proposal-waiting',
      expect: 'proposals-filter-all',
      next: { testid: 'proposal-row', label: 'The proposal' },
      run: async ({ api, page, stack }) => {
        await waitForBot(stack, 'coder');
        const priya = await api('priya');
        const base = await priya.get<{ content: string; blobSha: string }>(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(BOT)}`);
        const made = await priya.status('POST', '/api/teams/engineering/proposals', { path: BOT, content: `${base.content.trimEnd()}\n\n${LINE}\n`, baseBlobSha: base.blobSha, title: TITLE });
        expect(made, 'a member may propose').toBe(201);
        await page.goto('/t/engineering/proposals');
        await expect(page.getByTestId('proposal-row').filter({ hasText: TITLE })).toBeVisible();
      },
    },
    {
      id: 'lines-read',
      expect: 'proposal-diff',
      next: { testid: 'proposal-apply', label: 'Apply' },
      run: async ({ page }) => {
        await page.getByTestId('proposal-row').filter({ hasText: TITLE }).click();
        await expect(page.getByTestId('proposal-diff')).toContainText(LINE);
        await expect(page.getByTestId('proposal-checks')).toContainText('BOT.md loads');
        await expect(page.getByTestId('proposal-status')).toHaveAttribute('data-status', 'open');
      },
    },
    {
      id: 'applied',
      expect: 'proposal-status',
      run: async ({ page }) => {
        await page.getByTestId('proposal-apply').click();
        await expect(page.getByTestId('proposal-status')).toHaveAttribute('data-status', 'applied');
      },
    },
    {
      id: 'bots-read-only',
      expect: 'read-only-note',
      run: async ({ page, api }) => {
        await page.goto(`/t/engineering/files?open=${encodeURIComponent(BOT)}`);
        await expect(page.getByTestId('file-view').getByTestId('read-only-note')).toContainText('Change by proposal');
        await expect(page.getByTestId('file-view').getByRole('button', { name: 'Save' })).toHaveCount(0);
        // the door is shut too: a direct commit to bots/ is refused, even for the lead
        const omar = await api('omar');
        const res = await omar.ctx.post('/api/teams/engineering/repo/commit', { data: { changes: [{ op: 'put', path: BOT, content: 'changed\n', encoding: 'utf8' }], message: 'Change the bot' }, headers: await omar.headers() });
        expect(res.status(), 'a direct commit to bots/').toBe(403);
      },
    },
    {
      id: 'bot-page',
      expect: TID.botPage,
      next: { testid: 'open-conversation', label: 'Talk' },
      run: async ({ pages }) => {
        await pages.bot.open('coder');
      },
    },
  ],
  outcome: async ({ api }) => {
    const omar = await api('omar');
    const now = await omar.get<{ content: string }>(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(BOT)}`);
    expect(now.content, "Coder's definition holds the reviewed line").toContain(LINE);
  },
});
