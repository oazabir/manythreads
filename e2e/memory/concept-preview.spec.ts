import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * The team's Concepts tab (PLAN P21-15): one line per concept with a title and one trust icon; from 1024 px a preview pane sits on the right and
 * says "Select a concept" until one is picked; on a phone the concept rises as a sheet and Close puts the list back. A concept link
 * (`?concept=`) opens it at once. One stack for the file (the specs only read what the
 * first step wrote, apart from the one that confirms).
 */
test.skip(({ isMobile }) => isMobile, 'the tests set their own viewport; the mobile-web project adds nothing');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

const ONE = { path: 'memory/facts/release-day.md', title: 'Release day is Friday', desc: 'The team ships on Fridays after the checks pass.' };
const TWO = { path: 'memory/facts/on-call.md', title: 'On call rotates weekly', desc: 'Whoever is on call answers the pager until Monday.' };
let stack: Stack;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post('/api/teams/engineering/repo/commit', {
      changes: [
        { op: 'put', path: ONE.path, content: `---\ntype: fact\ntitle: ${ONE.title}\ndescription: ${ONE.desc}\n---\n\nShip on Fridays.\n` },
        { op: 'put', path: TWO.path, content: `---\ntype: fact\ntitle: ${TWO.title}\ndescription: ${TWO.desc}\ntags: [ops]\n---\n\nRotate on Monday.\n` },
      ],
      message: 'two concepts',
    });
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

const row = (page: Page, title: string) => page.getByTestId('concept-row').filter({ hasText: title });

test('each row is a title and one trust icon, with no chips; the pane says "Select a concept" until one is picked', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/memory');
  try {
    await expect(row(page, ONE.title)).toHaveCount(1, { timeout: 20_000 });
    await expect(row(page, TWO.title)).toHaveCount(1);
    const first = row(page, ONE.title);
    await expect(first.locator('.mc-trust')).toHaveCount(1);
    // a concept written by a person carries that person's review
    await expect(first.locator('.mc-trust')).toHaveAttribute('aria-label', 'Reviewed by a person');
    await expect(first.locator('.mm-chip')).toHaveCount(0);
    await expect(page.getByTestId('concept-preview-none')).toHaveText('Select a concept');
    await expect(page.getByTestId('concept-detail')).toHaveCount(0);

    await first.getByRole('button').click();
    await expect(page.getByTestId('concept-detail')).toBeVisible();
    await expect(page.getByTestId('concept-detail')).toContainText(ONE.title);
    await expect(page.getByTestId('concept-detail')).toContainText(ONE.desc);
    await expect(page.getByTestId('concept-preview-none')).toHaveCount(0);
    await expect(first).toHaveClass(/\bon\b/);

    // the pane is on the right of the list at 1440, and it follows the pick
    const list = (await page.getByTestId('concept-list').boundingBox())!;
    const pane = (await page.getByTestId('concept-preview').boundingBox())!;
    expect(pane.x).toBeGreaterThanOrEqual(list.x + list.width);
    await row(page, TWO.title).getByRole('button').click();
    await expect(page.getByTestId('concept-detail')).toContainText(TWO.title);
    await expect(page.getByTestId('concept-detail')).toContainText('ops');
  } finally {
    await context.close();
  }
});

test('a link to a concept opens it in the pane, and Confirm is off for a concept a person already reviewed', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/memory?concept=${encodeURIComponent(TWO.path)}`);
  try {
    await expect(page.getByTestId('concept-detail')).toContainText(TWO.title, { timeout: 20_000 });
    await expect(row(page, TWO.title)).toHaveClass(/\bon\b/);
    // a concept a person wrote carries a person's review, so its icon says so and there is nothing left to confirm
    await expect(row(page, TWO.title).locator('.mc-trust')).toHaveAttribute('aria-label', 'Reviewed by a person');
    await expect(page.getByTestId('concept-detail')).toContainText('Reviewed by a person');
    await expect(page.getByTestId('concept-confirm')).toBeDisabled();
    await expect(page.getByTestId('concept-deprecate')).toBeEnabled();
    // a link to a concept the list does not hold opens nothing
    await page.goto(`/t/engineering/memory?concept=${encodeURIComponent('memory/facts/gone.md')}`);
    await expect(row(page, ONE.title)).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('concept-preview-none')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('at 1000 px the pane is hidden until a concept is picked and then sits below the list', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/memory', { viewport: { width: 1000, height: 800 } });
  try {
    await expect(row(page, ONE.title)).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('concept-preview')).toBeHidden();
    await row(page, ONE.title).getByRole('button').click();
    await expect(page.getByTestId('concept-preview')).toBeVisible();
    const list = (await page.getByTestId('concept-list').boundingBox())!;
    const pane = (await page.getByTestId('concept-preview').boundingBox())!;
    expect(pane.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  } finally {
    await context.close();
  }
});

test('on a phone a pick rises as a sheet, Close puts the list back, and nothing scrolls sideways', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/memory', { viewport: PHONE, mobile: true });
  try {
    await expect(row(page, ONE.title)).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('concept-preview')).toHaveCount(0);
    await row(page, ONE.title).getByRole('button').click();
    const sheet = page.getByTestId('concept-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(ONE.title);
    await expect(sheet).toContainText(ONE.desc);
    const box = (await sheet.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(PHONE.height - 2);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a team with no concept shows the empty state with a button to the inbox', async ({ browser, playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post('/api/teams', { name: 'No Memory Team' });
  } finally {
    await omar.ctx.dispose();
  }
  const slug = (await stack.sql<{ slug: string }>(`SELECT slug FROM app.teams WHERE name = 'No Memory Team'`))[0]!.slug;
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/${slug}/memory`);
  try {
    await expect(page.getByTestId('concepts-empty')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('concepts-empty').locator('svg')).toHaveCount(1);
    await page.getByTestId('concepts-empty').getByRole('button', { name: 'Open the inbox' }).click();
    await expect(page).toHaveURL(/tab=inbox/);
  } finally {
    await context.close();
  }
});
