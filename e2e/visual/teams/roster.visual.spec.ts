import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * Team roster vs [proto §03 plate 1 · Team roster] (section teams, plate 1). Class P-loose: the plate's team is a seven-person
 * Engineering with bots that already run; here the people are the seeded Engineering seats and the plate's Bots section is the
 * template definition panel (channels, board, bots as text; PLAN phase 2 section 5). Landmark order and presence, at most
 * 12% differing pixels of the pane.
 */
const PLATE: PlateSpec = {
  section: 'teams',
  n: 1,
  paneSelector: '.set .pane',
  padding: [24, 28, 24, 28],
  railWidth: 214,
  regions: {
    title: '.pane h3',
    lede: '.pane .lede',
    people: '.pane > .block:nth-of-type(1)',
    'template-definition': '.pane > .block:nth-of-type(2)',
  },
};

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('roster matches the Team roster plate (P-loose)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar');
  try {
    await page.goto('/settings/team/engineering/roster');
    await expect(page.getByRole('heading', { name: 'Engineering', level: 1 })).toBeVisible();
    await expect(page.locator('[data-landmark="template-definition"]')).toBeVisible();
    await comparePlate(page, browser, testInfo, {
      cls: 'P-loose',
      spec: PLATE,
      liveRegion: '[data-landmark="roster"]',
      order: ['title', 'lede', 'people', 'template-definition'],
    });
  } finally {
    await close();
  }
});
