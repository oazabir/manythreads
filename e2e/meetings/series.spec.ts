import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { closePerson, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Meeting series (PLAN P17-05): Nadia opens Schedule and makes a weekly meeting on Engineering's schedule. Next week's meeting is on the calendar with the repeat mark;
 * the first one's panel says how it repeats and opens its agenda page, which the platform wrote into `meetings/series/<slug>/`. She types into it live; the page is
 * saved as hers. Rafi (on the team) opens the same agenda on a phone, 390 px wide, with no sideways scroll.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone is opened inside');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: Person | undefined;
let rafi: Person | undefined;

test.beforeAll(async () => {
  stack = await meetingsStack('content');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await stack?.stop();
});

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('Nadia makes a weekly series, opens its first agenda and writes in it; Rafi opens it on a phone', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/schedule');
  const page = nadia.page;
  await expect(page.getByTestId('schedule')).toBeVisible();
  await page.getByTestId('schedule-new').click();
  const form = page.getByTestId('appointment-form');
  const start = new Date(Date.now() + 3 * 3600_000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  await form.getByTestId('appointment-title').fill('Team sync');
  await form.getByTestId('appointment-day').fill(ymd(start));
  await form.getByTestId('appointment-from').fill(hhmm(start));
  await form.getByTestId('appointment-to').fill(hhmm(end));
  await form.getByTestId('appointment-repeat').selectOption('weekly');
  await expect(form.getByTestId('appointment-series-note')).toContainText("everyone on Engineering can read and edit");
  await form.getByTestId('appointment-save').click();
  await expect(form).toBeHidden();

  const first = page.getByTestId('schedule-appointment').filter({ hasText: 'Team sync' });
  await expect(first.first()).toBeVisible();
  await expect(first.first().getByTestId('schedule-series-mark')).toBeVisible();
  // next week's meeting of the series is there too
  await page.getByTestId('schedule-next').click();
  await expect(page.getByTestId('schedule-appointment').filter({ hasText: 'Team sync' })).toHaveCount(1);
  await page.getByTestId('schedule-prev').click();

  // the platform writes the first agenda within seconds; the panel then offers it
  const panel = page.getByTestId('appointment-panel');
  await expect
    .poll(async () => {
      await page.keyboard.press('Escape');
      await page.getByTestId('schedule-appointment').filter({ hasText: 'Team sync' }).first().click();
      return panel.getByTestId('appointment-agenda-open').count();
    }, { timeout: 30_000, message: 'the agenda to be written' })
    .toBe(1);
  await expect(panel.getByTestId('appointment-repeats')).toHaveText('Every week');
  await expect(panel.getByTestId('series-stop')).toBeVisible();
  await panel.getByTestId('appointment-agenda-open').click();

  const dialog = page.getByTestId('agenda-dialog');
  await expect(dialog.getByTestId('live-status')).toHaveText('Live', { timeout: 15_000 });
  const area = dialog.getByLabel('Page source, edited live');
  await expect(area).toHaveValue(/## Open action items from the last meeting/);
  await area.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n- [ ] Book the room — Nadia\n');
  await dialog.getByTestId('leave-live').click();
  await expect(dialog).toBeHidden();
  const path = `meetings/series/team-sync/${start.toISOString().slice(0, 10)}-agenda.md`;
  await expect
    .poll(async () => (await stack.sql<{ message: string }>(`SELECT message FROM app.repo_commits WHERE $1 = ANY(paths) ORDER BY seq DESC LIMIT 1`, [path])).at(0)?.message ?? '', {
      timeout: 20_000,
      message: 'the live session to commit',
    })
    .toMatch(/^Edit .+ live/);

  // Rafi, on the team, on a phone
  rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/schedule', { mobile: true });
  const phone = rafi.page;
  await expect(phone.getByTestId('schedule')).toBeVisible();
  const mine = phone.getByTestId('schedule-appointment').filter({ hasText: 'Team sync' }).first();
  if (start.getDate() !== new Date().getDate()) await phone.getByTestId('schedule-next').click();
  await mine.click();
  await phone.getByTestId('appointment-panel').getByTestId('appointment-agenda-open').click();
  const sheet = phone.getByTestId('agenda-dialog');
  await expect(sheet.getByLabel('Page source, edited live')).toHaveValue(/Book the room — Nadia/, { timeout: 15_000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await sheet.getByTestId('leave-live').click();
});
