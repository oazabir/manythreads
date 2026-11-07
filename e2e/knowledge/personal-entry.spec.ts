import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, openOn, postAs } from '../support/stack-browser.ts';
import { inboxOf } from './personal-support.ts';

/*
 * The ways in to Personal (PLAN P20-04): the account menu's "Your memory" and "Your knowledge", the settings nav's "Bots and Personal", and the Send to
 * memory dialog's choice between the team's memory and your own. Own stack, desktop only.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone is read by the visual specs');
test.describe.configure({ mode: 'serial' });

const TEXT = 'Remember: the staging password rotates on the first of the month.';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the account menu has Your memory and Your knowledge for a member, and neither for a guest', async ({ browser, playwright }) => {
  const nadia = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  try {
    await nadia.page.getByRole('button', { name: 'Account menu' }).click();
    await expect(nadia.page.getByTestId('menu-my-memory')).toBeVisible();
    await expect(nadia.page.getByTestId('menu-my-knowledge')).toBeVisible();
    await nadia.page.getByTestId('menu-my-memory').click();
    await expect(nadia.page).toHaveURL(/\/memory$/);
    await expect(nadia.page.getByTestId('space-switch')).toHaveAttribute('data-space', 'personal');
    await nadia.page.getByRole('button', { name: 'Account menu' }).click();
    await nadia.page.getByTestId('menu-my-knowledge').click();
    await expect(nadia.page).toHaveURL(/\/knowledge$/);
    await expect(nadia.page.getByTestId('knowledge-screen')).toBeVisible();
  } finally {
    await nadia.context.close();
  }
  const lena = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await lena.page.getByRole('button', { name: 'Account menu' }).click();
    await expect(lena.page.getByRole('menu', { name: 'Account' })).toBeVisible();
    await expect(lena.page.getByTestId('menu-my-memory')).toHaveCount(0);
    await expect(lena.page.getByTestId('menu-my-knowledge')).toHaveCount(0);
  } finally {
    await lena.context.close();
  }
});

test('the settings nav lists Bots and Personal for a member and not for a guest', async ({ browser, playwright }) => {
  const nadia = await openOn(browser, playwright, stack, 'nadia', '/account/profile');
  try {
    const nav = nadia.page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.getByRole('link', { name: 'Bots and Personal', exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Bots and Personal', exact: true }).click();
    await expect(nadia.page).toHaveURL(/\/account\/bots$/);
    await expect(nav.getByRole('link', { name: 'Bots and Personal', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally {
    await nadia.context.close();
  }
  const lena = await openOn(browser, playwright, stack, 'lena', '/account/profile');
  try {
    await expect(lena.page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Bots and Personal' })).toHaveCount(0);
  } finally {
    await lena.context.close();
  }
});

test('Send to memory offers the team’s memory or your own; your own lands in your inbox and not in the team’s', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  let teamBefore = 0;
  try {
    teamBefore = (await api.get<{ items: unknown[] }>('/api/teams/engineering/inbox/items')).items.length;
    await postAs(api, (await channelsOf(api))['general']!, TEXT);
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  try {
    const message = page.getByTestId('message').filter({ hasText: 'staging password rotates' }).first();
    await message.hover();
    await message.getByRole('button', { name: 'More actions' }).click();
    await page.getByTestId('send-to-memory').click();
    const dialog = page.getByTestId('send-to-memory-dialog');
    await expect(dialog).toBeVisible();
    // two choices; the team's is the one chosen first, and says who will see it
    await expect(page.getByTestId('send-to-memory-targets')).toBeVisible();
    await expect(page.getByTestId('send-to-memory-target-team')).toBeChecked();
    await expect(page.getByTestId('send-to-memory-help')).toContainText('everyone in');
    await page.getByTestId('send-to-memory-target-personal').check();
    await expect(page.getByTestId('send-to-memory-help-personal')).toContainText('only you can see it');
    await expect(page.getByTestId('send-to-memory-help')).toHaveCount(0);
    await expect(page.getByTestId('send-to-memory-team-only')).toHaveCount(0);
    await page.getByTestId('send-to-memory-submit').click();
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
  const after = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    // it is in her inbox (a pipeline job reads it; the item exists at once) and the team's inbox did not grow
    await expect.poll(async () => (await inboxOf(after)).length, { timeout: 30_000 }).toBe(1);
    expect((await after.get<{ items: unknown[] }>('/api/teams/engineering/inbox/items')).items).toHaveLength(teamBefore);
    expect(await inboxOf(rafi)).toEqual([]);
  } finally {
    await after.ctx.dispose();
    await rafi.ctx.dispose();
  }
});
