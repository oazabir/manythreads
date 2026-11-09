// T20 · Tariq's main screens in their empty, error, loading and denied states (PLAN P13-01). The server's answer is forced for the one request that fills the screen; nothing is
// written, so the journey leaves no leftovers. Every state must show words and a way on, never a blank screen or a spinner that stays.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { TARIQ_ENV } from './support/index.ts';
import { statesSweep } from './support/sweep.ts';

const INBOX = '**/api/teams/marketing/threads?*';
const JOBS = '**/api/teams/marketing/scheduled-jobs';
const TREE = '**/api/teams/marketing/files/tree?*';

const sweep = statesSweep([
  {
    id: 'threads-empty',
    path: '/t/marketing/threads',
    expect: TID.threadsInbox,
    state: 'empty',
    pattern: INBOX,
    emptyBody: { items: [], nextCursor: null },
    see: (page) => expect(page.getByTestId('threads-empty')).toBeVisible(),
  },
  {
    id: 'threads-error',
    path: '/t/marketing/threads',
    expect: TID.threadsInbox,
    state: 'error',
    pattern: INBOX,
    see: (page) => expect(page.getByText('Could not load threads.')).toBeVisible(),
  },
  {
    id: 'threads-loading',
    path: '/t/marketing/threads',
    expect: TID.threadsInbox,
    state: 'loading',
    pattern: INBOX,
  },
  {
    id: 'jobs-empty',
    path: '/t/marketing/jobs',
    expect: 'scheduled-jobs-screen',
    state: 'empty',
    pattern: JOBS,
    emptyBody: { items: [] },
    see: (page) => expect(page.getByTestId('scheduled-jobs-empty')).toBeVisible(),
  },
  {
    id: 'jobs-error',
    path: '/t/marketing/jobs',
    expect: 'scheduled-jobs-screen',
    state: 'error',
    pattern: JOBS,
  },
  {
    id: 'files-error',
    path: '/t/marketing/files',
    expect: TID.frame,
    state: 'error',
    pattern: TREE,
  },
  {
    id: 'brain-empty',
    path: '/t/marketing/chat',
    expect: TID.chatScreen,
    state: 'natural',
    see: (page) => expect(page.getByTestId(TID.chatEmpty)).toBeVisible(),
  },
  {
    id: 'support-denied',
    path: '/t/customer-support/c/support',
    expect: TID.frame,
    state: 'denied',
    see: (page) => expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible(),
  },
]);

export default defineJourney({
  id: 'T20',
  persona: 'tariq',
  goal: 'See what my threads, jobs, files and Brain say when there is nothing, when the server fails, while they load, and when I look where I may not.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  steps: sweep.steps,
  outcome: async ({ page }) => {
    await sweep.finish();
    await page.goto('/t/marketing/threads');
    await expect(page.getByTestId(TID.threadsInbox)).toBeVisible();
    await expect(page.getByTestId('threads-empty'), 'the forced empty state was removed').toHaveCount(0);
  },
});
