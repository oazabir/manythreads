import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/search/trigram (PLAN phase 3 criterion 6): the typo "rolback" finds "rollback" for Nadia only: Sameera (another team) and a
 * private channel's text stay out, and the exact word and the typo find the same message.
 */
// a click on something that never becomes clickable fails in seconds instead of hanging until the test timeout
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');

let stack: Stack;
let nadia: StackApi;
let sameera: StackApi;
let omar: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  sameera = await apiOn(playwright, stack, 'sameera');
  const dev = (await channelsOf(nadia))['dev']!;
  const support = (await channelsOf(sameera, 'customer-support'))['support']!;
  const priv = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'leads-secret', private: true });
  await postAs(nadia, dev, 'The rollback of the cache TTL change is in the dev environment');
  await postAs(sameera, support, 'Customers ask when the rollback will be finished');
  await postAs(omar, priv.channel.id, 'Private: rollback decision is ours alone');
});
test.afterAll(async () => {
  await Promise.all([nadia?.ctx.dispose(), sameera?.ctx.dispose(), omar?.ctx.dispose()]);
  await stack?.stop();
});

const searchIn = async (page: import('@playwright/test').Page, q: string) => {
  const box = page.locator('[data-landmark="search"]').getByRole('searchbox');
  await box.fill(q);
  await box.press('Enter');
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', q);
  return page.getByTestId('search-messages').getByTestId('search-hit');
};

test('the typo "rolback" finds the #dev message for Nadia, marked, and the exact word finds the same one', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    const typo = await searchIn(page, 'rolback');
    await expect(typo).toHaveCount(1);
    await expect(typo).toContainText('The rollback of the cache TTL change');
    await expect(typo.locator('mark')).toHaveText('rollback');
    await expect(page.getByTestId('search-results')).not.toContainText('Private:');
    const exact = await searchIn(page, 'rollback');
    await expect(exact).toHaveCount(1);
    await expect(exact).toContainText('The rollback of the cache TTL change');
  } finally {
    await context.close();
  }
});

test('Sameera with the same typo finds only her own team, never the #dev message', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'sameera', '/t/customer-support/threads');
  try {
    const typo = await searchIn(page, 'rolback');
    await expect(typo).toHaveCount(1);
    await expect(typo).toContainText('Customers ask');
    await expect(page.getByTestId('search-results')).not.toContainText('cache TTL');
  } finally {
    await context.close();
  }
});
