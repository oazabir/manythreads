import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { CHANNEL, buildStory, type Story } from '../support/story.ts';
import { DESKTOP, comparePlate, openPage, scrollToFirstDay, type PlateSpec } from '../support/vt.ts';

/*
 * The channel with a thread open in the right panel vs [proto §02 plate 1 · Channel, with a thread open in the right panel]
 * (section app, plate 1). Class P: landmarks within 6 px, at most 6% differing pixels of the whole frame (1440x700, the plate's size),
 * data-copy strings exact. Times and avatars are masked on both sides (`[data-vt-mask]` live, `masks` on the plate).
 */
const PLATE: PlateSpec = {
  section: 'app',
  n: 1,
  paneSelector: '.app',
  padding: [0, 0, 0, 0],
  railWidth: 0,
  extraWidth: 2,
  regions: {
    'team-switch': '.side .team',
    search: '.side .srch',
    sidebar: '.side .nav',
    header: '.main .chead',
    content: '.main .stream, .main .composer',
    'right-panel': '.rp',
  },
  // times and day labels, the avatars, the prototype's bot lanes (no bots before phase 5), the reply counters (they carry the time of the last reply) and the sidebar's channel groups and bots
  // (workspace data of the seed; the prototype lists channels of another workspace and six bots)
  masks: ['.av', 'time', '.nav .pill', '.daysep', '.lane', '.nav > .grp', '.nav > .grp ~ *', '.rph .sub'],
};

let stack: Stack;
let story: Story;
test.skip(({ isMobile }) => isMobile, 'desktop plate');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
  story = await buildStory(playwright, stack);
});
test.afterAll(async () => {
  await Promise.all(story?.apis.map((a) => a.ctx.dispose()) ?? []);
  await stack?.stop();
});

test('the channel with a thread matches plate 1 (P)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    // a first visit reads the channel; the second shows it as the plate does: nothing new, the first day at the top
    await page.goto(`/t/engineering/c/${CHANNEL}`);
    await expect(page.getByTestId('message')).toHaveCount(8);
    await expect(page.locator('a.it', { hasText: CHANNEL }).locator('.pill')).toHaveCount(0);
    await page.goto(`/t/engineering/c/${CHANNEL}?panel=thread:${story.rootId}`);
    await expect(page.getByTestId('message')).toHaveCount(8 + 1 + 6);
    await expect(page.getByTestId('unread-divider')).toHaveCount(0);
    await page.setViewportSize({ width: DESKTOP.width, height: 700 });
    await scrollToFirstDay(page);
    // the plate shows the thread from its root and nothing focused
    await page.locator('.right-panel .rpb').evaluate((el) => (el.scrollTop = 0));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // the prototype's agent lanes: the live rows of the same words are masked
    for (const id of story.agentRows) await page.locator(`[data-message-id="${id}"] .txt, [data-message-id="${id}"] .atts, [data-message-id="${id}"] .replies`).evaluateAll((els) => els.forEach((el) => el.setAttribute('data-vt-mask', '')));
    await comparePlate(page, browser, testInfo, {
      cls: 'P',
      spec: PLATE,
      liveRegion: '[data-testid="app-frame"]',
      height: 700,
      liveMasks: ['.av', '.replies', '.rail .hint', '.jump', '.panel-sub', '.rail .channel-groups', '.rail [data-slot="direct-messages"]', '.rail .sec'],
      order: ['team-switch', 'search', 'sidebar', 'header', 'content', 'right-panel'],
      exact: ['team-switch', 'search', 'sidebar', 'header', 'content', 'right-panel'],
    });
  } finally {
    await close();
  }
});
