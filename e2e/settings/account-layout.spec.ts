import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Account in the settings layout (PLAN P21-19, POLISH 6.1). The account row opens Profile with the same left nav as the workspace settings; the old
 * /account address and its anchors land on the page that holds the section; Security keeps the password form and the sessions.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the account row opens Profile in the settings layout', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the account row is in the sidebar drawer on a phone; the layout is read in the phone test below');
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/');
  try {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Account', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/profile$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Settings' });
    for (const label of ['Profile', 'Notifications', 'Connections', 'Security']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Security', exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Notifications', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/notifications$/);
    await expect(page.getByTestId('notification-settings')).toBeVisible();
    await expect(page).toHaveTitle(/^Notifications · /);
  } finally {
    await context.close();
  }
});

test('/account and its old anchors land on the page that holds the section', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account');
  try {
    await expect(page).toHaveURL(/\/account\/profile$/);
    await page.goto('/account#status-and-dnd');
    await expect(page).toHaveURL(/\/account\/notifications#status-and-dnd$/);
    await expect(page.getByTestId('presence-settings')).toBeVisible();
    await page.goto('/account#' + 'acc-notifications');
    await expect(page).toHaveURL(new RegExp('/account/notifications' + '#' + 'acc-notifications$'));
  } finally {
    await context.close();
  }
});

test('Security keeps password and sessions', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/security');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a reset link' })).toBeVisible();
    await expect(page.getByText('(this browser)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out everywhere' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign-in methods' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('on a phone the account pages use the section select and fit the width', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/profile', { viewport: PHONE, mobile: true });
  try {
    const select = page.getByLabel('Settings section');
    await expect(select).toHaveValue('/account/profile');
    await select.selectOption('/account/security');
    await expect(page).toHaveURL(/\/account\/security$/);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
