import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn, PHONE } from '../support/stack-browser.ts';

/*
 * The Summaries page (P37-06, docs/plans/summaries.md): the first sidebar entry opens the daily digest at /t/<team>/summaries. It has the page title and today's date,
 * a Refresh button, and five cards (needs your attention, waiting on your reply, recent activity, up next, keep going), each with a count or a friendly empty line and a
 * link to the screen that owns it. At the foot, a sixth section (P37-09) lists the last ten threads the person opened, newest first, each row a link to the thread. A phone shows one column with no sideways scroll. A guest has no Summaries.
 */
test.use({ actionTimeout: 10_000 });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const CARDS = ['attention', 'waiting', 'activity', 'next', 'keep-going'];

test('the sidebar opens the page: title, date, refresh and the five cards', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    if (isMobile) {
      // the phone's drawer holds the same rows; this check goes straight to the page
      await expect(page).toHaveURL(/\/t\/[^/]+\//);
      await page.goto(`/t/${new URL(page.url()).pathname.split('/')[2] ?? ''}/summaries`);
    } else {
      await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: 'Summaries' }).click();
    }
    await expect(page).toHaveURL(/\/t\/[^/]+\/summaries$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Summaries' })).toBeVisible();
    await expect(page.getByTestId('summaries-refresh')).toBeVisible();
    for (const id of CARDS) await expect(page.locator(`[data-testid="summaries-card"][data-card="${id}"]`)).toBeVisible();
    // each card settles into rows or a friendly empty line, never a skeleton or an error
    for (const id of CARDS) {
      const card = page.locator(`[data-testid="summaries-card"][data-card="${id}"]`);
      await expect(card.getByTestId('summaries-error')).toHaveCount(0);
      await expect(card.locator('.sk-row, [data-skeleton]')).toHaveCount(0);
    }
    await expect(page.getByTestId('summaries-hello')).toContainText(/Good (morning|afternoon|evening)/);
  } finally {
    await context.close();
  }
});

test('refresh reads everything again and the page stays', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/');
  try {
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: 'Summaries' }).click();
    await expect(page.getByTestId('summaries')).toBeVisible();
    const waiting = page.waitForResponse((r) => r.url().includes('/api/appointments'));
    await page.getByTestId('summaries-refresh').click();
    await waiting;
    await expect(page.getByTestId('summaries')).toBeVisible();
    await expect(page.locator('[data-testid="summaries-card"]')).toHaveCount(5);
  } finally {
    await context.close();
  }
});

test('a row is one whole link, and a card with more than five rows says how many more', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/');
  try {
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: 'Summaries' }).click();
    await expect(page.getByTestId('summaries')).toBeVisible();
    for (const id of CARDS.filter((c) => c !== 'keep-going')) {
      const card = page.locator(`[data-testid="summaries-card"][data-card="${id}"]`);
      await expect(card.getByTestId('summaries-row').or(card.locator('[data-testid^="summaries-empty-"]')).first()).toBeVisible();
      expect(await card.getByTestId('summaries-row').count()).toBeLessThanOrEqual(5);
      await expect(card.getByTestId('summaries-see-all').first()).toBeVisible();
    }
    const rows = page.getByTestId('summaries-row');
    for (let i = 0; i < Math.min(await rows.count(), 3); i += 1) {
      await expect(rows.nth(i).locator('a.sm-row-link')).toHaveAttribute('href', /.+/);
    }
  } finally {
    await context.close();
  }
});

test('on a phone the cards stack in one column with no sideways scroll', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/', { viewport: PHONE, mobile: true });
  try {
    await page.goto('/');
    await expect(page).toHaveURL(/\/t\/[^/]+\//);
    const team = new URL(page.url()).pathname.split('/')[2] ?? '';
    await page.goto(`/t/${team}/summaries`);
    await expect(page.getByTestId('summaries')).toBeVisible();
    await expect(page.locator('[data-testid="summaries-card"]').first()).toBeVisible();
    const box = async (id: string) => page.locator(`[data-testid="summaries-card"][data-card="${id}"]`).boundingBox();
    const first = await box('attention');
    const second = await box('waiting');
    expect(first && second && Math.abs(first.x - second.x) < 2 && second.y > first.y).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test('the foot lists the threads the person opened: empty at first, then a row that opens the thread where it lives', async ({ browser, playwright, isMobile }) => {
  // straight to the page: the Threads home opens its first thread on a wide screen, which would already be noted as opened
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/summaries', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const team = 'engineering';
    const foot = page.getByTestId('summaries-recent-threads');
    // it is a section of its own, below the five cards, and not one of them
    await expect(foot).toBeVisible();
    await expect(foot.getByRole('heading', { name: 'Threads you were in lately' })).toBeVisible();
    await expect(foot.getByText('Threads you open will show up here.')).toBeVisible();
    await expect(page.locator('[data-testid="summaries-card"]')).toHaveCount(5);
    const keep = await page.locator('[data-testid="summaries-card"][data-card="keep-going"]').boundingBox();
    const footBox = await foot.boundingBox();
    expect(keep && footBox && footBox.y > keep.y).toBe(true);

    // opening a thread (here the first one on the Threads page) puts it at the top of the list
    await page.goto(`/t/${team}/threads`);
    const first = page.getByTestId('thread-row').first();
    await expect(first).toBeVisible();
    const rootId = (await first.getAttribute('data-root-id'))!;
    await first.click();
    await expect(page.getByTestId('thread-view').first()).toBeVisible();
    // the thread is noted in this browser once it has loaded (per person and team); leave only after that
    await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('manythreads.recentThreads.')).map(([, v]) => v).join('')), { timeout: 15_000 }).toContain(rootId);
    await page.goto(`/t/${team}/summaries`);
    const row = foot.getByTestId('summaries-row').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Opened (just now|\d+ minutes? ago)/);
    // the row opens the thread in its own place (channel, direct message, chat with a bot or meeting chat), not on the Threads page
    await expect(row.locator('a.sm-row-link')).toHaveAttribute('href', new RegExp(rootId));
    expect(await foot.getByTestId('summaries-row').count()).toBeLessThanOrEqual(10);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await row.locator('a.sm-row-link').click();
    await expect(page).toHaveURL(new RegExp(rootId));
    await expect(page.getByTestId('thread-view').or(page.getByTestId('chat-column')).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a guest has no Summaries entry', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the desktop sidebar');
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    const sidebar = page.locator('[data-landmark="sidebar"]');
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Summaries' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
