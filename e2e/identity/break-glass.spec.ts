import { expect, test, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { FakeOidc } from '@manythreads/test-utils';
import { PERSONA_PASSWORD, SEED_EMAILS } from '../fixtures/seed.ts';
import { createProvider, signedInContext, startStack, type Stack } from '../fixtures/stack.ts';
import { expectInApp, OIDC_CLIENT, sessionOf, startIssuer } from '../fixtures/oidc.ts';

/**
 * Break-glass (PLAN phase 2, acceptance 3): with single sign-on the only method for members, the password form is hidden
 * from the sign-in page but an admin can still reach it and sign in; a member's correct password is refused.
 * The switch is the workspace setting `passwordForMembers`: the admin flips it in Workspace settings > Sign-in (the real
 * UI and `PATCH /api/workspace`). Nothing is arranged through SQL.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Sign-in flows run on the desktop project');

let stack: Stack;
let fake: FakeOidc;

test.beforeAll(async () => {
  fake = await startIssuer(['any']);
  stack = await startStack();
});

test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
});

async function adminOnSignInSettings(page: Page, playwright: PlaywrightWorkerArgs['playwright']) {
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  await page.context().addCookies((await admin.storageState()).cookies);
  await admin.dispose();
  await page.goto(`${stack.origin}/settings/workspace/sign-in`);
  const box = page.locator('[data-landmark="provider-password"]');
  await expect(box).toBeVisible();
  return box;
}

test('with no single sign-on provider the admin cannot turn the member password form off', async ({ page, playwright }) => {
  const box = await adminOnSignInSettings(page, playwright);
  await box.getByRole('switch', { name: 'Members can sign in with a password' }).click();
  await expect(box.getByRole('alert')).toContainText('single sign-on');
  await expect(box.getByRole('switch', { name: 'Members can sign in with a password' })).toHaveAttribute('aria-checked', 'true');
  await expect(box).toContainText('on');
});

test('the admin adds single sign-on and turns the member password form off; it sticks after a reload', async ({ page, playwright }) => {
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  await createProvider(admin, { kind: 'oidc', issuer: fake.issuer('any'), ...OIDC_CLIENT, label: 'Acme SSO' });
  await admin.dispose();

  // before the switch: members see both the SSO button and the password form
  await page.goto(`${stack.origin}/sign-in`);
  await expect(page.getByRole('link', { name: 'Continue with Acme SSO' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();

  const box = await adminOnSignInSettings(page, playwright);
  await box.getByRole('switch', { name: 'Members can sign in with a password' }).click();
  await expect(box).toContainText('off for members');
  await expect(box.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-landmark="provider-password"]')).toContainText('off for members');
  await expect(page.getByRole('switch', { name: 'Members can sign in with a password' })).toHaveAttribute('aria-checked', 'false');
});

test('the sign-in page offers single sign-on and hides the password form behind an admin link', async ({ page }) => {
  await page.goto(`${stack.origin}/sign-in`);
  await expect(page.getByRole('link', { name: 'Continue with Acme SSO' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByText('Your workspace uses single sign-on.')).toBeVisible();
  await page.getByRole('button', { name: 'sign in with a password' }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('Nadia (member) is refused with the right password', async ({ page }) => {
  await page.goto(`${stack.origin}/sign-in`);
  await page.getByRole('button', { name: 'sign in with a password' }).click();
  await page.getByLabel('Email').fill(SEED_EMAILS.nadia);
  await page.getByLabel('Password').fill(PERSONA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('Password sign-in is turned off for members');
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await sessionOf(page)).authenticated).toBe(false);
});

test('Omar (admin) gets in with his password: break-glass', async ({ page }) => {
  await page.goto(`${stack.origin}/sign-in`);
  await page.getByRole('button', { name: 'sign in with a password' }).click();
  await page.getByLabel('Email').fill(SEED_EMAILS.omar);
  await page.getByLabel('Password').fill(PERSONA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expectInApp(page);
  expect(await sessionOf(page)).toMatchObject({ authenticated: true, person: { name: 'Omar' }, role: 'owner' });
});
