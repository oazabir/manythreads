import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/search/basic (PLAN phase 3 criterion 6, UI side): the sidebar search box opens the results in the right panel, grouped Messages,
 * Threads and Files with counts and the matched words marked. Nadia finds Engineering, Sameera only her own team, Lena only what
 * she was granted, and nobody finds a private channel's text. A click lands on the message, flashed, or opens the thread.
 */
// a click on something that never becomes clickable fails in seconds instead of hanging until the test timeout
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone has its own spec (mobile-web)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let sameera: StackApi;
const ids: Record<string, string> = {};
const msg: Record<string, string> = {};

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  sameera = await apiOn(playwright, stack, 'sameera');
  Object.assign(ids, await channelsOf(omar));
  Object.assign(ids, await channelsOf(sameera, 'customer-support'));
  const priv = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'leads-only', private: true });
  ids['leads-only'] = priv.channel.id;

  msg['dev'] = (await postAs(nadia, ids['dev']!, 'Merged the rollback fix for the cache TTL, see the checklist')).id;
  msg['root'] = (await postAs(nadia, ids['dev']!, 'Rollback runbook needs an owner before the freeze')).id;
  await postAs(omar, ids['dev']!, 'I can own the runbook, assigning myself.', msg['root']!);
  msg['releases'] = (await postAs(omar, ids['releases']!, 'Release 2.4 shipped; the rollback plan was not needed')).id;
  await postAs(omar, ids['leads-only']!, 'Leads only: rollback budget is approved');
  await postAs(sameera, ids['support']!, 'A customer asked for a rollback of their invoice');
  // Lena is a guest with a grant on #releases only (the invitation flow has its own spec: guest-invite)
  const lena = await stack.sql<{ id: string }>("SELECT id FROM app.people WHERE primary_email = 'lena@kahf.example'");
  const ws = await stack.sql<{ id: string }>('SELECT id FROM app.workspaces LIMIT 1');
  await stack.sql(
    "INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read')",
    [ws[0]!.id, ids['releases'], lena[0]!.id],
  );
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), sameera?.ctx.dispose()]);
  await stack?.stop();
});

async function search(page: import('@playwright/test').Page, q: string): Promise<void> {
  const box = page.locator('[data-landmark="search"]').getByRole('searchbox');
  await box.fill(q);
  await box.press('Enter');
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', q);
}

test('Nadia: results grouped with counts, the words marked, a click lands on the message and flashes it', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await search(page, 'rollback');
    const panel = page.getByTestId('search-results');
    await expect(panel.getByRole('heading', { name: /^Messages \(\d+\)$/ })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Threads (1)' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Files (0)' })).toBeVisible();
    // her team's #dev and #releases messages and the thread; not Support's, not the private channel she is not in
    await expect(panel.getByTestId('search-messages').getByTestId('search-hit')).toHaveCount(3);
    await expect(panel).toContainText('Merged the rollback fix');
    await expect(panel).not.toContainText('invoice');
    await expect(panel).not.toContainText('budget is approved');
    await expect(panel.locator('mark').first()).toHaveText(/rollback/i);

    // a message of #dev: lands in the channel, scrolled to and flashed, the results stay beside it
    await panel.getByTestId('search-hit').filter({ hasText: 'Merged the rollback fix' }).click();
    await expect(page).toHaveURL(new RegExp(`/t/engineering/c/dev\\?message=${msg['dev']}`));
    await expect(page.locator(`[data-message-id="${msg['dev']}"]`)).toHaveClass(/hl/);
    await expect(page.getByTestId('search-results')).toBeVisible();

    // a thread hit opens the thread on top of the results; Back returns to them
    await page.getByTestId('search-threads').getByTestId('search-hit').click();
    await expect(page.getByTestId('thread-view')).toBeVisible();
    await expect(page.getByTestId('thread-view')).toContainText('Rollback runbook needs an owner');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByTestId('search-results')).toBeVisible();

    // searching again replaces the results instead of stacking them
    await search(page, 'checklist');
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Sameera finds only Support; a private channel is found by its members only', async ({ browser, playwright }) => {
  const sam = await openOn(browser, playwright, stack, 'sameera', '/t/customer-support/threads');
  try {
    await search(sam.page, 'rollback');
    await expect(sam.page.getByTestId('search-messages').getByTestId('search-hit')).toHaveCount(1);
    await expect(sam.page.getByTestId('search-results')).toContainText('invoice');
    await expect(sam.page.getByTestId('search-results')).not.toContainText('cache TTL');
    await search(sam.page, 'zebra crossing');
    await expect(sam.page.getByTestId('search-empty')).toHaveText('No results in what you can see.');
  } finally {
    await sam.context.close();
  }
  const omarPage = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await search(omarPage.page, 'budget approved');
    await expect(omarPage.page.getByTestId('search-results')).toContainText('rollback budget is approved');
  } finally {
    await omarPage.context.close();
  }
  const nadiaPage = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await search(nadiaPage.page, 'budget approved');
    await expect(nadiaPage.page.getByTestId('search-empty')).toBeVisible();
  } finally {
    await nadiaPage.context.close();
  }
});

test('Lena, a guest, finds only inside her grant', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await expect(page).toHaveURL(/\/c\/releases/);
    await search(page, 'rollback');
    const hits = page.getByTestId('search-messages').getByTestId('search-hit');
    await expect(hits).toHaveCount(1);
    await expect(hits).toContainText('Release 2.4 shipped');
    await expect(page.getByTestId('search-results')).not.toContainText('Merged the rollback fix');
    await hits.click();
    await expect(page).toHaveURL(new RegExp(`message=${msg['releases']}`));
    await expect(page.locator(`[data-message-id="${msg['releases']}"]`)).toHaveClass(/hl/);
  } finally {
    await context.close();
  }
});
