import { expect, test } from '@playwright/test';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';
import type { Stack } from '../fixtures/stack.ts';
import { connectorsStack, personas } from './support.ts';

/*
 * The admin's Connected apps screen and the offboarding of a leaving person (PLAN P16-11, decisions D11 and D20), on seed v16: Omar, Nadia and Rafi have Google, Lena has Microsoft.
 * Covered: Connectors (a row for each connector in use, no problem on a healthy seed) and People (one row for each sign-in with the permissions given, never an email address); a
 * team lead who is not an admin gets nothing; Members, Lena, "Remove their connections": the preview names her Microsoft, Cancel changes nothing, and confirming switches her sign-in
 * off at once and removes it within a minute; the phone width.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width has its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

let stack: Stack;

interface PersonRow {
  connectionId: string;
  personName: string;
  connector: string;
  state: string;
}

test.beforeAll(async () => {
  stack = await connectorsStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Connectors lists a row for each connector in use, with counts, and says nothing is wrong on a healthy seed', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/connections');
  try {
    await expect(page.getByTestId('connections-admin')).toBeVisible();
    await expect(page.getByTestId('connections-admin-tab-connectors')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('connectors-admin')).toBeVisible();
    await expect(page.locator('[data-testid="connector-row"][data-connector="google"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="connector-row"][data-connector="microsoft"]').first()).toBeVisible();
    await expect(page.getByTestId('connector-problem')).toHaveCount(0);
    await expect(page.getByTestId('connectors-partial')).toHaveCount(0);
    // counts and states only: no address, no token
    const html = await page.content();
    expect(html).not.toMatch(/fs_(google|microsoft)_[0-9a-f]{24}/);
  } finally {
    await context.close();
  }
});

test('People lists each sign-in with the permissions given and its state, and shows no email address', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/connections');
  try {
    await page.getByTestId('connections-admin-tab-people').click();
    await expect(page).toHaveURL(/tab=people/);
    const people = page.getByTestId('people-scopes');
    await expect(people).toBeVisible();
    const rows = page.getByTestId('person-connection');
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: 'Lena' })).toHaveAttribute('data-connector', 'microsoft');
    for (const row of await rows.all()) await expect(row).toHaveAttribute('data-state', 'ok');
    expect(await people.innerText()).not.toContain('@');

    await page.getByTestId('people-search').fill('lena');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('people-search').fill('nobody-like-this');
    await expect(page.getByTestId('people-none')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a person who is not a workspace admin gets nothing: not the screen’s data, not the people list', async ({ browser, playwright }) => {
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    for (const path of ['/api/admin/connections/health', '/api/admin/connections/people', `/api/admin/people/${personas.lena.personId}/offboard-connections`]) {
      expect(await priya.status('GET', path), path).toBe(403);
    }
  } finally {
    await priya.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/settings/workspace/connections');
  try {
    await expect(page.getByTestId('person-connection')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Members, Lena, Remove their connections: the preview names her Microsoft, and Cancel changes nothing', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/members');
  try {
    const row = page.getByTestId('member-row').filter({ hasText: 'Lena' });
    await row.getByTestId('member-menu').click();
    await page.getByTestId('member-remove-connections').click();
    const dialog = page.getByTestId('offboard-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('offboard-own')).toContainText('Microsoft');
    await expect(page.getByTestId('offboard-confirm')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const { people } = await omar.get<{ people: PersonRow[] }>('/api/admin/connections/people');
    expect(people.filter((p) => p.personName.includes('Lena')).map((p) => p.state)).toEqual(['ok']);
  } finally {
    await omar.ctx.dispose();
  }
});

test('confirming switches Lena’s sign-in off and removes it within a minute, with one audit line', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/members');
  try {
    const row = page.getByTestId('member-row').filter({ hasText: 'Lena' });
    await row.getByTestId('member-menu').click();
    await page.getByTestId('member-remove-connections').click();
    await page.getByTestId('offboard-confirm').click();
    await expect(page.getByTestId('offboard-dialog')).toHaveCount(0);
    await expect(page.getByTestId('connection-note')).toContainText('switched off');
  } finally {
    await context.close();
  }
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await expect
      .poll(async () => (await omar.get<{ people: PersonRow[] }>('/api/admin/connections/people')).people.filter((p) => p.personName.includes('Lena')).length, { timeout: 90_000, intervals: [1_000, 3_000] })
      .toBe(0);
    // one audit line, with counts and no token
    const audit = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.events WHERE type = 'connections.person.offboarded'`);
    expect(audit[0]!.n).toBe('1');
  } finally {
    await omar.ctx.dispose();
  }
});

test('the screen fits a phone', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/connections?tab=people', { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('people-scopes')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
