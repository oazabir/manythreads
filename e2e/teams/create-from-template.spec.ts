import { expect, test } from '@playwright/test';
import { authState, personaEmail } from '../support/env.ts';

/**
 * PLAN P2 criteria 5 in the browser: Omar creates a team from the Engineering template (slug "platform"), invites
 * Nadia and Rafi, both accept, and he tags Rafi on the roster.
 */
test.use({ storageState: authState('omar') });

test('Omar creates Engineering from the template, invites Nadia and Rafi, and tags Rafi', async ({ page, browser }) => {
  await page.goto('/teams');
  await page.getByRole('checkbox', { name: 'Create a Engineering team' }).click();
  await page.getByLabel('Engineering team name').fill('Platform');
  await expect(page.getByLabel('Engineering team slug')).toHaveValue('platform');
  await page.getByLabel('Engineering invite emails').fill(`${personaEmail('nadia')}, ${personaEmail('rafi')}`);
  await page.getByRole('button', { name: 'Create 1 team' }).click();

  const created = page.locator('[data-landmark="created"]');
  await expect(created.getByRole('heading')).toContainText('Created: Platform');
  const links = await created.locator('a.mono').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(links).toHaveLength(2);
  expect(links[0]).toContain('/invite/');
  // the new team is listed with its template
  await expect(page.locator('[data-landmark="teams-list"]')).toContainText('template engineering');

  // each invited person opens the link in their own browser and accepts
  for (const link of links) {
    const context = await browser.newContext();
    const invitee = await context.newPage();
    await invitee.goto(link);
    await expect(invitee.getByRole('heading', { name: 'Join Kahf Software' })).toBeVisible();
    await expect(invitee.getByText('Omar invited you to the Platform team.')).toBeVisible();
    await invitee.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(invitee.getByRole('heading', { name: 'You joined Kahf Software' })).toBeVisible();
    // the link works once
    await invitee.reload();
    await expect(invitee.getByRole('heading', { name: 'This invitation has expired' })).toBeVisible();
    await context.close();
  }

  // the roster lists Omar (lead), Nadia and Rafi
  await page.goto('/settings/team/platform/roster');
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible();
  const people = page.locator('[data-landmark="people"]');
  await expect(people.locator('[data-person]')).toHaveCount(3);
  await expect(people.locator(`[data-person="${personaEmail('omar')}"]`).getByLabel(/Team role for/)).toHaveValue('lead');

  // the stored template definition shows the channels as text
  const definition = page.locator('[data-landmark="template-definition"]');
  for (const channel of ['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup']) {
    await expect(definition).toContainText(channel);
  }
  await expect(definition).toContainText('Brain');

  // tag Rafi
  const rafi = people.locator(`[data-person="${personaEmail('rafi')}"]`);
  await rafi.getByLabel(/^Tag for /).fill('role:release-manager');
  await rafi.getByRole('button', { name: /^Add tag to / }).click();
  await expect(rafi.locator('.tagx', { hasText: 'role:release-manager' })).toHaveCount(1);
  await expect(people.locator(`[data-person="${personaEmail('nadia')}"] .tagx`)).toHaveCount(0);

  // and it is still there after a reload
  await page.reload();
  await expect(page.locator(`[data-person="${personaEmail('rafi')}"] .tagx`, { hasText: 'role:release-manager' })).toHaveCount(1);

  // applying the template again for the same slug creates nothing new
  await page.goto('/teams');
  await page.getByRole('checkbox', { name: 'Create a Engineering team' }).click();
  await page.getByLabel('Engineering team name').fill('Platform');
  await page.getByRole('button', { name: 'Create 1 team' }).click();
  await expect(page.locator('[data-landmark="created"]').getByRole('heading')).toContainText('Already exists: Platform');
  await expect(page.locator('[data-landmark="teams-list"] li', { hasText: 'Platform' })).toHaveCount(1);
});
