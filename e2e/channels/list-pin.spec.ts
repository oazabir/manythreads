import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, openOn } from '../support/stack-browser.ts';

/*
 * The message list stays pinned to the newest message when what sits next to it grows twice in a row (the composer gets an upload chip,
 * then another). The browser dispatches a scroll event after the frame's layout, so a pin the list made one frame earlier was measured
 * against the new, smaller viewport and looked like the reader scrolling up: "Jump to latest" appeared and the list stopped following.
 * It showed as a rare pixel diff of `visual/channels/composer` on a loaded machine; here the two growths are ordered on purpose.
 */
test.skip(({ isMobile }) => isMobile, 'the spec opens its own phone-sized page');

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a pin followed by more growth in the next task keeps the list at the bottom', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('message').first()).toBeVisible();
    await page.waitForTimeout(1_500); // fonts and rows measured; the list sits at the bottom
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toHaveCount(0);
    await page.evaluate(async () => {
      const box = document.querySelector<HTMLElement>('.vlist');
      if (!box) throw new Error('no message list');
      const block = (h: number): HTMLElement => {
        const d = document.createElement('div');
        d.style.cssText = `flex:none;height:${h}px`;
        return d;
      };
      const first = block(60);
      box.after(first); // the list shrinks: its observer pins it in this frame's observer step
      await new Promise<void>((done) => {
        const ro = new ResizeObserver(() => {
          ro.disconnect();
          // after that step, before the next frame dispatches the scroll event the pin produced
          setTimeout(() => {
            first.after(block(60));
            done();
          }, 0);
        });
        ro.observe(box);
      });
    });
    await page.waitForTimeout(500);
    await expect(jump).toHaveCount(0);
  } finally {
    await context.close();
  }
});
