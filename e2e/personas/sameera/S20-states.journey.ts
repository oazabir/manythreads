// S20 · Sameera's main screens in their empty, error, loading and denied states (PLAN P13-01). The server's answer is forced for the one request that fills the screen; nothing is
// written, so the journey leaves no leftovers. Every state must show words and a way on, never a blank screen or a spinner that stays.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { statesSweep } from '../nadia/support/sweep.ts';

const INBOX = '**/api/teams/customer-support/threads?*';
const APPROVALS = '**/api/teams/customer-support/approvals?*';
const sweep = statesSweep([
  {
    id: 'threads-empty',
    path: '/t/customer-support/threads',
    expect: TID.threadsInbox,
    state: 'empty',
    pattern: INBOX,
    emptyBody: { items: [], nextCursor: null },
    see: (page) => expect(page.getByTestId('threads-empty')).toBeVisible(),
  },
  {
    id: 'threads-error',
    path: '/t/customer-support/threads',
    expect: TID.threadsInbox,
    state: 'error',
    pattern: INBOX,
    see: (page) => expect(page.getByText('Could not load threads.')).toBeVisible(),
  },
  {
    id: 'threads-loading',
    path: '/t/customer-support/threads',
    expect: TID.threadsInbox,
    state: 'loading',
    pattern: INBOX,
  },
  {
    id: 'approvals-empty',
    path: '/t/customer-support/approvals',
    expect: TID.approvalsInbox,
    state: 'empty',
    pattern: APPROVALS,
    emptyBody: { items: [], waiting: 0 },
    see: (page) => expect(page.getByTestId('approvals-empty')).toBeVisible(),
  },
  {
    id: 'approvals-error',
    path: '/t/customer-support/approvals',
    expect: TID.frame,
    state: 'error',
    pattern: APPROVALS,
  },
  {
    id: 'channel-denied',
    path: '/t/engineering/c/dev',
    expect: TID.frame,
    state: 'denied',
    see: (page) => expect(page.getByRole('heading', { name: /You do not have access/ })).toBeVisible(),
  },
]);

export default defineJourney({
  id: 'S20',
  persona: 'sameera',
  goal: 'See what my inbox, approvals and the channel of a closed team say when there is nothing, when the server fails, while it loads, and when I may not look.',
  markers: [],
  start: 'week-2',
  steps: sweep.steps,
  outcome: async ({ page }) => {
    await sweep.finish();
    await page.goto('/t/customer-support/threads');
    await expect(page.getByTestId(TID.threadsInbox)).toBeVisible();
  },
});
