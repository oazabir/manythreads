import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BOOTSTRAP_TOKEN_FILE, WEB_EMPTY } from '../support/env.ts';

/**
 * PLAN P2 criterion 1 in the browser: an empty database prints a one-time link; opening it and creating the workspace
 * as Omar lands in the app with the workspace name in the header; the same link is then an expired page.
 * Runs against the empty server (WEB_EMPTY, see support/env.ts).
 */
test('first admin creates the workspace; reusing the link shows the expired page', async ({ page, browser }) => {
  const token = readFileSync(BOOTSTRAP_TOKEN_FILE, 'utf8').trim();
  const url = `${WEB_EMPTY}/bootstrap/${token}`;

  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await page.getByLabel('Workspace').fill('Kahf Software');
  await page.getByLabel('Name', { exact: true }).fill('Omar Al Zabir');
  await page.getByLabel('Email').fill('omar@kahf.example');

  // an 11-character password is refused with the rule shown (criterion 2)
  await page.getByLabel('Password', { exact: true }).fill('only-11-chr');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('Password must be at least 12 characters.');

  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  await expect(page).toHaveURL(`${WEB_EMPTY}/`);
  const header = page.locator('[data-landmark="header"]');
  await expect(header).toContainText('Kahf Software');
  await expect(header).toContainText('Omar Al Zabir');

  // the owner can see the workspace members: Omar is the first and only member
  await page.goto(`${WEB_EMPTY}/settings/workspace/members`);
  await expect(page.getByRole('cell', { name: 'omar@kahf.example' })).toBeVisible();

  // the link works once
  const other = await browser.newContext();
  const reuse = await other.newPage();
  await reuse.goto(url);
  await expect(reuse.getByRole('heading', { name: 'This link has already been used' })).toBeVisible();
  await expect(reuse.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
  await other.close();
});
