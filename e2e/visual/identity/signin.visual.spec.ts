import { expect, test } from '@playwright/test';
import { createProvider, signedInContext, startStack, type Stack } from '../../fixtures/stack.ts';
import { OIDC_CLIENT, startIssuer } from '../../fixtures/oidc.ts';
import { SEED_EMAILS } from '../../fixtures/seed.ts';
import type { FakeOidc } from '@manythreads/test-utils';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Sign-in (PLAN phase 2 section 2 wireframe, class W) at 1440x900 and 390x844: the provider buttons (Google, Microsoft), the
 * "or" divider, the email and password form, and the refusal a provider redirect brings back ("That domain is not allowed.").
 * Own baselines under e2e/__baselines__/visual/identity/signin.visual.spec.ts/.
 */
const ORDER = ['header', 'title', 'providers', 'form', 'alert'];

let stack: Stack;
let fake: FakeOidc;
test.beforeAll(async ({ playwright }) => {
  fake = await startIssuer(['google', 'microsoft']);
  stack = await startStack({ MANYTHREADS_OIDC_MOCK_BASE: fake.baseUrl });
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  await createProvider(admin, { kind: 'google', ...OIDC_CLIENT, allowedDomains: ['kahf.co'] });
  await createProvider(admin, { kind: 'microsoft', ...OIDC_CLIENT, tenantId: '9f1c7a64-2b2a-4c0e-8f3c-5a6f1e0c2d11', allowedDomains: ['kahf.co'] });
  await admin.dispose();
});
test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
});

for (const [name, viewport, mobile] of [['signin-desktop', DESKTOP, false], ['signin-mobile', MOBILE, true]] as const) {
  test(`sign-in ${name} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, null, viewport, mobile);
    try {
      await page.goto('/sign-in?error=domain_not_allowed');
      await expect(page.getByRole('link', { name: 'Continue with Microsoft' })).toBeVisible();
      await page.getByLabel('Email').fill('nadia@kahf.example');
      await page.getByLabel('Email').blur();
      await expect(page.getByRole('alert')).toContainText('That domain is not allowed.');
      await expectWireframe(page, name, ORDER);
    } finally {
      await close();
    }
  });
}
