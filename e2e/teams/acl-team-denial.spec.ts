import { expect, test } from '@playwright/test';
import { authState } from '../support/env.ts';

/** PLAN P2 criterion 6 in the browser: team visibility follows membership, workspace settings exist only for admins. */

test.describe('Lena, a guest with no team', () => {
  test.use({ storageState: authState('lena') });

  test('her team list is empty and Engineering is 403', async ({ page }) => {
    await page.goto('/teams');
    await expect(page.getByText('You are not on a team yet.')).toBeVisible();
    await expect(page.locator('[data-landmark="teams-list"]')).toHaveCount(0);
    expect(((await (await page.request.get('/api/teams')).json()) as { teams: unknown[] }).teams).toEqual([]);

    await page.goto('/teams/engineering');
    await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
    expect((await page.request.get('/api/teams/engineering')).status()).toBe(403);
    expect((await page.request.get('/api/teams/engineering/roster')).status()).toBe(403);
  });

  test('workspace settings do not exist for her', async ({ page }) => {
    await page.goto('/settings/workspace/members');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect((await page.request.get('/api/workspace/members')).status()).toBe(404);
  });
});

test.describe('Priya, a member of two teams', () => {
  test.use({ storageState: authState('priya') });

  test('sees Engineering and Marketing, not Customer support', async ({ page }) => {
    await page.goto('/teams');
    const list = page.locator('[data-landmark="teams-list"]');
    await expect(list).toContainText('Engineering');
    await expect(list).toContainText('Marketing');
    await expect(list).not.toContainText('Customer support');
    await expect(list.locator('li')).toHaveCount(2);

    await page.goto('/settings/team/engineering/roster');
    await expect(page.getByRole('heading', { name: 'Engineering' })).toBeVisible();
    // a member sees the roster but none of the lead actions
    await expect(page.getByRole('button', { name: 'Invite' })).toHaveCount(0);
    await expect(page.getByLabel(/^Tag for /)).toHaveCount(0);

    await page.goto('/settings/team/customer-support/roster');
    await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
    expect((await page.request.get('/api/teams/customer-support')).status()).toBe(403);
  });
});

test.describe('Nadia, a plain member', () => {
  test.use({ storageState: authState('nadia') });

  test('gets the 404 page on workspace settings and does not see the Settings link', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-landmark="header"]').getByRole('link', { name: 'Settings' })).toHaveCount(0);
    for (const path of ['general', 'sign-in', 'members', 'roles']) {
      await page.goto(`/settings/workspace/${path}`);
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    }
    expect((await page.request.get('/api/workspace/members')).status()).toBe(404);
  });
});

test.describe('Omar, the workspace owner', () => {
  test.use({ storageState: authState('omar') });

  test('sees every team, the members table and the lead actions', async ({ page }) => {
    await page.goto('/teams');
    await expect(page.locator('[data-landmark="teams-list"]')).toContainText('Customer support');
    await page.goto('/settings/workspace/members');
    await expect(page.getByRole('cell', { name: 'lena@kahf.example' })).toBeVisible();
    await expect(page.getByRole('row', { name: /lena@kahf.example.*guest/ })).toBeVisible();
    await page.goto('/settings/team/customer-support/roster');
    await expect(page.getByRole('button', { name: 'Invite' })).toBeVisible();
  });
});
