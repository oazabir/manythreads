import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn, postAs, PHONE, type StackApi } from '../support/stack-browser.ts';

/**
 * Status and Do not disturb (PLAN P14-01, docs/plugins/presence.md). Nadia pauses notifications from the account menu: the bell wears a moon and
 * says "paused until", the sidebar says so too, Rafi's mentions are held back (no count, nothing in the inbox), and "Resume now" delivers them
 * together. She sets and clears a status, sets quiet hours on a weekly schedule that are on right now (the line offers the schedule, not a resume),
 * and saves a time zone with working hours. The keyboard keeps focus in the dialog and gives it back. The phone has its own test at the end
 * (project mobile-web). The clock cannot be moved in a browser test, so the end of a pause by time is covered by the notifications plugin's own
 * tests (the release job) and by the unit tests of the client's state; this spec ends a pause by hand.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let omar: StackApi;
let chan = { id: '', name: '' };

type Me = {
  status: { emoji: string | null; text: string; clearsAt: string | null } | null;
  timeZone: string | null;
  workingHours: { days: number[]; start: string; end: string } | null;
  dnd: { enabled: boolean; pausedUntil: string | null; schedule: { enabled: boolean; windows: Array<{ days: number[]; start: string; end: string }> } };
  dndState: { active: boolean; reason: string | null; until: string | null };
};
const meOf = (api: StackApi): Promise<Me> => api.get<Me>('/api/presence/me');
const inbox = (api: StackApi): Promise<{ items: Array<{ preview: string; kind: string }> }> => api.get('/api/notifications');
async function putDnd(api: StackApi, body: unknown): Promise<void> {
  const res = await api.ctx.put('/api/presence/dnd', { data: body, headers: await api.headers() });
  expect(res.status(), `PUT dnd: ${await res.text()}`).toBe(200);
}
const clean = async (): Promise<void> => {
  await putDnd(nadia, { enabled: false, pauseMinutes: null, schedule: { enabled: false, windows: [] } });
  const res = await nadia.ctx.patch('/api/presence/me', { data: { status: null, workingHours: null }, headers: await nadia.headers() });
  expect(res.status()).toBe(200);
};

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  const name = 'quiet-hours';
  chan = { id: ((await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name })).channel.id), name };
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

const gear = (page: Page): Locator => page.getByRole('button', { name: 'Account menu' });

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own test below');

  test('a pause shows on the bell and the sidebar, holds a mention, and Resume now delivers it', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      await expect(page.getByTestId('bell')).toBeVisible(T);
      await expect(page.getByTestId('bell-paused')).toHaveCount(0);
      await expect(page.getByTestId('dnd-strip')).toHaveCount(0);

      await gear(page).click();
      await page.getByRole('menuitem', { name: 'Pause notifications…' }).click();
      const dialog = page.getByTestId('pause-dialog');
      await expect(dialog).toBeVisible();
      for (const label of ['30 minutes', '1 hour', 'Until tomorrow morning', 'Until I turn it off']) await expect(dialog.getByRole('button', { name: new RegExp(label) })).toBeVisible();
      await dialog.getByTestId('pause-30m').click();
      await expect(dialog).toHaveCount(0, T);

      // the bell, the sidebar line and the spoken note all say it, with the same end time
      await expect(page.getByTestId('bell-paused')).toBeVisible(T);
      await expect(page.getByTestId('bell')).toHaveAttribute('aria-label', /Notifications, paused until \d\d:\d\d/);
      const strip = page.getByTestId('dnd-strip');
      await expect(strip).toContainText(/Paused until \d\d:\d\d/);
      await expect(page.getByTestId('dnd-live')).toHaveText(/Paused until \d\d:\d\d/);
      expect(await page.getByTestId('dnd-live').getAttribute('role')).toBe('status');
      const state = (await meOf(nadia)).dndState;
      expect(state).toMatchObject({ active: true, reason: 'paused' });
      expect(Date.parse(state.until!) - Date.now()).toBeGreaterThan(28 * 60_000);
      expect(Date.parse(state.until!) - Date.now()).toBeLessThanOrEqual(30 * 60_000);

      // two mentions while paused: nothing is counted, listed or announced
      const before = (await inbox(nadia)).items.length;
      await postAs(rafi, chan.id, 'Held one: @nadia can you review the runbook?');
      await postAs(rafi, chan.id, 'Held two: @nadia and the checklist too.');
      await expect(page.getByText('Held two')).toBeVisible(T);
      await page.waitForTimeout(1_500);
      await expect(page.getByTestId('bell-count')).toHaveCount(0);
      expect((await inbox(nadia)).items.length).toBe(before);

      // the popover says what is happening and what will happen
      await page.getByTestId('bell').click();
      const pop = page.getByTestId('notifications-popover');
      await expect(pop.getByTestId('paused-note')).toContainText(/Paused until \d\d:\d\d/);
      await expect(pop.getByTestId('paused-note')).toContainText('delivered together when it ends');
      await expect(pop.getByTestId('notification')).toHaveCount(0);

      // Resume now: the moon and the line go, and both held mentions arrive together
      await pop.getByRole('button', { name: 'Resume now' }).click();
      await expect(page.getByTestId('bell-paused')).toHaveCount(0, T);
      await expect(page.getByTestId('dnd-strip')).toHaveCount(0);
      await expect(page.getByTestId('bell-count')).toHaveText('2', T);
      await page.keyboard.press('Escape');
      await page.getByTestId('bell').click();
      await expect(page.getByTestId('notification')).toHaveCount(2, T);
      expect((await meOf(nadia)).dndState.active).toBe(false);
      const arrived = (await inbox(nadia)).items.map((n) => n.preview).join(' | ');
      expect(arrived).toContain('Held one');
      expect(arrived).toContain('Held two');
    } finally {
      await context.close();
      await clean();
    }
  });

  test('the dialog keeps focus inside, and gives it back to the account button when it closes', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      await gear(page).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Pause notifications…' }).click();
      const dialog = page.getByTestId('pause-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('pause-30m')).toBeFocused();
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
      }
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(gear(page)).toBeFocused();
      expect((await meOf(nadia)).dndState.active).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('a custom end time is checked in words, and "until I turn it off" shows without a time', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account');
    try {
      const section = page.getByTestId('presence-settings');
      await expect(section).toBeVisible(T);
      const field = section.getByLabel('Or pause until (your time zone)');
      const local = (d: Date): string => {
        const p = (n: number): string => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      await field.fill(local(new Date(Date.now() - 3_600_000)));
      await section.getByTestId('pause-custom-save').click();
      await expect(section.getByTestId('pause-error')).toContainText('That time has already passed');
      await field.fill(local(new Date(Date.now() + 9 * 24 * 3_600_000)));
      await section.getByTestId('pause-custom-save').click();
      await expect(section.getByTestId('pause-error')).toContainText('at most 7 days');
      expect((await meOf(nadia)).dndState.active).toBe(false);

      await field.fill(local(new Date(Date.now() + 3 * 3_600_000)));
      await section.getByTestId('pause-custom-save').click();
      await expect(section.getByTestId('paused-note')).toContainText(/Paused until/, T);
      const until = Date.parse((await meOf(nadia)).dndState.until!);
      expect(until - Date.now()).toBeGreaterThan(2.9 * 3_600_000);

      await section.getByTestId('pause-hold').click();
      await expect(section.getByTestId('paused-note')).toContainText('Do not disturb is on', T);
      expect((await meOf(nadia)).dndState).toMatchObject({ active: true, reason: 'manual', until: null });
      await section.getByTestId('paused-note').getByRole('button', { name: 'Resume now' }).click();
      await expect(section.getByTestId('paused-note')).toHaveCount(0, T);
      expect((await meOf(nadia)).dndState.active).toBe(false);
    } finally {
      await context.close();
      await clean();
    }
  });

  test('a status is set from the menu, shows beside the name, refuses an empty one, and is cleared', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      await gear(page).click();
      await page.getByRole('menuitem', { name: 'Set status…' }).click();
      const dialog = page.getByTestId('status-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('status-emoji')).toBeFocused();

      await dialog.getByTestId('status-save').click();
      await expect(dialog.getByTestId('status-error')).toHaveText('Add an emoji or a few words.');

      await dialog.getByRole('button', { name: 'Working remotely' }).click();
      await expect(dialog.getByTestId('status-text')).toHaveValue('Working remotely');
      await dialog.getByLabel('What are you up to?').fill('Heads down until lunch');
      await dialog.getByRole('button', { name: 'Use 🎧' }).click();
      await dialog.getByLabel('Clear after').selectOption('1h');
      await dialog.getByTestId('status-save').click();
      await expect(dialog).toHaveCount(0, T);
      await expect(page.getByTestId('foot-status')).toContainText('Status: Heads down until lunch', T);
      const me = await meOf(nadia);
      expect(me.status).toMatchObject({ emoji: '🎧', text: 'Heads down until lunch' });
      expect(Date.parse(me.status!.clearsAt!) - Date.now()).toBeGreaterThan(55 * 60_000);

      // reopened, it shows what is set and when it clears; Clear status removes it
      await gear(page).click();
      await page.getByRole('menuitem', { name: 'Set status…' }).click();
      await expect(page.getByTestId('status-now')).toContainText('Heads down until lunch');
      await expect(page.getByTestId('status-now')).toContainText(/Clears \d\d:\d\d/);
      await page.getByTestId('status-clear-now').click();
      await expect(page.getByTestId('status-dialog')).toHaveCount(0, T);
      await expect(page.getByTestId('foot-status')).toHaveCount(0);
      expect((await meOf(nadia)).status).toBeNull();
    } finally {
      await context.close();
      await clean();
    }
  });

  test('a weekly schedule that is on now shows as quiet hours with the schedule to change, not a resume; the time zone and hours are saved', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account#status-and-dnd');
    try {
      const section = page.getByTestId('presence-settings');
      await expect(section).toBeVisible(T);
      await expect(section.getByRole('heading', { name: 'Status and Do not disturb' })).toBeInViewport(T);

      // time zone first, so the clock in the test is the clock the server reads
      await section.getByTestId('zone-select').selectOption('UTC');
      await section.getByTestId('hours-switch').click();
      await section.getByTestId('hours-start').fill('10:00');
      await section.getByTestId('hours-end').fill('09:00');
      await section.getByTestId('hours-save').click();
      await expect(section.getByTestId('hours-error')).toContainText('Working hours must end after they start');
      await section.getByTestId('hours-end').fill('18:00');
      await section.getByTestId('hours-save').click();
      await expect(section.getByTestId('hours-note')).toHaveText('Saved.', T);
      expect(await meOf(nadia)).toMatchObject({ timeZone: 'UTC', workingHours: { days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' } });

      // quiet hours around the current UTC time on every day
      const at = (offsetMinutes: number): string => {
        const d = new Date(Date.now() + offsetMinutes * 60_000);
        return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      };
      const schedule = section.getByTestId('schedule-editor');
      await schedule.getByTestId('schedule-switch').click();
      await expect(schedule.getByTestId('schedule-zone')).toHaveText('UTC');
      for (let day = 0; day < 7; day += 1) {
        await schedule.getByTestId(`day-${day}-start`).fill(at(-60));
        await schedule.getByTestId(`day-${day}-end`).fill(at(-60));
      }
      await schedule.getByTestId('schedule-save').click();
      await expect(schedule.getByTestId('schedule-error')).toContainText('the start and the end must differ');
      for (let day = 0; day < 7; day += 1) await schedule.getByTestId(`day-${day}-end`).fill(at(60));
      await schedule.getByTestId('schedule-save').click();
      await expect(schedule.getByTestId('schedule-note')).toHaveText('Schedule saved.', T);

      const saved = await meOf(nadia);
      expect(saved.dnd.schedule.enabled).toBe(true);
      expect(saved.dnd.schedule.windows).toHaveLength(1);
      expect(saved.dnd.schedule.windows[0]!.days.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(saved.dndState).toMatchObject({ active: true, reason: 'schedule' });

      // the page says it, with "Change" in place of "Resume now"
      const note = section.getByTestId('paused-note');
      await expect(note).toContainText(/Quiet hours until/, T);
      await expect(note.getByRole('button', { name: 'Resume now' })).toHaveCount(0);
      await expect(section.getByTestId('paused-live')).toHaveAttribute('role', 'status');

      // the same on a page with the sidebar
      await page.goto(`/t/engineering/c/${chan.name}`);
      await expect(page.getByTestId('dnd-strip')).toContainText('Quiet hours', T);
      await expect(page.getByTestId('dnd-strip').getByRole('link', { name: 'Change' })).toBeVisible();
      await expect(page.getByTestId('strip-resume')).toHaveCount(0);
      await expect(page.getByTestId('bell')).toHaveAttribute('data-paused', 'schedule');

      // a mention in quiet hours is held too
      const before = (await inbox(nadia)).items.length;
      await postAs(rafi, chan.id, 'Quiet hours: @nadia a note for the morning.');
      await page.waitForTimeout(1_500);
      expect((await inbox(nadia)).items.length).toBe(before);

      // switching the schedule off ends it (the settings keep the period)
      await page.goto('/account');
      const again = page.getByTestId('schedule-editor');
      await again.getByTestId('schedule-switch').click();
      await again.getByTestId('schedule-save').click();
      await expect(again.getByTestId('schedule-note')).toContainText('switched off', T);
      expect((await meOf(nadia)).dndState.active).toBe(false);
      await expect.poll(async () => (await inbox(nadia)).items.some((n) => n.preview.includes('Quiet hours')), { timeout: 20_000 }).toBe(true);
    } finally {
      await context.close();
      await clean();
    }
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone viewport only (project mobile-web)');

  test('pause from the drawer on a 390 px screen: big enough to touch, nothing sideways, the moon on the bell', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`, { viewport: PHONE, mobile: true });
    try {
      const tall = async (l: Locator): Promise<void> => {
        const box = await l.boundingBox();
        expect(box, 'visible').not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(36);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
      };
      await page.getByRole('button', { name: 'Open menu' }).click();
      await gear(page).click();
      await tall(page.getByRole('menuitem', { name: 'Pause notifications…' }));
      await tall(page.getByRole('menuitem', { name: 'Set status…' }));
      await page.getByRole('menuitem', { name: 'Pause notifications…' }).click();
      const dialog = page.getByTestId('pause-dialog');
      await expect(dialog).toBeVisible();
      for (const id of ['pause-30m', 'pause-1h', 'pause-tomorrow', 'pause-hold', 'pause-custom-time', 'pause-custom-save']) await tall(dialog.getByTestId(id));
      expect(await noSidewaysScroll(page)).toBe(true);
      await dialog.getByTestId('pause-1h').click();
      await expect(dialog).toHaveCount(0, T);
      await page.keyboard.press('Escape'); // closes the drawer

      await expect(page.getByTestId('bell-paused')).toBeVisible(T);
      await expect(page.getByTestId('bell')).toHaveAttribute('aria-label', /paused until \d\d:\d\d/);
      expect(await noSidewaysScroll(page)).toBe(true);
      await page.getByTestId('bell').click();
      await expect(page.getByTestId('notifications-popover').getByTestId('paused-note')).toBeVisible();
      const resume = page.getByTestId('notifications-popover').getByRole('button', { name: 'Resume now' });
      await tall(resume);
      const pop = await page.getByTestId('notifications-popover').boundingBox();
      expect(pop!.x).toBeGreaterThanOrEqual(0);
      expect(pop!.x + pop!.width).toBeLessThanOrEqual(PHONE.width);
      await resume.click();
      await expect(page.getByTestId('bell-paused')).toHaveCount(0, T);
    } finally {
      await context.close();
      await clean();
    }
  });

  test('the account section fits the screen and every control is large enough', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account', { viewport: PHONE, mobile: true });
    try {
      const section = page.getByTestId('presence-settings');
      await expect(section).toBeVisible(T);
      await section.getByTestId('schedule-switch').click();
      await section.getByTestId('hours-switch').click();
      const tall = async (l: Locator): Promise<void> => {
        await l.scrollIntoViewIfNeeded();
        const box = await l.boundingBox();
        expect(box, 'visible').not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(36);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
      };
      for (const id of ['status-emoji', 'status-text', 'status-clear', 'status-save', 'pause-30m', 'pause-hold', 'pause-custom-time', 'day-1-start', 'day-1-end', 'day-0-start', 'zone-select', 'hours-start', 'hours-end', 'hours-save']) {
        await tall(section.getByTestId(id));
      }
      // the switch rows are the touch target of the two switches
      for (const id of ['schedule-switch', 'hours-switch']) await tall(section.getByTestId(id).locator('xpath=ancestor::div[contains(@class,"pr-switch-row")]'));
      for (const d of [1, 2, 3]) await tall(section.getByTestId(`hours-day-${d}`).locator('xpath=ancestor::label'));
      expect(await noSidewaysScroll(page)).toBe(true);
    } finally {
      await context.close();
      await clean();
    }
  });
});
