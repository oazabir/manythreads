import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { buildStory, type Story } from '../support/story.ts';
import { DESKTOP, comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * The Threads inbox vs [proto §02 plate 2 · Threads] (section app, plate 2). Class P: landmarks within 6 px, at most 6% differing
 * pixels of the whole frame (1440x700, the plate's size). Times, counts and avatars are masked on both sides. The plate's board thread
 * (G-26) has no live counterpart before boards exist; the bot lanes and the goal card are masked as in the channel plate.
 */
const PLATE: PlateSpec = {
  section: 'app',
  n: 2,
  paneSelector: '.app',
  padding: [0, 0, 0, 0],
  railWidth: 0,
  extraWidth: 2,
  regions: {
    'team-switch': '.side .team',
    search: '.side .srch',
    sidebar: '.side .nav',
    'thread-list': '.inl',
    'thread-view': '.inr',
  },
  masks: ['.av', 'time', '.nav .pill', '.nav > .grp', '.nav > .grp ~ *', '.lane', '.trow .meta', '.tabs2 span:nth-child(2)'],
};

let stack: Stack;
let story: Story;
test.skip(({ isMobile }) => isMobile, 'desktop plate');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
  story = await buildStory(playwright, stack, { inbox: true });
});
test.afterAll(async () => {
  await Promise.all(story?.apis.map((a) => a.ctx.dispose()) ?? []);
  await stack?.stop();
});

test('the Threads inbox matches plate 2 (P)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/threads');
    // the plate is a returning person's inbox: the first-day card has been put away
    await page.getByRole('button', { name: 'Dismiss welcome' }).click();
    await expect(page.getByTestId('welcome-card')).toHaveCount(0);
    await expect(page.getByTestId('thread-row').first()).toBeVisible();
    await expect(page.getByTestId('thread-view')).toBeVisible();
    await expect(page.getByTestId('message')).toHaveCount(7);
    await page.setViewportSize({ width: DESKTOP.width, height: 700 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const id of story.agentRows) await page.locator(`[data-message-id="${id}"] .txt, [data-message-id="${id}"] .atts`).evaluateAll((els) => els.forEach((el) => el.setAttribute('data-vt-mask', '')));
    await comparePlate(page, browser, testInfo, {
      cls: 'P',
      spec: PLATE,
      liveRegion: '[data-testid="app-frame"]',
      height: 700,
      liveMasks: ['.av', '.rail .hint', '.rail .channel-groups', '.rail [data-slot="direct-messages"]', '.rail .sec', '.trow .meta'],
      order: ['team-switch', 'search', 'sidebar', 'thread-list', 'thread-view'],
      exact: ['team-switch', 'search', 'sidebar', 'thread-list', 'thread-view'],
    });
  } finally {
    await close();
  }
});
