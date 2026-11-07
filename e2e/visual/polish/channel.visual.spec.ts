import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { plate } from '../support/polish.ts';

/*
 * The channel in the Phase 21 look (P21-24): a run of messages, the hover bar, the focused composer, the header, the details menu, a bot's Answer and the
 * Compact density, each in light and dark at 1440 and 390 (class W, own baselines under __baselines__/visual/polish/channel.visual.spec.ts/). One stack
 * with seed v21: `#polish` holds twelve short messages by Nadia inside five minutes, a 40-line message, an Answer with three citations and a thread of seven.
 * The fixed clock makes every date the same on every run; times are masked.
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

const CHANNEL = '/t/engineering/c/polish';
const FIRST_OF_RUN = 'Morning. I looked at the deploy checklist.';
const FOURTH_OF_RUN = 'I added the rollback command under it.';

async function open(page: Page): Promise<void> {
  await page.goto(CHANNEL);
  await expect(page.getByTestId('message').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message #polish' })).toBeVisible();
}

/** Puts the message with these words at the top of the list and lets the virtual list settle there. */
async function atTop(page: Page, text: string): Promise<void> {
  const row = page.getByTestId('message').filter({ hasText: text }).first();
  await expect(row).toBeVisible();
  for (let i = 0; i < 4; i += 1) {
    await row.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('run: twelve short messages by one person show one avatar and one name', async ({ browser }) => {
  await plate(browser, stack, 'run', { go: async (page) => { await open(page); await atTop(page, FIRST_OF_RUN); } });
});

test('compact run: the same run in Compact density', async ({ browser }) => {
  await plate(browser, stack, 'compact-run', { density: 'compact', go: async (page) => { await open(page); await atTop(page, FIRST_OF_RUN); } });
});

test('hover bar: the actions appear on the row under the pointer', async ({ browser }) => {
  await plate(browser, stack, 'hover-bar', {
    sizes: ['1440'],
    go: async (page) => {
      await open(page);
      await atTop(page, FIRST_OF_RUN);
      const row = page.getByTestId('message').filter({ hasText: FOURTH_OF_RUN }).first();
      await row.hover();
      await expect(row.locator('.acts')).toBeVisible();
    },
  });
});

test('composer focus: the box with the cursor in it, the toolbar steady', async ({ browser }) => {
  await plate(browser, stack, 'composer-focus', {
    go: async (page) => {
      await open(page);
      await page.getByRole('textbox', { name: 'Message #polish' }).click();
      await page.waitForTimeout(350); // a phone's bottom bar waits before it steps aside
    },
  });
});

test('header: the top of the channel, with the name, the tools and the first thread', async ({ browser }) => {
  await plate(browser, stack, 'header', {
    go: async (page) => {
      await open(page);
      await page.locator('.vlist').evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(200);
    },
  });
});

test('details menu: the menu under the channel name', async ({ browser }) => {
  await plate(browser, stack, 'details-menu', {
    go: async (page) => {
      await open(page);
      await page.getByTestId('channel-details-button').click();
      await expect(page.getByTestId('channel-details')).toBeVisible();
    },
  });
});

test('bot answer: an Answer with three numbered sources', async ({ browser }) => {
  await plate(browser, stack, 'bot-answer', {
    go: async (page) => {
      await open(page);
      await expect(page.getByTestId('answer')).toBeVisible();
      await page.getByTestId('answer').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(250);
      await expect(page.getByTestId('answer-citation')).toHaveCount(3);
    },
  });
});
