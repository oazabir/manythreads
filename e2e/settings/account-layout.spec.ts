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
    // (the team's own settings group has a Connections link too: the account group is the one read here)
    const account = nav.getByLabel('Account', { exact: true });
    for (const label of ['Profile', 'Notifications', 'Connections', 'Security', 'Bots and Personal', 'Routines', 'Action items']) await expect(account.getByRole('link', { name: label, exact: true })).toBeVisible();
    // the page you are on is the one marked current (a screen reader hears "current page")
    await expect(nav.getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Security', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Notifications', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/notifications$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect(page.getByTestId('notification-settings')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'What can interrupt you' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Notifications', exact: true })).toHaveAttribute('aria-current', 'page');
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
    // the digest mail links here: the section it names is scrolled into view after the redirect
    await expect(page.getByRole('heading', { level: 2, name: 'What can interrupt you' })).toBeInViewport();
    await page.goto('/account#' + 'acc-sessions');
    await expect(page).toHaveURL(new RegExp('/account/security' + '#' + 'acc-sessions$'));
    await page.goto('/account#' + 'acc-methods');
    await expect(page).toHaveURL(new RegExp('/account/security' + '#' + 'acc-methods$'));
    // the section the old link names is scrolled into view after the redirect
    await expect(page.getByRole('heading', { level: 2, name: 'Sign-in methods' })).toBeInViewport();
    await page.goto('/account#' + 'acc-connections');
    await expect(page).toHaveURL(new RegExp('/account/connections' + '#' + 'acc-connections$'));
  } finally {
    await context.close();
  }
});

test('a hand-typed anchor with a broken %-sequence does not break Notifications', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/notifications');
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/account/notifications#' + '%E0%A4%A');
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect(page.getByTestId('notification-settings')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a guest sees only the Account pages in the settings layout', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/account/profile');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    // the section select (the phone's navigation) holds the same: one group, the four pages, no workspace and no Teams, and no Bots and Personal, Routines or Action items (a guest has no Personal space)
    const groups = await page.locator('#settings-section optgroup').evaluateAll((os) => os.map((o) => (o as HTMLOptGroupElement).label));
    expect(groups).toEqual(['Account']);
    const options = await page.locator('#settings-section option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).label));
    expect(options).toEqual(['Profile', 'Notifications', 'Connections', 'Security']);
    expect(options).not.toContain('Routines');
    expect(options).not.toContain('Action items');
    if (!isMobile) {
      const nav = page.getByRole('navigation', { name: 'Settings' });
      expect(await nav.locator('.tgrp').allTextContents()).toEqual(['Account']);
    }
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
    // a method is its name and a check mark, never "ok"
    const method = page.getByTestId('signin-method').first();
    await expect(method).toHaveText('Email and password');
    await expect(method).toHaveAccessibleName('Email and password is set up');
    await expect(method.locator('svg')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('on a phone the account pages use the section select and fit the width', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/profile', { viewport: PHONE, mobile: true });
  try {
    const select = page.getByLabel('Settings section');
    await expect(select).toHaveValue('/account/profile');
    // every Account page fits 390 px (the Security page holds the sessions list, Notifications the widest forms)
    for (const to of ['/account/security', '/account/notifications', '/account/connections', '/account/bots', '/account/profile']) {
      await select.selectOption(to);
      await expect(page).toHaveURL(new RegExp(`${to}$`));
      await expect(select).toHaveValue(to);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noSidewaysScroll(page), to).toBe(true);
    }
  } finally {
    await context.close();
  }
});
