import { expect, test } from '@playwright/test';
import { WEB, PERSONA_PASSWORD, authState, personaEmail } from '../support/env.ts';

/**
 * P21-17: the app runs on createBrowserRouter (the bot page's leave-without-saving prompt needs a data router). Plain navigation must be as
 * before: a deep link opens the page, Back and Forward walk the history, and a signed-out deep link goes to sign-in and returns afterwards.
 * Read-only: it only opens pages, so it runs on the shared server.
 */
test.describe('router navigation', () => {
  test.use({ baseURL: WEB });

  test('a deep link opens, Back and Forward walk the history', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: WEB, storageState: authState('omar') });
    const page = await context.newPage();
    try {
      await page.goto('/account/profile');
      await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
      await page.getByRole('link', { name: 'Teams' }).first().click();
      await expect(page).toHaveURL(/\/teams$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/account\/profile$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(/\/teams$/);
      await page.reload();
      await expect(page).toHaveURL(/\/teams$/);
    } finally {
      await context.close();
    }
  });

  test('a signed-out deep link goes to sign-in and comes back after signing in', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: WEB });
    const page = await context.newPage();
    try {
      await page.goto('/account/security');
      await expect(page).toHaveURL(/\/sign-in\?return=%2Faccount%2Fsecurity$/);
      await page.getByLabel('Email').fill(personaEmail('nadia'));
      await page.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/account\/security$/);
      // the sign-in step replaced its history entry, so the page is still there after a reload and Back does not land on the sign-in form
      await page.reload();
      await expect(page).toHaveURL(/\/account\/security$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
