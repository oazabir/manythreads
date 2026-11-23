import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { closePerson, dock, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Meetings without a channel (PLAN P36-03), on the fake media server: Nadia (Engineering) presses New meeting in the sidebar, gives it a title, finds Sameera
 * (Customer support) by name and starts it; she lands in the meeting's own page with the call bar. Sameera sees it under Meetings in her own team's sidebar
 * with its live dot, opens it and joins: both call bars show both people.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: Person | undefined;
let sameera: Person | undefined;

test.beforeAll(async () => {
  stack = await meetingsStack('content');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(sameera);
  await stack?.stop();
});

test('Nadia opens a meeting with Sameera of another team; Sameera finds it in her sidebar and joins', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  await nadia.page.getByTestId('new-meeting').click();
  const dialog = nadia.page.getByTestId('new-meeting-dialog');
  await dialog.getByTestId('new-meeting-title').fill('Escalation review');
  await dialog.getByTestId('new-meeting-find').fill('Same');
  await dialog.locator('[data-testid="new-meeting-person"]').first().check();
  await dialog.getByTestId('new-meeting-start').click();
  await expect(nadia.page).toHaveURL(/\/t\/engineering\/meeting\//);
  await expect(dock(nadia)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  const space = (await stack.sql<{ id: string; kind: string; team_id: string | null }>(`SELECT id, kind, team_id FROM app.channels WHERE kind = 'meeting' ORDER BY created_at DESC LIMIT 1`))[0]!;
  expect(space).toMatchObject({ kind: 'meeting', team_id: null });

  sameera = await openAs(browser, playwright, stack, 'sameera', '/t/customer-support');
  const row = sameera.page.getByTestId('meeting-space-row').filter({ hasText: 'Escalation review' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('a').click();
  await expect(sameera.page).toHaveURL(new RegExp(`/meeting/${space.id}`));
  await sameera.page.getByTestId('call-start').click();
  await expect(dock(sameera)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  for (const p of [nadia, sameera]) await expect(p.page.getByTestId('call-face')).toHaveCount(2);
});
