import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * P14-01b on the live site: the lead drives the Do not disturb screen for real: the account menu with its status and pause entries, the pause dialog,
 * the bell with its moon and the "Paused until … · Resume now" popover, the sidebar line, "Resume now", a status and its dialog, the Status and Do not
 * disturb section of the account page (pause, weekly schedule, time zone and working hours), and the same on a 390 px phone. It changes the signed-in
 * person's own settings and puts them back in the same run (status, time zone, working hours, pause, schedule), through the API with the session's CSRF
 * token. Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-01b-*.png (default temp/screenshots). Never run by `pnpm e2e` (not a *.spec.ts).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };

type Me = {
  status: { emoji: string | null; text: string; clearsAt: string | null } | null;
  timeZone: string | null;
  workingHours: { days: number[]; start: string; end: string } | null;
  dnd: { enabled: boolean; pausedUntil: string | null; schedule: { enabled: boolean; windows: unknown[] } };
};

async function csrf(page: Page): Promise<Record<string, string>> {
  const token = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  return { 'x-csrf-token': token };
}

/** Puts the person's settings back as they were when the run began. */
async function restore(page: Page, before: Me): Promise<void> {
  const headers = await csrf(page);
  const left = before.dnd.pausedUntil ? Math.ceil((Date.parse(before.dnd.pausedUntil) - Date.now()) / 60_000) : 0;
  const dnd = await page.request.put('/api/presence/dnd', {
    data: { enabled: before.dnd.enabled, pauseMinutes: left > 0 ? left : null, schedule: before.dnd.schedule },
    headers,
  });
  const me = await page.request.patch('/api/presence/me', {
    data: { status: before.status, timeZone: before.timeZone, workingHours: before.workingHours },
    headers,
  });
  console.log('restored: dnd', dnd.status(), 'profile', me.status());
}

test.describe.configure({ retries: 0 });
test.setTimeout(240_000);

test('Status and Do not disturb, end to end', async ({ browser }) => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const shot = async (name: string, target: Page = page): Promise<void> => {
    await target.waitForLoadState('networkidle');
    await target.screenshot({ path: join(OUT, `p14-01b-${name}.png`), animations: 'disabled' });
  };
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  const before = (await (await page.request.get('/api/presence/me')).json()) as Me;
  try {
    await page.goto('/t/engineering/threads');
    await expect(page.getByTestId('bell')).toBeVisible(T);

    // 1. the account menu and the pause dialog
    await page.getByRole('button', { name: 'Account menu' }).click();
    await shot('01-account-menu');
    await page.getByRole('menuitem', { name: 'Pause notifications…' }).click();
    await expect(page.getByTestId('pause-dialog')).toBeVisible(T);
    await shot('02-pause-dialog');
    await page.getByTestId('pause-1h').click();
    await expect(page.getByTestId('bell-paused')).toBeVisible(T);

    // 2. the bell, its popover and the sidebar line
    await shot('03-paused-sidebar-and-bell');
    await page.getByTestId('bell').click();
    await expect(page.getByTestId('paused-note')).toBeVisible(T);
    await shot('04-paused-popover');
    await page.getByTestId('notifications-popover').getByRole('button', { name: 'Resume now' }).click();
    await expect(page.getByTestId('bell-paused')).toHaveCount(0, T);
    await shot('05-resumed');

    // 3. a status
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Set status…' }).click();
    const dialog = page.getByTestId('status-dialog');
    await dialog.getByRole('button', { name: 'Working remotely' }).click();
    await dialog.getByLabel('Clear after').selectOption('today');
    await shot('06-status-dialog');
    await dialog.getByTestId('status-save').click();
    await expect(page.getByTestId('foot-status')).toBeVisible(T);
    await shot('07-status-in-sidebar');

    // 4. the account page: schedule, time zone and working hours
    await page.goto('/account#status-and-dnd');
    const section = page.getByTestId('presence-settings');
    await expect(section).toBeVisible(T);
    await section.getByTestId('schedule-switch').click();
    await shot('08-account-section');
    await section.getByTestId('hours-switch').click();
    await section.getByTestId('schedule-editor').scrollIntoViewIfNeeded();
    await shot('09-schedule-and-hours');

    // 5. the phone
    const phone = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', storageState: await context.storageState() });
    const small = await phone.newPage();
    await small.goto('/t/engineering/threads');
    await small.getByRole('button', { name: 'Open menu' }).click();
    await small.getByRole('button', { name: 'Account menu' }).click();
    await small.getByRole('menuitem', { name: 'Pause notifications…' }).click();
    await expect(small.getByTestId('pause-dialog')).toBeVisible(T);
    await shot('10-phone-pause-dialog', small);
    await small.getByTestId('pause-30m').click();
    await small.keyboard.press('Escape');
    await expect(small.getByTestId('bell-paused')).toBeVisible(T);
    await shot('11-phone-paused', small);
    await small.goto('/account#status-and-dnd');
    await expect(small.getByTestId('presence-settings')).toBeVisible(T);
    await shot('12-phone-account-section', small);
    await phone.close();
  } finally {
    await restore(page, before).catch((e: unknown) => console.log('restore failed', e));
    await page.screenshot({ path: join(OUT, 'p14-01b-13-after-restore.png'), animations: 'disabled' }).catch(() => undefined);
  }
  await context.close();
});
