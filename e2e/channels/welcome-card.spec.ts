import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, openOn, type StackApi } from '../support/stack-browser.ts';

/**
 * The welcome card of the Threads home (PLAN P3-14): a first-day checklist for members: Join #general, Follow a thread, Ask Brain (inert,
 * "Available soon"). Joining ticks the first step, dismissing is remembered in the browser, and a guest never sees it.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');

let stack: Stack;
let priya: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  priya = await apiOn(playwright, stack, 'priya');
  await channelsOf(priya);
});
test.afterAll(async () => {
  await priya?.ctx.dispose();
  await stack?.stop();
});

test('Priya sees the checklist, joins #general from it, and dismissing it sticks', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads');
  try {
    const card = page.getByTestId('welcome-card');
    await expect(card).toContainText('Welcome, Priya');
    const steps = card.getByTestId('welcome-step');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Join #general');
    await expect(steps.nth(1)).toContainText('Follow a thread');
    await expect(steps.nth(2)).toContainText('Ask Brain');
    await expect(steps.nth(2)).toContainText('Available soon');
    await expect(steps.nth(2)).toHaveAttribute('aria-disabled', 'true');
    await expect(steps.nth(2).getByRole('button')).toHaveCount(0);
    await expect(steps.nth(0)).toHaveAttribute('data-done', 'false');

    await steps.nth(0).getByRole('button', { name: 'Join' }).click();
    await expect(steps.nth(0)).toHaveAttribute('data-done', 'true');
    const general = (await channelsOf(priya))['general']!;
    expect((await priya.get<{ isMember: boolean }>(`/api/channels/${general}`)).isMember).toBe(true);

    await card.getByRole('button', { name: 'Dismiss welcome' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('threads-inbox')).toBeVisible();
    await expect(page.getByTestId('welcome-card')).toHaveCount(0);
  } finally {
    await context.close();
  }
  // another person in another browser still gets theirs
  const nadia = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await expect(nadia.page.getByTestId('welcome-card')).toContainText('Welcome, Nadia');
  } finally {
    await nadia.context.close();
  }
});

test('storage that is blocked does not break the page, and a guest never sees the card', async ({ browser, playwright }) => {
  const blocked = await openOn(browser, playwright, stack, 'priya', '/', {
    init: () => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    },
  });
  try {
    await expect(blocked.page.getByTestId('welcome-card')).toBeVisible();
    await blocked.page.getByRole('button', { name: 'Dismiss welcome' }).click();
    await expect(blocked.page.getByTestId('welcome-card')).toHaveCount(0);
  } finally {
    await blocked.context.close();
  }
  const lena = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await expect(lena.page.getByTestId('welcome-card')).toHaveCount(0);
  } finally {
    await lena.context.close();
  }
});
