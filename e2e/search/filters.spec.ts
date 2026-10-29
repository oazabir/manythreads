import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/search/filters (PLAN P14-11): filter words typed in the search box become chips and narrow the results; the Filters form writes the same
 * words; a search can be saved and run again; and a second person never learns that a private channel or its messages exist, not from a hit,
 * a note or a count. Runs on the desktop and on a 390 px phone.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;
const ids: Record<string, string> = {};

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  Object.assign(ids, await channelsOf(omar));
  const priv = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'leads-only', private: true });
  ids['leads-only'] = priv.channel.id;
  await postAs(nadia, ids['dev']!, 'Zebra deploy checklist from Nadia, see https://example.com/zebra');
  await postAs(rafi, ids['dev']!, 'Zebra deploy notes from Rafi');
  await postAs(nadia, ids['releases']!, 'Zebra release plan from Nadia');
  await postAs(omar, ids['leads-only']!, 'Zebra layoff budget is approved');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

/** Types into the sidebar box (on a phone, behind the Find button) and waits for the results of exactly that text. */
async function search(page: Page, q: string, phone: boolean): Promise<void> {
  // on a phone the results are a full sheet over the page: start from the plain page, then open the drawer on the box
  if (phone) {
    if (await page.getByTestId('search-results').count()) await page.goto('/t/engineering/threads');
    await page.getByRole('button', { name: 'Find' }).click();
  }
  const box = phone ? page.locator('#shell-rail').getByRole('searchbox') : page.locator('[data-landmark="search"]').getByRole('searchbox');
  await box.fill(q);
  await box.press('Enter');
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', q);
}

/** Opens a disclosure button of the filter bar and leaves it open if it already is. */
async function disclose(page: Page, name: string): Promise<void> {
  const b = page.getByRole('button', { name, exact: true });
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
}

test('filter words become chips, narrow the results, and come off with one click', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const hits = page.getByTestId('search-messages').getByTestId('search-hit');
    await search(page, 'zebra', !!isMobile);
    await expect(hits).toHaveCount(3);

    await search(page, 'from:nadia zebra', !!isMobile);
    await expect(hits).toHaveCount(2);
    await expect(page.getByTestId('search-results')).not.toContainText('from Rafi');
    await expect(page.getByTestId('search-chip')).toHaveText(['From nadia×']);

    await search(page, 'from:nadia in:dev has:link zebra', !!isMobile);
    await expect(hits).toHaveCount(1);
    await expect(page.getByTestId('search-chip')).toHaveCount(3);
    expect(await noSidewaysScroll(page)).toBe(true);

    // remove one chip by its button: the box text and the results follow
    await page.getByRole('button', { name: 'Remove filter: Has a link' }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'from:nadia in:dev zebra');
    await expect(hits).toHaveCount(1);
    await expect(page.getByTestId('search-chip')).toHaveCount(2);

    // a name nobody has: a plain note, and nothing found
    await search(page, 'from:zzqx zebra', !!isMobile);
    await expect(page.getByTestId('search-unmatched')).toContainText('No person called “zzqx” that you can see.');
    await expect(page.getByTestId('search-empty')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the Filters form writes the same words; saved searches are kept and run again', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await search(page, 'zebra', !!isMobile);
    await disclose(page, 'Filters');
    const form = page.getByRole('form', { name: 'Search filters' });
    await form.getByLabel('From').fill('rafi');
    await form.getByLabel('In channel').fill('dev');
    expect(await noSidewaysScroll(page)).toBe(true);
    await form.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'from:rafi in:dev zebra');
    await expect(page.getByTestId('search-messages').getByTestId('search-hit')).toHaveCount(1);

    // save it, change the search, run the saved one again
    await disclose(page, 'Saved searches');
    await page.getByLabel('Name for this search').fill('Rafi in dev');
    await page.getByRole('button', { name: 'Save this search' }).click();
    const list = page.getByTestId('saved-list');
    await expect(list).toContainText('Rafi in dev');
    await search(page, 'zebra', !!isMobile);
    await disclose(page, 'Saved searches');
    await page.getByTestId('saved-list').getByRole('button', { name: /^Rafi in dev/ }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'from:rafi in:dev zebra');
    await expect(page.getByTestId('search-messages').getByTestId('search-hit')).toHaveCount(1);
    expect(await noSidewaysScroll(page)).toBe(true);

    // a duplicate name is refused in words; delete removes it
    await disclose(page, 'Saved searches');
    await page.getByLabel('Name for this search').fill('rafi IN dev');
    await page.getByRole('button', { name: 'Save this search' }).click();
    await expect(page.getByRole('alert')).toContainText('already have a saved search with that name');
    await page.getByRole('button', { name: 'Delete saved search Rafi in dev' }).click();
    await expect(page.getByTestId('saved-empty')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('Sameera (another team) and Priya never find the private channel, its name, or a count of it', async ({ browser, playwright, isMobile }) => {
  for (const who of ['sameera', 'priya'] as const) {
    const { page, context } = await openOn(browser, playwright, stack, who, who === 'sameera' ? '/t/customer-support/threads' : '/t/engineering/threads', isMobile ? { viewport: PHONE, mobile: true } : {});
    try {
      await search(page, 'in:leads-only zebra', !!isMobile);
      const results = page.getByTestId('search-results');
      await expect(page.getByTestId('search-unmatched')).toContainText('No channel called “leads-only” that you can see.');
      await expect(page.getByTestId('search-empty')).toBeVisible();
      await search(page, 'zebra layoff budget', !!isMobile);
      await expect(page.getByTestId('search-empty')).toBeVisible();
      await expect(results.getByTestId('search-hit')).toHaveCount(0);
      await expect(results.getByTestId('search-more')).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});
