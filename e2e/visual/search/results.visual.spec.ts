import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, channelsOf, postAs, type StackApi } from '../../support/stack-browser.ts';
import { DESKTOP, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Search results in the right panel (PLAN phase 3 section 5, own baseline, class W; wireframe "Search results"): Messages, Threads and
 * Files with counts, the matched words marked, over the channel the person was in. 1440x900: results.png. Times are masked.
 */
test.skip(({ isMobile }) => isMobile, 'desktop baseline');

let stack: Stack;
const apis: StackApi[] = [];

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  const [omar, nadia] = [await apiOn(playwright, stack, 'omar'), await apiOn(playwright, stack, 'nadia')];
  apis.push(omar, nadia);
  const ids = await channelsOf(nadia);
  await postAs(nadia, ids['dev']!, 'Merged the rollback fix for the cache TTL, see the checklist');
  const root = await postAs(nadia, ids['dev']!, 'Rollback runbook needs an owner before the freeze');
  await postAs(omar, ids['dev']!, 'I can own the runbook, assigning myself.', root.id);
  await postAs(nadia, ids['releases']!, 'Release 2.4 shipped; the rollback plan was not needed');
});
test.afterAll(async () => {
  await Promise.all(apis.map((a) => a.ctx.dispose()));
  await stack?.stop();
});

test('search results match their baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/t/engineering/c/dev');
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
    const box = page.locator('[data-landmark="search"]').getByRole('searchbox');
    await box.fill('rolback');
    await box.press('Enter');
    await expect(page.getByTestId('search-messages').getByTestId('search-hit')).toHaveCount(3);
    await expectWireframe(page, 'results', [['search', 'sidebar'], ['header', 'content', 'right-panel']]);
  } finally {
    await close();
  }
});
