import { expect, test, type Browser, type Page } from '@playwright/test';
import { PERSONA_PASSWORD, SEED_EMAILS } from '../fixtures/seed.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';

/**
 * Account: a person edits their own name and changes their password. The change needs the current password, ends the
 * person's other sessions and leaves this one signed in. Runs on its own stack, so no other spec sees the new password.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Account flows run on the desktop project');

const NEW_PASSWORD = 'a-new-long-passphrase-2026';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

async function signIn(browser: Browser, email: string, password: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL: stack.origin })).newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('[data-landmark="header"]')).toContainText('Kahf Software');
  return page;
}

test('a person edits their own name', async ({ browser }) => {
  const page = await signIn(browser, SEED_EMAILS.rafi, PERSONA_PASSWORD);
  await page.goto('/account');
  const save = page.getByRole('button', { name: 'Save name' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('Rafi Khan');
  await save.click();
  await expect(page.getByText('Name saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Rafi Khan');
  expect((await stack.sql<{ display_name: string }>(`SELECT display_name FROM app.people WHERE primary_email = $1`, [SEED_EMAILS.rafi]))[0]?.display_name).toBe('Rafi Khan');
  await page.context().close();
});

test('changing the password needs the current one, ends the other sessions and keeps this one', async ({ browser }) => {
  const here = await signIn(browser, SEED_EMAILS.nadia, PERSONA_PASSWORD);
  const elsewhere = await signIn(browser, SEED_EMAILS.nadia, PERSONA_PASSWORD);

  await here.goto('/account');
  await here.getByRole('button', { name: 'Change password' }).click();
  const form = here.getByRole('form', { name: 'Change password' });
  const update = form.getByRole('button', { name: 'Update password' });

  // too short (under 8): nothing to send
  await form.getByLabel('Current password').fill(PERSONA_PASSWORD);
  await form.getByLabel('New password').fill('short');
  await expect(update).toBeDisabled();

  // a wrong current password is a sentence on the form, and the session survives it
  await form.getByLabel('Current password').fill('not-the-password-at-all');
  await form.getByLabel('New password').fill(NEW_PASSWORD);
  await update.click();
  await expect(form.getByRole('alert')).toContainText('Your current password is incorrect.');
  await expect(here).toHaveURL(/\/account$/);

  await form.getByLabel('Current password').fill(PERSONA_PASSWORD);
  await update.click();
  await expect(here.getByText(/Password changed\. 1 other session was signed out\./)).toBeVisible();

  // this browser stays signed in; the other one is signed out on its next request
  await here.reload();
  await expect(here.getByRole('heading', { name: /Account/ })).toBeVisible();
  await elsewhere.goto('/account');
  await expect(elsewhere).toHaveURL(/\/sign-in/);

  // the old password no longer signs in, the new one does
  await elsewhere.getByLabel('Email').fill(SEED_EMAILS.nadia);
  await elsewhere.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
  await elsewhere.getByRole('button', { name: 'Sign in' }).click();
  await expect(elsewhere.getByRole('alert')).toHaveText(/Incorrect email or password\./);
  await elsewhere.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await elsewhere.getByRole('button', { name: 'Sign in' }).click();
  await expect(elsewhere.locator('[data-landmark="header"]')).toContainText('Kahf Software');

  await here.context().close();
  await elsewhere.context().close();
});

test('workspace admins edit the General settings; the name follows into the brand', async ({ browser }) => {
  const page = await signIn(browser, SEED_EMAILS.omar, PERSONA_PASSWORD);
  await page.goto('/settings/workspace/general');
  await page.getByLabel('Workspace name').fill('Kahf Group');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Workspace name saved.')).toBeVisible();
  await expect(page.locator('.tabs-brand')).toContainText('Kahf Group');
  await page.getByRole('switch', { name: 'Let people create their own account' }).click();
  await expect(page.getByText('Self sign-up is on.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Workspace name')).toHaveValue('Kahf Group');
  await expect(page.getByRole('switch', { name: 'Let people create their own account' })).toBeChecked();
  await page.context().close();
});
