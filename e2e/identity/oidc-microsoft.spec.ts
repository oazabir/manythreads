import { expect, test } from '@playwright/test';
import type { FakeOidc } from '@manythreads/test-utils';
import { SEED_EMAILS, TARIQ_WORK_EMAIL } from '../fixtures/seed.ts';
import { createProvider, signedInContext, startStack, type Stack } from '../fixtures/stack.ts';
import { expectInApp, OIDC_CLIENT, OTHER_TENANT, sessionOf, startIssuer, TENANT } from '../fixtures/oidc.ts';

/**
 * Microsoft 365 sign-in in the browser (PLAN phase 2, acceptance 3): the Microsoft preset for one tenant, against the fake
 * issuer playing login.microsoftonline.com. A token from another tenant is refused even for a known address.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'OIDC flows run on the desktop project');

let stack: Stack;
let fake: FakeOidc;

const count = async (sql: string): Promise<number> => Number((await stack.sql<{ n: string }>(sql))[0]?.n);

test.beforeAll(async ({ playwright }) => {
  fake = await startIssuer(['microsoft']);
  stack = await startStack({ MANYTHREADS_OIDC_MOCK_BASE: fake.baseUrl });
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  const provider = await createProvider(admin, {
    kind: 'microsoft',
    tenantId: TENANT,
    ...OIDC_CLIENT,
    allowedDomains: ['kahf.co'],
  });
  expect(provider).toMatchObject({ enabled: true, disabledReason: null, hasSecret: true });
  await admin.dispose();
});

test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
});

test('Tariq signs in with Microsoft: the existing person, linked once', async ({ page }) => {
  const people = await count('SELECT count(*) AS n FROM app.people');
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('microsoft', { email: TARIQ_WORK_EMAIL, name: 'Tariq', tid: TENANT });
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();
  await expectInApp(page);
  expect(await sessionOf(page)).toMatchObject({ authenticated: true, person: { name: 'Tariq', email: SEED_EMAILS.tariq } });

  await page.context().clearCookies();
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('microsoft', { email: TARIQ_WORK_EMAIL, name: 'Tariq', tid: TENANT });
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();
  await expectInApp(page);

  expect(await count('SELECT count(*) AS n FROM app.people')).toBe(people);
  expect(await count("SELECT count(*) AS n FROM app.identities i JOIN app.auth_providers p ON p.id = i.provider_id WHERE p.kind = 'microsoft'")).toBe(1);
});

test('a token from another tenant is refused, even for a known address', async ({ page }) => {
  const people = await count('SELECT count(*) AS n FROM app.people');
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('microsoft', { email: TARIQ_WORK_EMAIL, name: 'Tariq', tid: OTHER_TENANT });
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();

  await expect(page).toHaveURL(/\/sign-in\?error=tenant_not_allowed/);
  await expect(page.getByRole('alert')).toContainText('belongs to a different organization');
  expect((await sessionOf(page)).authenticated).toBe(false);
  expect(await count('SELECT count(*) AS n FROM app.people')).toBe(people);
});

test('an unknown person from the right tenant is refused while sign-up is closed', async ({ page }) => {
  const people = await count('SELECT count(*) AS n FROM app.people');
  await page.goto(`${stack.origin}/sign-in`);
  fake.nextLogin('microsoft', { email: 'eve@kahf.co', name: 'Eve', tid: TENANT });
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();
  await expect(page.getByRole('alert')).toContainText('You need an invitation');
  expect((await sessionOf(page)).authenticated).toBe(false);
  expect(await count('SELECT count(*) AS n FROM app.people')).toBe(people);
});
