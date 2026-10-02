import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/channels/guest-lena (PLAN phase 3 criterion 8): Lena is a workspace guest with a read grant on #releases (seed v3). Her sidebar is
 * #releases and nothing else, the channel has no composer ("You can read this channel."), authors are named (not "Someone"),
 * /t/engineering/c/dev says "You cannot see this channel." and her API calls to other channels are 403.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout; guest-lena-390 is checked in mobile-web');

let stack: Stack;
let lena: StackApi;
let omar: StackApi;
let dev = '';
let releases = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  lena = await apiOn(playwright, stack, 'lena');
  const ids = await channelsOf(omar);
  dev = ids['dev']!;
  releases = ids['releases']!;
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), lena?.ctx.dispose()]);
  await stack?.stop();
});

test('Lena sees only #releases, read-only, with names on the messages', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    // her home is the one channel she was given
    await expect(page).toHaveURL(/\/t\/[^/]+\/c\/releases$/);
    const sidebar = page.locator('[data-landmark="sidebar"]');
    await expect(sidebar.locator('a.it')).toHaveCount(1);
    await expect(sidebar.locator('a.it')).toContainText('releases');
    for (const hidden of ['Files', 'Boards', 'Threads', 'Approvals', 'Direct messages', 'Bots', 'general', 'dev']) {
      await expect(sidebar.getByText(hidden, { exact: true })).toHaveCount(0);
    }
    await expect(page.locator('[data-landmark="team-switch"] button')).toHaveCount(0);

    // read-only: no composer, and the copy says so; the announcements are there and carry their authors' names
    await expect(messagesIn(page).first()).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveText('You can read this channel.');
    await expect(page.getByRole('textbox', { name: /Message/ })).toHaveCount(0);
    await expect(page.locator('.msg .who b').filter({ hasText: 'Someone' })).toHaveCount(0);
    await expect(messagesIn(page).first().locator('.who b')).toHaveText(/^(Omar|Nadia|Rafi)/);
    // no way to react or reply from here
    await messagesIn(page).first().hover();
    await expect(page.getByRole('button', { name: 'Reply in thread' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);

    // a channel she was not given: the URL says so, and no text leaks
    await page.goto('/t/engineering/c/dev');
    await expect(page.getByTestId('no-access')).toContainText('You cannot see this channel.');
    await expect(page.locator('[data-landmark="sidebar"] a.it')).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('cache TTL');
    await expect(page.locator('[data-landmark="search"] input')).toHaveAttribute('placeholder', 'Search');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('her API calls to other channels are refused, and what she may read is only #releases', async ({ playwright }) => {
  expect(await lena.status('GET', `/api/channels/${dev}/messages`)).toBe(403);
  expect(await lena.status('GET', `/api/channels/${dev}`)).toBe(403);
  expect(await lena.status('POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'hello', threadRootId: null })).toBe(403);
  // the channel she can read, she cannot post in
  expect(await lena.status('GET', `/api/channels/${releases}/messages`)).toBe(200);
  expect(await lena.status('POST', `/api/channels/${releases}/messages`, { channelId: releases, body: 'hello', threadRootId: null })).toBe(403);
  // no DMs, no members list
  expect(await lena.status('GET', `/api/channels/${releases}/members`)).toBe(403);
  const sameera = await apiOn(playwright, stack, 'sameera');
  expect(await lena.status('POST', '/api/dms', { personIds: [(await sameera.get<{ person: { id: string } }>('/api/session')).person.id] })).toBe(403);
  await sameera.ctx.dispose();
  const directory = await lena.get<{ groups: Array<{ channels: Array<{ name: string }> }> }>('/api/teams/engineering/channels');
  expect(directory.groups.flatMap((g) => g.channels.map((c) => c.name.replace(/^#/, '')))).toEqual(['releases']);
});
