import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { closePerson, dock, enterRoom, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Invitations to a call (PLAN P15-27) between browsers, on the fake media server: Nadia starts a call in #dev from the start dialog with Rafi ticked; Rafi's bell has
 * "Nadia invited you to …" with Join, and Join puts him in the call. Then "Invite more" on the call card asks Omar the same way: the card names him and his bell has
 * the invitation. An invitation decides who is told, not who may join.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: Person | undefined;
let rafi: Person | undefined;
let omar: Person | undefined;

test.beforeAll(async () => {
  stack = await meetingsStack('content');
});
test.afterAll(async () => {
  for (const p of [nadia, rafi, omar]) await closePerson(p);
  await stack?.stop();
});

/** Opens the bell and finds the call invitation in it. */
async function invitation(p: Person) {
  await expect(p.page.getByTestId('bell-count')).toBeVisible({ timeout: 10_000 });
  await p.page.getByTestId('bell').click();
  const item = p.page.getByTestId('notifications-popover').locator('[data-testid="notification"][data-kind="meeting_invite"]');
  await expect(item).toHaveCount(1);
  return item;
}

test('the people ticked in the start dialog get an inbox item with Join, and Join puts them in the call', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await enterRoom(nadia, { invite: ['Rafi'] });
  // the call card is drawn in the channel and at the top of its thread, which opened as she joined
  await expect(nadia.page.getByTestId('room-card-invited').first()).toContainText('Rafi');

  rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/threads');
  const item = await invitation(rafi);
  await expect(item).toContainText('invited you to');
  await item.hover();
  await rafi.page.getByTestId('notification-join').click();
  await expect(dock(rafi)).toHaveAttribute('data-phase', 'connected', { timeout: 15_000 });
  await expect(nadia.page.getByTestId('call-face')).toHaveCount(2);
});

test('"Invite more" on the call card opens the same checklist for the live call and tells the new person the same way', async ({ browser, playwright }) => {
  const page = nadia!.page;
  await page.getByTestId('room-card-invite').first().click();
  const dialog = page.getByTestId('call-invite-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('call-invite-people').getByLabel('Omar').check();
  await dialog.getByTestId('call-invite-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('room-card-invited').first()).toContainText('Omar');

  omar = await openAs(browser, playwright, stack, 'omar', '/t/engineering/threads');
  const item = await invitation(omar);
  await expect(item).toContainText('invited you to');
  // asking Omar again finds nobody new
  await page.getByTestId('room-card-invite').first().click();
  await dialog.getByTestId('call-invite-people').getByLabel('Omar').check();
  await dialog.getByTestId('call-invite-submit').click();
  await expect(dialog.getByTestId('call-invite-none')).toBeVisible();
  await dialog.getByTestId('call-invite-cancel').click();
});
