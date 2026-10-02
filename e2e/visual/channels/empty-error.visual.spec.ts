import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, type StackApi } from '../../support/stack-browser.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The channel's three plain states (PLAN phase 3 section 2 copy, own baselines, class W): an empty channel ("This is the start of
 * #quiet."), a channel that cannot be seen ("You cannot see this channel.") and a failed send ("Not sent · Retry"). 1440x900 and
 * 390x844: empty-channel-1440/390.png, no-access-1440/390.png, not-sent-1440/390.png.
 */
let stack: Stack;
let omar: StackApi;
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewports');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
  omar = await apiOn(playwright, stack, 'omar');
  await omar.post('/api/teams/engineering/channels', { name: 'quiet', purpose: 'Nothing here yet.' });
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

for (const [size, viewport, mobile] of [
  ['1440', DESKTOP, false],
  ['390', MOBILE, true],
] as const) {
  const order = mobile ? [['header', 'content']] : [['search', 'sidebar'], ['header', 'content']];
  test(`empty channel at ${size} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'omar', viewport, mobile);
    try {
      await page.goto('/t/engineering/c/quiet');
      await expect(page.getByText('This is the start of #quiet.')).toBeVisible();
      await expectWireframe(page, `empty-channel-${size}`, order);
    } finally {
      await close();
    }
  });

  test(`no access at ${size} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'lena', viewport, mobile);
    try {
      await page.goto('/t/engineering/c/dev');
      await expect(page.getByText('You cannot see this channel.')).toBeVisible();
      await expectWireframe(page, `no-access-${size}`, order);
    } finally {
      await close();
    }
  });

  test(`failed send at ${size} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'omar', viewport, mobile);
    try {
      await page.goto('/t/engineering/c/quiet');
      await expect(page.getByText('This is the start of #quiet.')).toBeVisible();
      await page.route('**/api/channels/*/messages', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
      await page.getByRole('textbox', { name: 'Message #quiet' }).fill('Is the rota final?');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByText('Not sent ·')).toBeVisible();
      await expectWireframe(page, `not-sent-${size}`, order);
    } finally {
      await close();
    }
  });
}
