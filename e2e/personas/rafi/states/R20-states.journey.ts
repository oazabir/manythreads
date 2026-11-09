// R20 · Rafi's main screens in their empty, error, loading and denied states (PLAN P13-01). The server's answer is forced for the one request that fills the screen; nothing is
// written, so the journey leaves no leftovers. Every state must show words and a way on, never a blank screen or a spinner that stays.
import { expect } from '@playwright/test';
import { defineJourney } from '../../harness/journey.ts';
import { TID } from '../../../pages/index.ts';
import { statesSweep } from '../../omar/support/sweep.ts';
import { askFromPage } from '../../omar/support/index.ts';

const APPROVALS = '**/api/teams/engineering/approvals?*';
const INBOX = '**/api/teams/engineering/threads?*';
const MESSAGES = '**/api/channels/*/messages?*';

const sweep = statesSweep([
  { id: 'approvals-empty', path: '/t/engineering/approvals', expect: TID.approvalsInbox, state: 'empty', pattern: APPROVALS, emptyBody: { items: [], waiting: 0 }, see: (page) => expect(page.getByTestId('approvals-empty')).toBeVisible() },
  { id: 'approvals-error', path: '/t/engineering/approvals', expect: TID.frame, state: 'error', pattern: APPROVALS },
  { id: 'approvals-loading', path: '/t/engineering/approvals', expect: TID.frame, state: 'loading', pattern: APPROVALS },
  { id: 'threads-empty', path: '/t/engineering/threads', expect: TID.threadsInbox, state: 'empty', pattern: INBOX, emptyBody: { items: [], nextCursor: null }, see: (page) => expect(page.getByTestId('threads-empty')).toBeVisible() },
  { id: 'incidents-error', path: '/t/engineering/c/incidents', expect: TID.frame, state: 'error', pattern: MESSAGES },
  { id: 'incidents-loading', path: '/t/engineering/c/incidents', expect: TID.frame, state: 'loading', pattern: MESSAGES },
  { id: 'incidents-empty', path: '/t/engineering/c/incidents', expect: TID.frame, state: 'empty', pattern: MESSAGES, emptyBody: { items: [], nextCursor: null } },
  { id: 'support-denied', path: '/t/customer-support/c/support', expect: TID.frame, state: 'denied', status: 403, see: async (page) => {
    await expect(page.getByRole('heading', { name: /You do not have access/ })).toBeVisible();
    expect(await askFromPage(page, 'GET', '/api/teams/customer-support/approvals'), 'the server refuses the same team').toBe(403);
  } },
]);

export default defineJourney({
  id: 'R20',
  persona: 'rafi',
  goal: 'See what my approvals, threads and the incidents channel say when there is nothing, when the server fails, while they load, and when I look where I may not.',
  markers: [],
  start: 'week-2',
  steps: sweep.steps,
  outcome: async ({ page }) => {
    await sweep.finish();
    await page.goto('/t/engineering/c/incidents');
    await expect(page.getByTestId(TID.channelView)).toBeVisible();
    await expect(page.getByTestId(TID.message).first(), 'the forced answers were removed').toBeVisible();
  },
});
