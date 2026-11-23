import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { closePerson, dock, meetingsStack, openAs, type Person } from './support.ts';

/**
 * The team schedule (PLAN P36-05..07), on the fake media server: Nadia opens Schedule, makes an appointment on Engineering's schedule for two minutes from now,
 * a video call, inviting Sameera of Customer support; it shows on her calendar. Sameera finds it on her own Schedule (her teams' and the ones she is invited
 * to), opens it and Joins; Nadia Joins it too: they are in the same call, in the appointment's own space.
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

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('Nadia schedules a video meeting with Sameera of another team; both find it on their Schedule and join the same call', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/schedule');
  const page = nadia.page;
  await expect(page.getByTestId('schedule')).toBeVisible();
  await page.getByTestId('schedule-new').click();
  const form = page.getByTestId('appointment-form');
  const start = new Date(Date.now() + 2 * 60_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  await form.getByTestId('appointment-title').fill('Escalation sync');
  await form.getByTestId('appointment-day').fill(ymd(start));
  await form.getByTestId('appointment-from').fill(hhmm(start));
  await form.getByTestId('appointment-to').fill(hhmm(end));
  await form.getByTestId('appointment-find').fill('Same');
  await form.locator('[data-testid="appointment-person"]').first().check();
  await form.getByTestId('appointment-save').click();
  await expect(form).toBeHidden();
  const mine = page.getByTestId('schedule-appointment').filter({ hasText: 'Escalation sync' });
  await expect(mine).toBeVisible();

  sameera = await openAs(browser, playwright, stack, 'sameera', '/t/customer-support/schedule');
  const hers = sameera.page.getByTestId('schedule-appointment').filter({ hasText: 'Escalation sync' });
  await expect(hers).toBeVisible({ timeout: 15_000 });
  await hers.click();
  const panel = sameera.page.getByTestId('appointment-panel');
  await expect(panel.getByTestId('appointment-people')).toContainText('Nadia');
  await expect(panel.getByTestId('appointment-join')).toBeEnabled();
  await panel.getByTestId('appointment-join').click();
  await expect(sameera.page).toHaveURL(/\/meeting\//);
  await expect(dock(sameera)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });

  await mine.click();
  await page.getByTestId('appointment-panel').getByTestId('appointment-join').click();
  await expect(dock(nadia)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  for (const p of [nadia, sameera]) await expect(p.page.getByTestId('call-face')).toHaveCount(2);
  const kind = await stack.sql<{ kind: string }>(`SELECT m.kind FROM app.meetings m JOIN app.appointments a ON a.space_channel_id = m.channel_id WHERE a.title = 'Escalation sync' ORDER BY m.started_at DESC LIMIT 1`);
  expect(kind[0]?.kind).toBe('video');
});
