import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, messagesIn, openOn, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/dm/get-or-create (PLAN phase 3 criterion 5): opening the same DM twice, even concurrently and from both sides, makes one row,
 * and the UI shows one conversation. The sidebar lists it with the unread count, the DM screen names the people in its header.
 */
// a click on something that never becomes clickable fails in seconds instead of hanging until the test timeout
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone has its own spec (mobile-web)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let nadiaId = '';
let rafiId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  nadiaId = (await nadia.get<{ person: { id: string } }>('/api/session')).person.id;
  rafiId = (await rafi.get<{ person: { id: string } }>('/api/session')).person.id;
});
test.afterAll(async () => {
  await Promise.all([nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

const dmRows = () => stack.sql<{ id: string }>("SELECT id FROM app.channels WHERE kind = 'dm'");

test('opening a DM ten times at once, from both sides, makes one row', async () => {
  const [fromNadia, fromRafi] = [await nadia.headers(), await rafi.headers()];
  const results = await Promise.all([
    ...Array.from({ length: 5 }, () => nadia.ctx.post('/api/dms', { data: { personIds: [rafiId] }, headers: fromNadia })),
    ...Array.from({ length: 5 }, () => rafi.ctx.post('/api/dms', { data: { personIds: [nadiaId] }, headers: fromRafi })),
  ]);
  const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ dm: { channel: { id: string } }; created: boolean }>));
  expect(results.map((r) => r.status()).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  expect(new Set(bodies.map((b) => b.dm.channel.id)).size).toBe(1);
  expect(bodies.filter((b) => b.created)).toHaveLength(1);
  expect(await dmRows()).toHaveLength(1);
});

test('the UI: pick a person, one conversation opens; picking again opens the same one; the other side sees it live', async ({ browser, playwright }) => {
  const rafiPage = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  const nadiaPage = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    const dmList = (page: typeof rafiPage.page) => page.locator('[data-slot="direct-messages"]');
    // the pair from the first test is already there: one row on each side
    await expect(dmList(nadiaPage.page).locator('a.it')).toHaveCount(1);
    await expect(dmList(nadiaPage.page).locator('a.it')).toContainText('Rafi');
    await expect(dmList(rafiPage.page).locator('a.it')).toContainText('Nadia');

    // "+ New" with Rafi picked is that same conversation: no second row
    await nadiaPage.page.getByRole('button', { name: 'New', exact: true }).click();
    const picker = nadiaPage.page.getByRole('dialog', { name: 'New message' });
    await picker.getByRole('checkbox', { name: /Rafi/ }).check();
    await picker.getByRole('button', { name: 'Message' }).click();
    await expect(nadiaPage.page).toHaveURL(/\/t\/engineering\/dm\/[0-9a-f-]{36}$/);
    await expect(nadiaPage.page.locator('h1')).toContainText('Nadia');
    await expect(nadiaPage.page.locator('h1')).toContainText('Rafi');
    await expect(dmList(nadiaPage.page).locator('a.it')).toHaveCount(1);
    await expect(nadiaPage.page.getByTestId('channel-start')).toContainText('This is the start of your conversation with Rafi.');
    expect(await dmRows()).toHaveLength(1);

    // she writes; Rafi sees the unread count in his sidebar without reloading, and the text on opening it
    await nadiaPage.page.getByRole('textbox', { name: 'Message Rafi' }).fill('Check the rota?');
    await nadiaPage.page.keyboard.press('Enter');
    await expect(messagesIn(nadiaPage.page)).toHaveCount(1);
    const row = dmList(rafiPage.page).locator('a.it');
    await expect(row.locator('.pill')).toHaveText('1', { timeout: 3_000 });
    await row.click();
    await expect(messagesIn(rafiPage.page)).toHaveCount(1);
    await expect(messagesIn(rafiPage.page).first()).toContainText('Check the rota?');
    await expect(messagesIn(rafiPage.page).first().locator('.who b')).toHaveText('Nadia');
    await expect(row.locator('.pill')).toHaveCount(0);

    // Rafi picks Nadia from his side: the same conversation again, still one row, one channel
    await rafiPage.page.getByRole('button', { name: 'New', exact: true }).click();
    await rafiPage.page.getByRole('dialog', { name: 'New message' }).getByRole('checkbox', { name: /Nadia/ }).check();
    await rafiPage.page.getByRole('dialog', { name: 'New message' }).getByRole('button', { name: 'Message' }).click();
    await expect(dmList(rafiPage.page).locator('a.it')).toHaveCount(1);
    expect(await dmRows()).toHaveLength(1);

    // a conversation of its own: the header search is limited to it
    await rafiPage.page.getByRole('searchbox', { name: 'Search this conversation' }).fill('rota');
    await rafiPage.page.getByRole('searchbox', { name: 'Search this conversation' }).press('Enter');
    await expect(rafiPage.page.getByTestId('search-results')).toContainText('in this conversation');
    await expect(rafiPage.page.getByTestId('search-results').getByTestId('search-hit')).toHaveCount(1);
  } finally {
    await rafiPage.context.close();
    await nadiaPage.context.close();
  }
});

test('a person who is not in the conversation cannot open it', async ({ browser, playwright }) => {
  const [dm] = await dmRows();
  const sameera = await apiOn(playwright, stack, 'sameera');
  expect(await sameera.status('GET', `/api/channels/${dm!.id}/messages`)).toBe(403);
  await sameera.ctx.dispose();
  const { page, context } = await openOn(browser, playwright, stack, 'sameera', `/t/customer-support/dm/${dm!.id}`);
  try {
    await expect(page.getByTestId('no-access')).toContainText('You cannot see this channel.');
  } finally {
    await context.close();
  }
});
