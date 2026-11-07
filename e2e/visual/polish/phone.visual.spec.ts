import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { plate } from '../support/polish.ts';

/*
 * The phone shell in the Phase 21 look (P21-23, P21-24): 390 wide only, light and dark (class W, own baselines under
 * __baselines__/visual/polish/phone.visual.spec.ts/). The bottom bar with its five places, a channel with the bar under the composer, the Messages
 * page and a bot's page with the bar under it. The wide plates of the same screens are in the other polish specs.
 */
test.skip(({ isMobile }) => isMobile, 'desktop project: the spec sets its own viewports');
test.use({ actionTimeout: 10_000 });
test.setTimeout(180_000);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000); // the web client is built and the stack is seeded first: slow on a busy machine
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'polish', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('bottom bar: the five places, the current one marked', async ({ browser }) => {
  await plate(browser, stack, 'bottom-bar', {
    sizes: ['390'],
    go: async (page) => {
      await page.goto('/t/engineering');
      await expect(page.getByTestId('bar-search')).toBeVisible();
      await expect(page.getByTestId('bottom-bar')).toBeVisible();
    },
  });
});

test('channel: the messages with the bar under the composer', async ({ browser }) => {
  await plate(browser, stack, 'phone-channel', {
    sizes: ['390'],
    go: async (page) => {
      await page.goto('/t/engineering/c/polish');
      await expect(page.getByTestId('message').first()).toBeVisible();
      await expect(page.getByTestId('bar-search')).toBeVisible();
    },
  });
});

test('messages page: the conversations on a phone', async ({ browser }) => {
  await plate(browser, stack, 'phone-messages', {
    sizes: ['390'],
    go: async (page) => {
      await page.goto('/t/engineering/dms');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  });
});

test('bot page: a definition on a phone', async ({ browser }) => {
  await plate(browser, stack, 'phone-bot-page', {
    sizes: ['390'],
    go: async (page) => {
      await page.goto('/t/engineering/bots/coder?tab=identity');
      await expect(page.getByTestId('bot-role')).toBeVisible();
    },
  });
});
