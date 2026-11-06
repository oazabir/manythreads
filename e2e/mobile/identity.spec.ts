import { expect, test, type Page } from '@playwright/test';
import { authState, PERSONA_PASSWORD, personaEmail } from '../support/env.ts';

/**
 * Phase 2 on the phone (390x844, the `mobile-web` project): sign-in works with the on-screen layout, the settings nav
 * becomes a top select (PLAN P2 section 2), and the team denial page fits. Same server and personas as the desktop specs.
 */
test.skip(({ isMobile }) => !isMobile, 'Runs on the mobile-web project');

const noSideScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};

test('sign-in fits the phone: a wrong password is an alert, the right one lands in the app', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await noSideScroll(page);
  await page.getByLabel('Email').fill(personaEmail('nadia'));
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('[data-landmark="header"]')).toContainText('Kahf Software');
  await noSideScroll(page);
});

test('sign-in on the phone: the card has 16 px gutters, the Show password button is 44 px and the Sign in button fills the card', async ({ page }) => {
  await page.goto('/sign-in');
  const card = await page.locator('[data-landmark="auth-card"]').boundingBox();
  expect(card).not.toBeNull();
  expect(card!.x).toBeGreaterThanOrEqual(15);
  expect(card!.x).toBeLessThanOrEqual(17);
  const toggle = await page.getByRole('button', { name: 'Show password' }).boundingBox();
  expect(toggle!.width).toBeGreaterThanOrEqual(44);
  expect(toggle!.height).toBeGreaterThanOrEqual(44);
  const form = await page.locator('[data-landmark="form"]').boundingBox();
  const submit = await page.getByRole('button', { name: 'Sign in', exact: true }).boundingBox();
  expect(submit!.width).toBeGreaterThanOrEqual(form!.width - 1);
  await page.getByLabel('Password', { exact: true }).fill('typed-on-a-phone');
  await page.getByRole('button', { name: 'Show password' }).tap();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'true');
  // the button sits inside the password box, on its right edge
  const box = await page.getByLabel('Password', { exact: true }).boundingBox();
  const eye = await page.getByRole('button', { name: 'Show password' }).boundingBox();
  expect(box!.x + box!.width).toBeGreaterThanOrEqual(eye!.x + eye!.width - 1);
  await noSideScroll(page);
});

test.describe('Omar on settings', () => {
  test.use({ storageState: authState('omar') });

  test('the settings nav is a top select that moves between sections', async ({ page }) => {
    await page.goto('/settings/workspace/general');
    const select = page.getByLabel('Settings section');
    await expect(select).toBeVisible();
    await expect(page.locator('aside.tabs nav')).toBeHidden();
    await select.selectOption('/settings/workspace/members');
    await expect(page).toHaveURL(/\/settings\/workspace\/members$/);
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(page.getByText('lena@kahf.example')).toBeVisible();
    await noSideScroll(page);
    await select.selectOption('/settings/workspace/sign-in');
    await expect(page.getByRole('heading', { name: 'How will people sign in?' })).toBeVisible();
  });
});

test.describe('Lena, a guest', () => {
  test.use({ storageState: authState('lena') });

  test('the denial page for a team she is not on fits the phone', async ({ page }) => {
    await page.goto('/teams/engineering');
    await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
    await noSideScroll(page);
  });
});
