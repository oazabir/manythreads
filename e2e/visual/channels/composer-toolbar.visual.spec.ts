import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The composer toolbar (PLAN P21-04, own baselines, class W): the bar drawn under a typed message with the send icon, the "@" list under its headings
 * (Everyone, People), and ":" + two letters with the emoji list; at 390x844 the closed bar ("Aa", Mention, Emoji) and the opened one.
 * composer-toolbar-1440.png, composer-mention-1440.png, composer-emoji-1440.png, composer-toolbar-390.png, composer-toolbar-390-open.png.
 * Times and counts are masked by the screen itself. No baseline is committed with this spec: the runner creates them after looking at every picture.
 */
let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewports');
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_CLOCK: 'fixed' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const MESSAGE = 'Notes from the incident review. Please check the timeline.';

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/t/engineering/c/dev');
  await expect(page.getByTestId('message').first()).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Message #dev' });
  await expect(box).toBeVisible();
  return box;
}

test('composer-toolbar-1440 matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'priya', DESKTOP, false);
  try {
    const box = await ready(page);
    await box.fill(MESSAGE);
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expectWireframe(page, 'composer-toolbar-1440', [['search', 'sidebar'], ['header', 'content']]);
  } finally {
    await close();
  }
});

test('composer-mention-1440 matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'priya', DESKTOP, false);
  try {
    const box = await ready(page);
    await box.fill('@');
    await expect(page.getByRole('listbox', { name: 'People' })).toBeVisible();
    await expect(page.getByTestId('picker-heading').first()).toHaveText('Everyone');
    await expectWireframe(page, 'composer-mention-1440', [['search', 'sidebar'], ['header', 'content']]);
  } finally {
    await close();
  }
});

test('composer-emoji-1440 matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'priya', DESKTOP, false);
  try {
    const box = await ready(page);
    await box.fill('Thanks all :smi');
    await expect(page.getByRole('listbox', { name: 'Emoji' })).toBeVisible();
    await expectWireframe(page, 'composer-emoji-1440', [['search', 'sidebar'], ['header', 'content']]);
  } finally {
    await close();
  }
});

for (const open of [false, true]) {
  test(`composer-toolbar-390${open ? '-open' : ''} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'priya', MOBILE, true);
    try {
      const box = await ready(page);
      await box.fill(MESSAGE);
      if (open) {
        await page.getByRole('button', { name: 'Formatting options' }).click();
        await expect(page.getByTestId('composer-format-toggle')).toHaveAttribute('aria-pressed', 'true');
      }
      await expectWireframe(page, open ? 'composer-toolbar-390-open' : 'composer-toolbar-390', [['header', 'content']]);
    } finally {
      await close();
    }
  });
}
