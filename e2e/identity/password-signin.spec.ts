import { expect, test } from '@playwright/test';
import { PERSONA_PASSWORD, personaEmail } from '../support/env.ts';
import { expectInApp } from '../fixtures/oidc.ts';

async function fillAndSubmit(page: import('@playwright/test').Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('Nadia signs in and the session cookie is HttpOnly', async ({ page, context }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await fillAndSubmit(page, personaEmail('nadia'), PERSONA_PASSWORD);

  await expect(page).toHaveURL(/\/$/);
  await expectInApp(page);

  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'manythreads_session' || c.name === '__Host-manythreads_session');
  expect(session, 'session cookie').toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).not.toBe('None');
  // the CSRF companion is readable by the page, the session cookie is not
  expect(cookies.find((c) => c.name === 'manythreads_csrf' || c.name === '__Host-manythreads_csrf')?.httpOnly).toBe(false);
  expect(await page.evaluate(() => document.cookie)).not.toContain('manythreads_session');
});

test('a wrong password is an alert that does not say which half was wrong', async ({ page }) => {
  await page.goto('/sign-in');
  await fillAndSubmit(page, personaEmail('nadia'), 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText(/Incorrect email or password\./);
  await expect(page).toHaveURL(/\/sign-in$/);

  // an unknown address gets the same sentence (nothing is created, nothing is revealed)
  await fillAndSubmit(page, 'nobody@kahf.example', 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText(/Incorrect email or password\./);
});

test('five wrong passwords lock the account for a while, even for the right password', async ({ page }) => {
  await page.goto('/sign-in');
  for (let i = 0; i < 5; i++) {
    await fillAndSubmit(page, personaEmail('tariq'), `wrong-password-${i}`);
    await expect(page.getByRole('alert')).toHaveText(/Incorrect email or password\./);
  }
  await fillAndSubmit(page, personaEmail('tariq'), PERSONA_PASSWORD);
  await expect(page.getByRole('alert')).toContainText('Too many failed attempts. Try again in 15 minutes.');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('an OIDC refusal comes back as a sentence on the sign-in screen', async ({ page }) => {
  await page.goto('/sign-in?error=domain_not_allowed');
  await expect(page.getByRole('alert')).toHaveText(/That domain is not allowed\./);
  await page.goto('/sign-in?error=no_such_code');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the sign-in card shows the product name large, the tagline and a full-width Sign in button', async ({ page }) => {
  await page.goto('/sign-in');
  const card = page.getByTestId('app-frame').locator('[data-landmark="auth-card"]');
  await expect(card.locator('.brand b')).toHaveText('manythreads');
  expect(await card.locator('.brand b').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(26);
  await expect(page.getByTestId('auth-tagline')).toHaveText('Where your team and its bots work together.');
  const form = await page.locator('[data-landmark="form"]').boundingBox();
  const button = await page.getByRole('button', { name: 'Sign in', exact: true }).boundingBox();
  expect(form && button && button.width >= form.width - 1).toBe(true);
  // there is no "Remember this device": a session's length is the workspace's decision, not the person's
  await expect(page.getByText('Remember this device')).toHaveCount(0);
});

test('Show password reveals what was typed, hides it again, and keeps the browser hints for password managers', async ({ page }) => {
  await page.goto('/sign-in');
  const password = page.getByLabel('Password', { exact: true });
  const toggle = page.getByRole('button', { name: 'Show password' });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await expect(password).toHaveAttribute('name', 'password');
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await toggle.evaluate((el) => el.tagName)).toBe('BUTTON');

  await password.fill('a-typed-secret');
  await toggle.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue('a-typed-secret');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  // the button did not submit the form
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await toggle.click();
  await expect(password).toHaveAttribute('type', 'password');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('Show password works from the keyboard and Sign in still works with the password showing', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(personaEmail('nadia'));
  const password = page.getByLabel('Password', { exact: true });
  await password.fill(PERSONA_PASSWORD);
  await page.keyboard.press('Tab');
  const toggle = page.getByRole('button', { name: 'Show password' });
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
