import { expect, test } from '@playwright/test';
import type { FakeOidc } from '@manythreads/test-utils';
import { SEED_EMAILS, TARIQ_WORK_EMAIL } from '../fixtures/seed.ts';
import { createProvider, signedInContext, startStack, type Stack } from '../fixtures/stack.ts';
import { expectInApp, OIDC_CLIENT, sessionOf, startIssuer } from '../fixtures/oidc.ts';

/**
 * Google Workspace sign-in in the browser (PLAN phase 2, acceptance 3): the Google preset restricted to kahf.co, against
 * the fake issuer playing accounts.google.com. Seed v2 gives Tariq a verified kahf.co address, so his first Google
 * sign-in links an identity to the person that already exists and never creates a second one.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'OIDC flows run on the desktop project');

let stack: Stack;
let fake: FakeOidc;
let providerId = '';

const count = async (sql: string): Promise<number> => Number((await stack.sql<{ n: string }>(sql))[0]?.n);

test.beforeAll(async ({ playwright }) => {
  fake = await startIssuer(['google']);
  stack = await startStack({ MANYTHREADS_OIDC_MOCK_BASE: fake.baseUrl });
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  const provider = await createProvider(admin, { kind: 'google', ...OIDC_CLIENT, allowedDomains: ['kahf.co'] });
  expect(provider).toMatchObject({ enabled: true, disabledReason: null, hasSecret: true });
  providerId = provider.id;
  await admin.dispose();
});

test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
});

test('Tariq signs in with Google; the person is created once and the identity linked once', async ({ page }) => {
  const people = await count('SELECT count(*) AS n FROM app.people');
  await page.goto(`${stack.origin}/sign-in`);
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();

  fake.nextLogin('google', { email: TARIQ_WORK_EMAIL, name: 'Tariq', hd: 'kahf.co' });
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expectInApp(page);
  const session = await sessionOf(page);
  expect(session).toMatchObject({ authenticated: true, person: { name: 'Tariq', email: SEED_EMAILS.tariq }, role: 'member' });

  // second sign-in from a clean browser: same person, same single identity row
  await page.context().clearCookies();
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('google', { email: TARIQ_WORK_EMAIL, name: 'Tariq', hd: 'kahf.co' });
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expectInApp(page);
  expect((await sessionOf(page)).person?.email).toBe(SEED_EMAILS.tariq);

  expect(await count('SELECT count(*) AS n FROM app.people')).toBe(people);
  const identities = await stack.sql<{ person_id: string }>(`SELECT person_id FROM app.identities WHERE provider_id = '${providerId}'`);
  expect(identities).toHaveLength(1);
  expect(identities[0]?.person_id).toBe('00000000-0000-7000-8000-0000000c0005');
});

test('an address at another domain is refused with the domain sentence and nothing is created', async ({ page }) => {
  const people = await count('SELECT count(*) AS n FROM app.people');
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('google', { email: 'eve@other.com', name: 'Eve', hd: 'other.com' });
  await page.getByRole('link', { name: 'Continue with Google' }).click();

  await expect(page).toHaveURL(/\/sign-in\?error=domain_not_allowed/);
  await expect(page.getByRole('alert')).toContainText('That domain is not allowed.');
  expect((await sessionOf(page)).authenticated).toBe(false);
  expect(await count('SELECT count(*) AS n FROM app.people')).toBe(people);
});

test('the hosted-domain claim counts too: kahf.co address, other.com Workspace', async ({ page }) => {
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('google', { email: TARIQ_WORK_EMAIL, name: 'Tariq', hd: 'other.com' });
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('alert')).toContainText('That domain is not allowed.');
  expect((await sessionOf(page)).authenticated).toBe(false);
});

test('an unverified email is refused', async ({ page }) => {
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('google', { email: TARIQ_WORK_EMAIL, name: 'Tariq', hd: 'kahf.co', email_verified: false });
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('alert')).toContainText('Your email address is not verified with that provider.');
  expect((await sessionOf(page)).authenticated).toBe(false);
});
