import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { noSidewaysScroll } from '../../support/stack-browser.ts';
import { CHANNEL, buildStory, type Story } from '../support/story.ts';
import { MOBILE, comparePlate, expectLandmarkOrder, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * The phone vs [proto §02 plate 6 · Phone] (section app, plate 6), class P-loose: landmark order and presence, at most 12% differing
 * pixels. The plate is three device frames of 300x620 (a 282x602 screen inside a 9 px bezel) with a status bar and a tab bar that a
 * browser does not have, so the live thread sheet is rendered at the plate's screen size for the pixel comparison and, at 390x844, held
 * to the landmarks of the layout and to "no sideways scroll".
 */
const PLATE: PlateSpec = {
  section: 'app',
  n: 6,
  frameSelector: '.phones',
  paneSelector: '.phone:nth-child(3)',
  padding: [9, 9, 9, 9],
  railWidth: 0,
  regions: { 'panel-header': '.phone:nth-child(3) .phead', 'panel-body': '.phone:nth-child(3) .pstream' },
  masks: ['.av', '.pbar', '.lane', '.daysep'],
};

let stack: Stack;
let story: Story;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
  story = await buildStory(playwright, stack);
});
test.afterAll(async () => {
  await Promise.all(story?.apis.map((a) => a.ctx.dispose()) ?? []);
  await stack?.stop();
});

test('390x844: the channel, its drawer and the thread sheet keep the phone layout', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', MOBILE, true);
  try {
    await page.goto(`/t/engineering/c/${CHANNEL}?panel=thread:${story.rootId}`);
    await expect(page.getByTestId('message').first()).toBeVisible();
    await expectLandmarkOrder(page, ['panel-header', 'panel-body']);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
  }
});

test('the thread sheet matches the Phone plate (P-loose)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', { width: 282, height: 602 }, true);
  try {
    await page.goto(`/t/engineering/c/${CHANNEL}?panel=thread:${story.rootId}`);
    await expect(page.getByTestId('message').first()).toBeVisible();
    await page.locator('.right-panel .rpb').evaluate((el) => (el.scrollTop = 0));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const id of story.agentRows) await page.locator(`[data-message-id="${id}"] .txt, [data-message-id="${id}"] .atts`).evaluateAll((els) => els.forEach((el) => el.setAttribute('data-vt-mask', '')));
    await comparePlate(page, browser, testInfo, {
      cls: 'P-loose',
      spec: PLATE,
      liveRegion: '[data-testid="app-frame"]',
      height: 602,
      liveMasks: ['.av'],
      order: ['panel-header', 'panel-body'],
    });
  } finally {
    await close();
  }
});
