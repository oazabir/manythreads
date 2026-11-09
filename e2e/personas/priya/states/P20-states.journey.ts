// P20 · Priya's main screens in their empty, error, loading and denied states (PLAN P13-01). The server's answer is forced for the one request that fills the screen; nothing is
// written, so the journey leaves no leftovers. Every state must show words and a way on, never a blank screen or a spinner that stays.
import { expect } from '@playwright/test';
import { defineJourney } from '../../harness/journey.ts';
import { TID } from '../../../pages/index.ts';
import { statesSweep } from '../../omar/support/sweep.ts';
import { askFromPage } from '../../omar/support/index.ts';

const INBOX = '**/api/teams/engineering/threads?*';
const APPROVALS = '**/api/teams/engineering/approvals?*';
const MESSAGES = '**/api/channels/*/messages?*';

const sweep = statesSweep([
  { id: 'threads-empty', path: '/t/engineering/threads', expect: TID.threadsInbox, state: 'empty', pattern: INBOX, emptyBody: { items: [], nextCursor: null }, see: (page) => expect(page.getByTestId('threads-empty')).toBeVisible() },
  { id: 'threads-error', path: '/t/engineering/threads', expect: TID.threadsInbox, state: 'error', pattern: INBOX, see: (page) => expect(page.getByText('Could not load threads.')).toBeVisible() },
  { id: 'threads-loading', path: '/t/engineering/threads', expect: TID.threadsInbox, state: 'loading', pattern: INBOX },
  { id: 'general-error', path: '/t/engineering/c/general', expect: TID.frame, state: 'error', pattern: MESSAGES },
  { id: 'general-loading', path: '/t/engineering/c/general', expect: TID.frame, state: 'loading', pattern: MESSAGES },
  { id: 'general-empty', path: '/t/engineering/c/general', expect: TID.frame, state: 'empty', pattern: MESSAGES, emptyBody: { items: [], nextCursor: null } },
  { id: 'approvals-empty', path: '/t/engineering/approvals', expect: TID.approvalsInbox, state: 'empty', pattern: APPROVALS, emptyBody: { items: [], waiting: 0 }, see: (page) => expect(page.getByTestId('approvals-empty')).toBeVisible() },
  { id: 'private-channel-denied', path: '/t/engineering/c/eng-leads', expect: TID.noAccess, state: 'denied', see: (page) => expect(page.getByTestId(TID.noAccess)).toBeVisible() },
  { id: 'support-denied', path: '/t/customer-support/c/support', expect: TID.frame, state: 'denied', status: 403, see: async (page) => {
    await expect(page.getByRole('heading', { name: /You do not have access/ })).toBeVisible();
    expect(await askFromPage(page, 'GET', '/api/teams/customer-support/approvals'), 'the server refuses the same team').toBe(403);
  } },
]);

export default defineJourney({
  id: 'P20',
  persona: 'priya',
  goal: 'See what my threads, channels and approvals say when there is nothing, when the server fails, while they load, and when I look where I may not.',
  markers: [],
  start: 'week-2',
  steps: sweep.steps,
  outcome: async ({ page }) => {
    await sweep.finish();
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId(TID.channelView)).toBeVisible();
    await expect(page.getByTestId(TID.message).first(), 'the forced answers were removed').toBeVisible();
  },
});
