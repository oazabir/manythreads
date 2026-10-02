import { expect, test, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { FakeOidc } from '@manythreads/test-utils';
import { SEED_EMAILS } from '../fixtures/seed.ts';
import { signedInContext, startStack, type Stack } from '../fixtures/stack.ts';
import { expectInApp, OIDC_CLIENT, sessionOf, startIssuer } from '../fixtures/oidc.ts';

/**
 * Any-OIDC provider (Okta, Keycloak, ...) set up by an admin in Workspace settings > Sign-in (PLAN phase 2, acceptance 3):
 * an issuer URL whose discovery passes enables the provider and people can use it; a bad issuer is saved switched off with
 * the reason shown, and offers no sign-in button. The admin drives the real settings screen.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'OIDC flows run on the desktop project');

let stack: Stack;
let fake: FakeOidc;

const count = async (sql: string): Promise<number> => Number((await stack.sql<{ n: string }>(sql))[0]?.n);

test.beforeAll(async () => {
  fake = await startIssuer(['any', 'down']);
  fake.failDiscovery('down');
  stack = await startStack();
});

test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
});

async function openProviderSettings(page: Page, playwright: PlaywrightWorkerArgs['playwright']) {
  const omar = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  await page.context().addCookies((await omar.storageState()).cookies);
  await omar.dispose();
  await page.goto(`${stack.origin}/settings/workspace/sign-in`);
  const box = page.getByRole('form', { name: /Any other OIDC provider/ });
  await expect(box).toBeVisible();
  return box;
}

async function addProvider(box: Locator, issuer: string): Promise<void> {
  await box.getByLabel('Issuer URL').fill(issuer);
  await box.getByLabel('Client ID').fill(OIDC_CLIENT.clientId);
  await box.getByLabel('Client secret').fill(OIDC_CLIENT.clientSecret);
  await box.getByRole('button', { name: 'Add' }).click();
}

test('an issuer URL whose discovery passes is enabled, and people sign in through it', async ({ page, playwright, browser }) => {
  const box = await openProviderSettings(page, playwright);
  await addProvider(box, fake.issuer('any'));
  await expect(page.getByRole('form', { name: /Any other OIDC provider/ }).getByRole('status')).toBeVisible();
  await expect(page.getByRole('form', { name: /Any other OIDC provider/ })).toContainText('enabled');
  await expect(page.getByRole('form', { name: /Any other OIDC provider/ }).getByRole('alert')).toHaveCount(0);
  // the secret never comes back
  await expect(page.getByRole('form', { name: /Any other OIDC provider/ }).getByLabel('Client secret')).toHaveValue('');
  expect(await page.content()).not.toContain(OIDC_CLIENT.clientSecret);

  const people = await count('SELECT count(*) AS n FROM app.people');
  const priya = await await browser.newPage();
  await priya.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('any', { email: SEED_EMAILS.priya, name: 'Priya' });
  await priya.getByRole('link', { name: 'Continue with Single sign-on' }).click();
  await expectInApp(priya);
  expect(await sessionOf(priya)).toMatchObject({ authenticated: true, person: { name: 'Priya', email: SEED_EMAILS.priya } });
  expect(await count('SELECT count(*) AS n FROM app.people')).toBe(people);
  expect(await count("SELECT count(*) AS n FROM app.identities i JOIN app.auth_providers p ON p.id = i.provider_id WHERE p.kind = 'oidc'")).toBe(1);
  await priya.close();
});

test('a bad issuer leaves the provider disabled with the reason, and no sign-in button', async ({ page, playwright, browser }) => {
  const box = await openProviderSettings(page, playwright);
  await box.getByRole('button', { name: 'Remove' }).click();
  const fresh = page.getByRole('form', { name: /Any other OIDC provider/ });
  await expect(fresh.getByRole('button', { name: 'Add' })).toBeVisible();
  await addProvider(fresh, fake.issuer('down'));

  const after = page.getByRole('form', { name: /Any other OIDC provider/ });
  await expect(after.getByRole('alert').first()).toContainText(/discovery/i);
  await expect(after).toContainText('error');

  const rows = await stack.sql<{ enabled: boolean; disabled_reason: string | null }>("SELECT enabled, disabled_reason FROM app.auth_providers WHERE kind = 'oidc'");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.enabled).toBe(false);
  expect(rows[0]?.disabled_reason).toMatch(/discovery/i);

  const anon = await await browser.newPage();
  await anon.goto(`${stack.origin}/sign-in`);
  await expect(anon.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(anon.getByRole('link', { name: /Continue with/ })).toHaveCount(0);
  await anon.close();
});
