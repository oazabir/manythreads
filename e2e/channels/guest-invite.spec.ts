import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/channels/guest-invite (PLAN phase 3 criterion 3): a guest invitation carries a channel grant, recorded when it is written and
 * applied when it is accepted. Before: the guest sees nothing. After: exactly that channel, read-only, and no other (hidden from
 * Priya's point of view too: a grant is for the invited person only). Works for a new person and for a guest who already exists (Lena).
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let ids: Record<string, string> = {};

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  ids = await channelsOf(omar);
  await postAs(omar, ids['releases']!, 'Release 2.4 is out; notes are in the wiki.');
  await postAs(omar, ids['dev']!, 'Internal: the cache TTL change needs a second review.');
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

const grants = (email: string) =>
  stack.sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.acl_entries a JOIN app.people p ON p.id = a.subject_id
      WHERE a.resource_type = 'channel' AND a.subject_type = 'person' AND p.primary_email = $1`,
    [email],
  );

async function acceptInBrowser(browser: import('@playwright/test').Browser, token: string, name?: string): Promise<void> {
  const context = await browser.newContext({ baseURL: stack.origin });
  const page = await context.newPage();
  try {
    await page.goto(`/invite/${token}`);
    await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
    if (name) await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.getByRole('heading', { name: /^You joined / })).toBeVisible();
  } finally {
    await context.close();
  }
}

test('a new guest: nothing before accepting, exactly #releases after, read-only', async ({ browser, playwright }) => {
  const email = 'pat@partner.example';
  const invite = await omar.post<{ token: string }>('/api/invitations', { email, role: 'guest', channels: [{ teamSlug: 'engineering', channel: '#releases' }] });
  expect((await grants(email))[0]?.n).toBe('0');

  await acceptInBrowser(browser, invite.token, 'Pat Partner');
  expect((await grants(email))[0]?.n).toBe('1');

  const pat = await openOn(browser, playwright, stack, email, '/');
  try {
    await expect(pat.page).toHaveURL(/\/c\/releases$/);
    await expect(pat.page.locator('[data-landmark="sidebar"] a.it')).toHaveCount(1);
    await expect(pat.page.locator('[data-landmark="sidebar"] a.it')).toContainText('releases');
    await expect(messagesIn(pat.page)).toHaveCount(1);
    await expect(messagesIn(pat.page).first().locator('.who b')).toHaveText('Omar');
    await expect(pat.page.getByTestId('read-only')).toHaveText('You can read this channel.');
    await pat.page.goto('/t/engineering/c/dev');
    await expect(pat.page.getByTestId('no-access')).toBeVisible();
  } finally {
    await pat.context.close();
  }
  const api = await apiOn(playwright, stack, email);
  expect(await api.status('GET', `/api/channels/${ids['dev']}/messages`)).toBe(403);
  expect(await api.status('POST', `/api/channels/${ids['releases']}/messages`, { channelId: ids['releases'], body: 'hi', threadRootId: null })).toBe(403);
  await api.ctx.dispose();
});

test('Lena, an existing guest: the same, and nobody else gains a channel', async ({ browser, playwright }) => {
  const lenaApi = await apiOn(playwright, stack, 'lena');
  expect(Object.keys(await channelsOf(lenaApi))).toEqual([]);
  const lena = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await expect(lena.page.locator('[data-landmark="sidebar"]')).toContainText('Nothing has been shared with you yet.');
  } finally {
    await lena.context.close();
  }
  const priyaBefore = Object.keys(await channelsOf(await apiOn(playwright, stack, 'priya'))).sort();

  const invite = await omar.post<{ token: string }>('/api/invitations', { email: 'lena@kahf.example', role: 'guest', channels: [{ teamSlug: 'engineering', channel: '#releases' }] });
  expect((await grants('lena@kahf.example'))[0]?.n).toBe('0');
  await acceptInBrowser(browser, invite.token);
  expect((await grants('lena@kahf.example'))[0]?.n).toBe('1');

  expect(Object.keys(await channelsOf(lenaApi))).toEqual(['releases']);
  const after = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await expect(after.page).toHaveURL(/\/c\/releases$/);
    await expect(after.page.locator('[data-landmark="sidebar"] a.it')).toHaveCount(1);
  } finally {
    await after.context.close();
  }
  // the grant is Lena's alone: Priya's channels are what they were
  expect(Object.keys(await channelsOf(await apiOn(playwright, stack, 'priya'))).sort()).toEqual(priyaBefore);
  await lenaApi.ctx.dispose();
});

test('a guest invitation must name a channel, and a grant for a channel that does not exist is skipped', async ({ playwright }) => {
  expect(await omar.status('POST', '/api/invitations', { email: 'nobody@partner.example', role: 'guest' })).toBe(400);
  const invite = await omar.post<{ token: string }>('/api/invitations', { email: 'kim@partner.example', role: 'guest', channels: [{ teamSlug: 'engineering', channel: '#gone-soon' }] });
  const res = await (await playwright.request.newContext({ baseURL: stack.origin })).post(`/api/invitations/${invite.token}/accept`, { data: { name: 'Kim' } });
  expect(res.status()).toBe(200);
  expect((await grants('kim@partner.example'))[0]?.n).toBe('0');
});
