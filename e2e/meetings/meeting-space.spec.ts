import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { closePerson, dock, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Meetings without a channel (PLAN P36-03), on the fake media server: Nadia (Engineering) opens Chat in the sidebar (the meeting chats are listed there under "Meetings", P37-07) and presses New meeting, gives it a title,
 * finds Sameera (Customer support) by name and starts it; she lands in Chat with the meeting's chat on the right and the call bar. Sameera sees the
 * live dot on her Chat entry, opens it, picks the meeting in the list and joins: both call bars show both people. An old `/meeting/<id>` or `/meetings/space/<id>` link lands in Chat.
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

test('Nadia opens a meeting with Sameera of another team; Sameera finds it in Chat under Meetings and joins', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  await nadia.page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Chat' }).click();
  await expect(nadia.page).toHaveURL(/\/t\/engineering\/chat/);
  await expect(nadia.page.getByTestId('chat-meetings')).toBeVisible();
  await nadia.page.getByTestId('new-meeting').click();
  const dialog = nadia.page.getByTestId('new-meeting-dialog');
  await dialog.getByTestId('new-meeting-title').fill('Escalation review');
  await dialog.getByTestId('new-meeting-find').fill('Same');
  await dialog.locator('[data-testid="new-meeting-person"]').first().check();
  await dialog.getByTestId('new-meeting-start').click();
  await expect(nadia.page).toHaveURL(/\/t\/engineering\/chat\?meeting=/);
  await expect(dock(nadia)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  const space = (await stack.sql<{ id: string; kind: string; team_id: string | null }>(`SELECT id, kind, team_id FROM app.channels WHERE kind = 'meeting' ORDER BY created_at DESC LIMIT 1`))[0]!;
  expect(space).toMatchObject({ kind: 'meeting', team_id: null });

  sameera = await openAs(browser, playwright, stack, 'sameera', '/t/customer-support');
  const entry = sameera.page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: /Chat/ });
  await expect(entry.getByTestId('meetings-live')).toBeVisible({ timeout: 15_000 });
  await entry.click();
  const row = sameera.page.getByTestId('meeting-space-row').filter({ hasText: 'Escalation review' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('a').click();
  await expect(sameera.page).toHaveURL(new RegExp(`/t/customer-support/chat\\?meeting=${space.id}`));
  // the list stays on the left while the chat is open on the right
  await expect(row).toBeVisible();
  await sameera.page.getByTestId('call-start').click();
  await expect(dock(sameera)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  for (const p of [nadia, sameera]) await expect(p.page.getByTestId('call-face')).toHaveCount(2);
  // links from before the meetings moved into Chat land there
  for (const old of [`/t/engineering/meeting/${space.id}`, `/t/engineering/meetings/space/${space.id}`]) {
    await nadia.page.goto(old);
    await expect(nadia.page).toHaveURL(new RegExp(`/t/engineering/chat\\?meeting=${space.id}`));
  }
});
