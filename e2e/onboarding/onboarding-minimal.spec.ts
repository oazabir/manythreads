import { expect, test } from '@playwright/test';
import { authState } from '../support/env.ts';

/*
 * PLAN P5-22 in the browser: the minimal onboarding checklist (steps 0, 1, 2, 4, 5, 6) renders for
 * an admin with a link per step, and nobody else can open it. Read-only: nothing here creates,
 * invites or reconfigures, so it runs on the shared server.
 */

test.use({ storageState: authState('omar') });

test('Omar opens the setup checklist and every step links to the page that does it', async ({ page }) => {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();

  const steps = page.locator('[data-landmark="steps"]');
  await expect(steps.locator('[data-step]')).toHaveCount(6);
  for (const id of ['bootstrap', 'signin', 'models', 'https', 'teams', 'bots']) {
    await expect(steps.locator(`[data-step="${id}"]`)).toBeVisible();
  }
  await expect(steps.locator('[data-step="bootstrap"]')).toHaveAttribute('data-done', 'true');

  await expect(steps.locator('[data-step="signin"] a[href="/settings/workspace/sign-in"]').first()).toBeVisible();
  await expect(steps.locator('[data-step="models"] a[href="/settings/workspace/llm"]').first()).toBeVisible();
  await expect(steps.locator('[data-step="teams"] a[href="/teams"]').first()).toBeVisible();
  await expect(steps.locator('[data-step="https"] a[href="/settings/workspace/https"]').first()).toBeVisible();

  // the settings nav offers the same page under Setup (a sidebar link on desktop, a select option on mobile)
  if (test.info().project.name === 'mobile-web') {
    const values = await page.locator('#settings-section option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values).toContain('/onboarding');
  } else {
    await expect(page.locator('[data-landmark="nav"]').getByRole('link', { name: 'Setup' })).toBeVisible();
  }
});

test('Priya, not an admin, gets the not-found page', async ({ browser }) => {
  const context = await browser.newContext({ storageState: authState('priya') });
  const priya = await context.newPage();
  await priya.goto('/onboarding');
  await expect(priya.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await context.close();
});
