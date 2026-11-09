// N20 · Nadia's main screens in their empty, error, loading and denied states (PLAN P13-01). The server's answer is forced for the one request that fills the screen; nothing is
// written, so the journey leaves no leftovers. Every state must show words and a way on, never a blank screen or a spinner that stays.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { statesSweep } from './support/sweep.ts';

const INBOX = '**/api/teams/engineering/threads?*';
const APPROVALS = '**/api/teams/engineering/approvals?*';
const BOARDS = '**/api/teams/engineering/boards';
const sweep = statesSweep([
  {
    id: 'threads-empty',
    path: '/t/engineering/threads',
    expect: TID.threadsInbox,
    state: 'empty',
    pattern: INBOX,
    emptyBody: { items: [], nextCursor: null },
    see: (page) => expect(page.getByTestId('threads-empty')).toBeVisible(),
  },
  {
    id: 'threads-error',
    path: '/t/engineering/threads',
    expect: TID.threadsInbox,
    state: 'error',
    pattern: INBOX,
    see: (page) => expect(page.getByText('Could not load threads.')).toBeVisible(),
  },
  {
    id: 'threads-loading',
    path: '/t/engineering/threads',
    expect: TID.threadsInbox,
    state: 'loading',
    pattern: INBOX,
  },
  {
    id: 'approvals-empty',
    path: '/t/engineering/approvals',
    expect: TID.approvalsInbox,
    state: 'empty',
    pattern: APPROVALS,
    emptyBody: { items: [], waiting: 0 },
    see: (page) => expect(page.getByTestId('approvals-empty')).toBeVisible(),
  },
  {
    id: 'approvals-error',
    path: '/t/engineering/approvals',
    expect: TID.frame,
    state: 'error',
    pattern: APPROVALS,
  },
  {
    id: 'boards-empty',
    path: '/t/engineering/boards',
    expect: TID.frame,
    state: 'empty',
    pattern: BOARDS,
    emptyBody: { items: [] },
    see: (page) => expect(page.getByTestId('boards-empty')).toBeVisible(),
  },
  {
    id: 'channel-denied',
    path: '/t/customer-support/c/support',
    expect: TID.frame,
    state: 'denied',
    see: (page) => expect(page.getByRole('heading', { name: /You do not have access/ })).toBeVisible(),
  },
]);

export default defineJourney({
  id: 'N20',
  persona: 'nadia',
  goal: 'See what my inbox, approvals, boards and a closed channel say when there is nothing, when the server fails, while it loads, and when I may not look.',
  markers: [],
  start: 'week-2',
  steps: sweep.steps,
  outcome: async ({ page }) => {
    await sweep.finish();
    await page.goto('/t/engineering/threads');
    await expect(page.getByTestId(TID.threadsInbox)).toBeVisible();
    await expect(page.getByTestId('threads-empty'), 'the forced empty state was removed').toHaveCount(0);
  },
});
