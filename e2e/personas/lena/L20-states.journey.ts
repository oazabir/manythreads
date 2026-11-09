// L20 · Lena's main screens in their empty, error, loading and denied states (PLAN P13-01). The server's answer is forced for the one request that fills the screen; nothing is
// written, so the journey leaves no leftovers. Every state must show words and a way on, never a blank screen or a spinner that stays. A guest has one channel and search.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LENA_ENV } from './support/index.ts';
import { statesSweep } from './support/sweep.ts';

const sweep = statesSweep([
  {
    id: 'releases-error',
    path: '/t/engineering/c/releases',
    expect: TID.frame,
    state: 'error',
    pattern: '**/api/channels/*/messages?*',
  },
  {
    id: 'releases-loading',
    path: '/t/engineering/c/releases',
    expect: TID.frame,
    state: 'loading',
    pattern: '**/api/channels/*/messages?*',
  },
  {
    id: 'releases-empty',
    path: '/t/engineering/c/releases',
    expect: TID.frame,
    state: 'empty',
    pattern: '**/api/channels/*/messages?*',
    emptyBody: { items: [], nextCursor: null },
  },
  {
    id: 'search-empty',
    path: '/t/engineering/search?q=nothing-matches-this-word',
    expect: TID.searchResults,
    state: 'natural',
    see: (page) => expect(page.getByTestId(TID.searchEmpty)).toBeVisible(),
  },
  {
    id: 'search-error',
    path: '/t/engineering/search?q=deploy',
    expect: TID.frame,
    state: 'error',
    pattern: '**/api/search?*',
  },
  {
    id: 'channel-denied',
    path: '/t/engineering/c/dev',
    expect: TID.noAccess,
    state: 'denied',
    see: (page) => expect(page.getByTestId(TID.noAccess)).toBeVisible(),
  },
]);

export default defineJourney({
  id: 'L20',
  persona: 'lena',
  goal: 'See what my one channel and search say when there is nothing, when the server fails, while they load, and when I look where I may not.',
  markers: [],
  start: 'week-2',
  stackEnv: LENA_ENV,
  steps: sweep.steps,
  outcome: async ({ page }) => {
    await sweep.finish();
    await page.goto('/t/engineering/c/releases');
    await expect(page.getByTestId(TID.channelView)).toBeVisible();
    await expect(page.getByTestId(TID.message).first(), 'the forced answers were removed').toBeVisible();
  },
});
