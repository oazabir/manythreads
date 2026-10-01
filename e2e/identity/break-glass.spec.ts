import { expect, test } from '@playwright/test';
import type { FakeOidc } from '@manythreads/test-utils';
import { PERSONA_PASSWORD, KAHF_WORKSPACE_ID, SEED_EMAILS } from '../fixtures/seed.ts';
import { createProvider, signedInContext, startStack, type Stack } from '../fixtures/stack.ts';
import { expectInApp, OIDC_CLIENT, sessionOf, startIssuer } from '../fixtures/oidc.ts';

/**
 * Break-glass (PLAN phase 2, acceptance 3): with single sign-on the only method for members, the password form is hidden
 * from the sign-in page but an admin can still reach it and sign in; a member's correct password is refused.
 * There is no admin API for the switch yet, so the owner role arranges it: the password provider row is disabled and
 * `workspaces.settings.passwordForMembers` is false.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Sign-in flows run on the desktop project');

let stack: Stack;
let fake: FakeOidc;

test.beforeAll(async ({ playwright }) => {
  fake = await startIssuer(['any']);
  stack = await startStack();
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  await createProvider(admin, { kind: 'oidc', issuer: fake.issuer('any'), ...OIDC_CLIENT, label: 'Acme SSO' });
  await admin.dispose();
  await stack.sql("INSERT INTO app.auth_providers (workspace_id, kind, enabled) VALUES ($1, 'password', false)", [KAHF_WORKSPACE_ID]);
  await stack.sql(`UPDATE app.workspaces SET settings = settings || '{"passwordForMembers": false}'::jsonb WHERE id = $1`, [KAHF_WORKSPACE_ID]);
});

test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
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
