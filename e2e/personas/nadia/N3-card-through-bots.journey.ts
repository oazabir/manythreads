// N3 · Nadia makes a card for a small change, takes it, and hands it to Coder from the card panel (PLAN §4; the first hop of Coder, Reviewer, Tester). The later hops are the bots' own
// work on a real runner and model; they are not shown here (the Bot Board journey N10 shows the cards of a whole run). The platform parts are real: the card, the claim, the handover row.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';

const TITLE = 'Reset filters button on the search page';

export default defineJourney({
  id: 'N3',
  persona: 'nadia',
  goal: 'Make a card for a small change, take it, and hand it to Coder with a note.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'open-boards',
      expect: TID.boardView,
      next: { testid: 'new-card', label: 'New card' },
      run: async ({ pages, page }) => {
        await pages.boards.open();
        await expect(page.getByTestId('new-card')).toBeVisible();
      },
    },
    {
      id: 'card-form',
      expect: TID.boardView,
      next: { testid: 'create-card', label: 'Create card' },
      run: async ({ page }) => {
        await page.getByTestId('new-card').click();
        await page.getByTestId('new-card-title').fill(TITLE);
        await expect(page.getByTestId('new-card-form')).toBeVisible();
      },
    },
    {
      id: 'card-made',
      expect: TID.boardView,
      next: { testid: TID.boardCard, label: 'The card' },
      run: async ({ pages, page }) => {
        await page.getByTestId('create-card').click();
        await expect(pages.boards.card(TITLE)).toBeVisible();
      },
    },
    {
      id: 'card-claimed',
      expect: TID.cardPanel,
      next: { testid: 'card-handoff', label: 'Hand over' },
      run: async ({ pages, page }) => {
        const panel = await pages.boards.openCard(TITLE);
        await panel.getByTestId('card-claim').click();
        await expect(panel.getByTestId('card-owner')).toContainText('Nadia');
        await expect(page.getByTestId('card-handoff')).toBeVisible();
      },
    },
    {
      id: 'handed-to-coder',
      expect: TID.cardPanel,
      run: async ({ page }) => {
        await page.getByTestId('card-note').fill('Please start from the search page component.');
        await page.getByTestId('card-handoff-bot').selectOption({ label: 'Coder' });
        await page.getByTestId('card-handoff').click();
        await expect(page.getByTestId('card-owner')).toContainText('Coder', { timeout: 30_000 });
      },
    },
  ],
  outcome: async ({ stack }) => {
    const rows = await stack.sql<{ owner: string }>(
      `SELECT b.slug AS owner FROM app.tasks t JOIN app.actors a ON a.id = t.owner_id AND a.kind = 'bot' JOIN app.bots b ON b.id = a.ref_id WHERE t.title = $1`,
      [TITLE],
    );
    expect(rows.length, 'the card exists and a bot owns it').toBe(1);
    expect(rows[0]?.owner).toBe('coder');
  },
});
