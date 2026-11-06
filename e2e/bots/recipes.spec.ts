import { expect, test, type Page } from '@playwright/test';
import { conversationStackEnv } from '../conversations/support.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * The recipe gallery (PLAN P21-18, POLISH 5.7): no "Ready to add" pill on a recipe nobody has touched, a pill only once something has happened, an Add button on hover and
 * focus (always there with touch), the popular recipes first, a picture for each shelf and a footer that stays on one line. Runs on a stack of its own because the last test
 * installs a recipe (three proposals are filed). Desktop and mobile-web.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const POPULAR = ['daily-standup', 'weekly-digest', 'request-intake', 'bug-triage', 'release-notes', 'meeting-prep', 'follow-up-chaser', 'incident-watch'];
let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack(conversationStackEnv());
});
test.afterAll(async () => {
  await stack?.stop();
});

async function gallery(browser: import('@playwright/test').Browser, playwright: import('@playwright/test').PlaywrightWorkerArgs['playwright'], isMobile: boolean): Promise<Page> {
  const { page } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/recipes', isMobile ? { viewport: PHONE, mobile: true } : {});
  await expect(page.getByTestId('recipe-card').first()).toBeVisible({ timeout: 30_000 });
  return page;
}

const opacityOf = (page: Page, recipe: string): Promise<string> =>
  page.locator(`li:has([data-recipe="${recipe}"]) [data-testid="recipe-add"]`).evaluate((el) => getComputedStyle(el).opacity);

test('a recipe nobody has touched has no pill, and the popular ones come first', async ({ browser, playwright, isMobile }) => {
  const page = await gallery(browser, playwright, isMobile);
  await expect(page.getByText('Ready to add')).toHaveCount(0);
  await expect(page.getByTestId('recipe-state')).toHaveCount(0);
  const ids = await page.getByTestId('recipe-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-recipe')));
  expect(ids.slice(0, POPULAR.length)).toEqual(POPULAR);
  // the rest by name
  const rest = await page.getByTestId('recipe-card').evaluateAll((els, n) => els.slice(n).map((e) => e.querySelector('.rg-name')?.textContent ?? ''), POPULAR.length);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
});

test('every card has a picture for its shelf, and the footer stays on one line', async ({ browser, playwright, isMobile }) => {
  const page = await gallery(browser, playwright, isMobile);
  const cards = page.getByTestId('recipe-card');
  const n = await cards.count();
  expect(n).toBeGreaterThan(8);
  await expect(page.locator('[data-testid="recipe-card"] .rg-ico svg')).toHaveCount(n);
  const meta = page.locator('[data-testid="recipe-card"] .rg-meta');
  const looks = await meta.evaluateAll((els) => els.map((el) => {
    const css = getComputedStyle(el);
    return { nowrap: css.whiteSpace === 'nowrap', ellipsis: css.textOverflow === 'ellipsis', oneLine: el.getBoundingClientRect().height < (parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.2) * 1.5 };
  }));
  expect(looks.every((l) => l.nowrap && l.ellipsis && l.oneLine)).toBe(true);
  expect(await noSidewaysScroll(page)).toBe(true);
});

test('desktop: Add appears on hover and on keyboard focus, and opens the details', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'hover layout');
  const page = await gallery(browser, playwright, false);
  const first = POPULAR[0]!;
  await expect(page.locator(`li:has([data-recipe="${first}"]) [data-testid="recipe-add"]`)).toHaveAttribute('aria-label', 'Add Daily stand-up');
  expect(await opacityOf(page, first)).toBe('0');
  await page.locator(`[data-recipe="${first}"]`).hover();
  await expect.poll(() => opacityOf(page, first)).toBe('1');
  // away again, then by keyboard: the card, then its Add button
  await page.mouse.move(0, 0);
  await expect.poll(() => opacityOf(page, first)).toBe('0');
  await page.locator(`[data-recipe="${first}"]`).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator(`li:has([data-recipe="${first}"]) [data-testid="recipe-add"]`)).toBeFocused();
  await expect.poll(() => opacityOf(page, first)).toBe('1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('recipe-dialog')).toBeVisible();
  await expect(page.getByTestId('recipe-install')).toBeEnabled();
  await expect(page.getByTestId('recipe-state')).toHaveCount(0);
});

test('phone: Add is always visible, large enough to press, and nothing overflows', async ({ browser, playwright, isMobile }) => {
  test.skip(!isMobile, 'touch layout');
  const page = await gallery(browser, playwright, true);
  const adds = page.getByTestId('recipe-add');
  expect(await adds.count()).toBeGreaterThan(8);
  await expect.poll(() => opacityOf(page, POPULAR[0]!)).toBe('1');
  const box = await adds.first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(await noSidewaysScroll(page)).toBe(true);
  await adds.first().tap();
  await expect(page.getByTestId('recipe-dialog')).toBeVisible();
});

test('after an install the card shows a pill and no Add button', async ({ browser, playwright, isMobile }) => {
  const page = await gallery(browser, playwright, isMobile);
  await page.locator('[data-recipe="daily-standup"]').click();
  await expect(page.getByTestId('recipe-dialog')).toBeVisible();
  await page.getByTestId('recipe-install').click();
  await expect(page.getByTestId('recipe-filed')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('recipe-close').click();
  const card = page.locator('li:has([data-recipe="daily-standup"])');
  await expect(card.getByTestId('recipe-state')).toHaveText(/Waiting for approval/);
  await expect(card.getByTestId('recipe-add')).toHaveCount(0);
  // the others are untouched: still no pill, still an Add button
  await expect(page.getByTestId('recipe-state')).toHaveCount(1);
  await expect(page.getByText('Ready to add')).toHaveCount(0);
});
