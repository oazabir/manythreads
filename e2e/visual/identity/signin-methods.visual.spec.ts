import { expect, test } from '@playwright/test';
import type { FakeOidc } from '@manythreads/test-utils';
import { createProvider, signedInContext, startStack, type Stack } from '../../fixtures/stack.ts';
import { OIDC_CLIENT, startIssuer } from '../../fixtures/oidc.ts';
import { SEED_EMAILS } from '../../fixtures/seed.ts';
import { comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * Workspace > Sign-in methods vs [proto §01 plate 1 · Step 1 · Sign-in methods] (section onboarding, plate 1). Class P-loose:
 * the plate is a richer state than the seed (a verified Google preset with domain kahf.co, a Microsoft preset waiting for its
 * tenant, "require email verification" and "allow self-signup" toggles, an Any-OIDC box), so what is held is landmark order and
 * presence and at most 12% differing pixels of the pane (see support/vt.ts for how the pane is cut). The live state is the
 * plate's: Google configured and verified against the fake issuer, Microsoft and Any-OIDC empty, password on.
 */
const PLATE: PlateSpec = {
  section: 'onboarding',
  n: 1,
  paneSelector: '.obr',
  padding: [32, 40, 32, 40],
  railWidth: 260,
  regions: {
    title: '.obr h3',
    lede: '.obr .lede',
    presets: '.obr .grid2 > .box:nth-child(1)',
    'provider-google': '.obr .grid2 > .box:nth-child(1) > .box:nth-child(2)',
    'provider-microsoft': '.obr .grid2 > .box:nth-child(1) > .box:nth-child(3)',
    'provider-password': '.obr .grid2 > .box:nth-child(2)',
    'provider-oidc': '.obr .grid2 > .box:nth-child(2) > .box',
  },
};

let stack: Stack;
let fake: FakeOidc;
test.beforeAll(async ({ playwright }) => {
  fake = await startIssuer(['google']);
  stack = await startStack({ MANYTHREADS_OIDC_MOCK_BASE: fake.baseUrl });
  const admin = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  const google = await createProvider(admin, { kind: 'google', ...OIDC_CLIENT, allowedDomains: ['kahf.co'] });
  expect(google.enabled).toBe(true);
  await admin.dispose();
});
test.afterAll(async () => {
  await fake?.close();
  await stack?.stop();
});

test('sign-in methods match the Step 1 · Sign-in methods plate (P-loose)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar');
  try {
    await page.goto('/settings/workspace/sign-in');
    await expect(page.getByText('Username and password').first()).toBeVisible();
    await comparePlate(page, browser, testInfo, {
      cls: 'P-loose',
      spec: PLATE,
      liveRegion: '[data-landmark="signin-methods"]',
      order: [
        ['title', 'lede', 'presets', 'provider-password'],
        ['provider-google', 'provider-microsoft'],
        ['provider-password', 'provider-oidc'],
      ],
    });
  } finally {
    await close();
  }
});
