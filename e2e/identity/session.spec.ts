import { expect, request, test } from '@playwright/test';
import { IDLE_SECONDS, PERSONA_PASSWORD, WEB, WEB_IDLE, authState, personaEmail } from '../support/env.ts';

/**
 * Criterion 4: an idle session answers 401 and the client returns to sign-in keeping the return path. The idle server
 * (WEB_IDLE) ends sessions after IDLE_SECONDS without a request, so no fake clock is needed in the browser.
 */
test('an idle session sends the browser to sign-in and back to where it was', async ({ page }) => {
  await page.goto(`${WEB_IDLE}/account`);
  // not signed in: sign-in keeps the path
  await expect(page).toHaveURL(`${WEB_IDLE}/sign-in?return=%2Faccount`);
  await page.getByLabel('Email').fill(personaEmail('nadia'));
  await page.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${WEB_IDLE}/account`);
  await expect(page.getByRole('heading', { name: /Account/ })).toBeVisible();

  // idle past the limit, then use the app: the 401 sends us to sign-in with the page we were on
  await page.waitForTimeout((IDLE_SECONDS + 2) * 1000);
  await page.getByRole('link', { name: 'Teams' }).click();
  await expect(page).toHaveURL(`${WEB_IDLE}/sign-in?return=%2Fteams`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // signing in again returns to /teams
  await page.getByLabel('Email').fill(personaEmail('nadia'));
  await page.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${WEB_IDLE}/teams`);

  // a reload after another idle period does the same through the session probe
  await page.waitForTimeout((IDLE_SECONDS + 2) * 1000);
  await page.reload();
  await expect(page).toHaveURL(`${WEB_IDLE}/sign-in?return=%2Fteams`);
});

test('sign out everywhere ends every session of the person, in every browser, and nobody else', async ({ browser }) => {
  const signIn = async () => {
    const context = await browser.newContext({ baseURL: WEB });
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(personaEmail('sameera'));
    await page.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('[data-landmark="header"]')).toContainText('Kahf Software');
    return { context, page };
  };
  const a = await signIn();
  const b = await signIn();

  await b.page.goto('/account');
  await expect(b.page.getByText('(this browser)')).toBeVisible();

  await a.page.goto('/account');
  await a.page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(a.page).toHaveURL(`${WEB}/sign-in`);

  // the other browser notices on its next request and keeps the return path
  await b.page.getByRole('link', { name: 'Teams' }).click();
  await expect(b.page).toHaveURL(`${WEB}/sign-in?return=%2Fteams`);

  // somebody else is untouched
  const omar = await request.newContext({ baseURL: WEB, storageState: authState('omar') });
  const res = await omar.get('/api/session');
  expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(true);
  await omar.dispose();
  await a.context.close();
  await b.context.close();
});
