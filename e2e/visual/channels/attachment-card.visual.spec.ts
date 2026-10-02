import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { CHANNEL, buildStory, type Story } from '../support/story.ts';
import { DESKTOP, comparePlate, openPage, scrollToFirstDay, type PlateSpec } from '../support/vt.ts';

/*
 * The message attachment card, within [proto §02 plate 1 · Channel, with a thread open in the right panel] (section app, plate 1): the
 * first message of the stream (its words, its PDF card and its reply count) against the live message that carries the report. Class
 * P-loose: landmark order and presence, at most 12% differing pixels. The plate renders at the full frame's width so the message has the
 * width it has on screen (a 1440 px window with the thread panel open); times and avatars are masked on both sides.
 */
const PLATE: PlateSpec = {
  section: 'app',
  n: 1,
  paneSelector: '.main .stream > .msg:nth-child(2)',
  padding: [0, 0, 0, 0],
  railWidth: 0,
  viewportWidth: 1488,
  regions: { attachment: '.att' },
  masks: ['.av', 'time', '.replies .faces'],
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

test('the attachment card matches the card of plate 1 (P-loose)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto(`/t/engineering/c/${CHANNEL}`);
    await expect(page.getByTestId('message').first()).toBeVisible();
    await page.goto(`/t/engineering/c/${CHANNEL}?panel=thread:${story.rootId}`);
    await expect(page.getByTestId('attachment').first()).toBeVisible();
    await scrollToFirstDay(page);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.querySelector('[data-testid="message"]:has([data-testid="attachment"])')?.setAttribute('data-card-message', '');
    });
    await comparePlate(page, browser, testInfo, {
      cls: 'P-loose',
      spec: PLATE,
      liveRegion: '[data-card-message]',
      height: 120,
      liveMasks: ['.av'],
      order: ['attachment'],
    });
  } finally {
    await close();
  }
});
