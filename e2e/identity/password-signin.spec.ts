import { expect, test } from '@playwright/test';
import { PERSONA_PASSWORD, personaEmail } from '../support/env.ts';

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
  await expect(page.locator('[data-landmark="header"]')).toContainText('Kahf Software');

  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'manythreads_session');
  expect(session, 'session cookie').toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).not.toBe('None');
  // the CSRF companion is readable by the page, the session cookie is not
  expect(cookies.find((c) => c.name === 'manythreads_csrf')?.httpOnly).toBe(false);
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
