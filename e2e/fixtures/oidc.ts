import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { startFakeOidc, type FakeOidc } from '@manythreads/test-utils';

/** Client credentials the specs register at the fake issuer and give to the provider (the secret is random per run). */
export const OIDC_CLIENT = { clientId: 'e2e-client', clientSecret: `e2e-secret-${randomUUID()}` } as const;

/** The Microsoft tenant of the workspace in these specs, and another one. */
export const TENANT = '9f1c7a64-2b2a-4c0e-8f3c-5a6f1e0c2d11';
export const OTHER_TENANT = '11111111-2222-4333-8444-555555555555';

/**
 * The in-process fake issuer (packages/test-utils/src/fake-oidc.ts) with the given issuer ids registered for the e2e client.
 * It redirects the browser straight back with a code, so Playwright follows the real redirect chain; the claims of each
 * sign-in are set with `fake.nextLogin(issuerId, claims)` just before the button is clicked.
 * (tools/mock-oidc is the navikt container with a login form, for manual runs against the same layout.)
 */
export async function startIssuer(issuerIds: readonly string[]): Promise<FakeOidc> {
  const fake = await startFakeOidc();
  for (const id of issuerIds) fake.addClient(id, OIDC_CLIENT);
  return fake;
}

export interface SessionJson {
  authenticated: boolean;
  person?: { id: string; name: string; email: string };
  role?: string;
}

/** `GET /api/session` of the origin the page is on, with the page's cookies. */
export async function sessionOf(page: Page): Promise<SessionJson> {
  const res = await page.request.get(`${new URL(page.url()).origin}/api/session`);
  expect(res.status()).toBe(200);
  return (await res.json()) as SessionJson;
}

/** Waits until the browser is out of the sign-in flow and showing the workspace (the heading names it). */
export async function expectInApp(page: Page, workspace = 'Kahf Software'): Promise<void> {
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page.getByRole('heading', { level: 1, name: workspace })).toBeVisible();
}
