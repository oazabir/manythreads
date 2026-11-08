import { expect, test } from '@playwright/test';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';
import type { Stack } from '../fixtures/stack.ts';
import { connectorsStack, dialogDateTime, personas, rows, seededOf, stateOf } from './support.ts';

/*
 * Schedule a room (PLAN P16-05, decisions D7 and D10) end to end, on seed v16: `#design` already holds Nadia's planned "Design review" with Rafi invited and its event
 * at her fake Google calendar. Covered: the header chip and its popover, the event at the calendar with the join link in both its description and its location,
 * the dialog (a second room with an outside guest whose address is NOT kept), the reminder five minutes ahead, the join page that opens the room, a person with no calendar
 * connected who is pointed to Settings, and the organizer's cancel (the event is removed). The 10-minute calendar sync is covered against the stand-in in
 * packages/plugins/meetings/test/scheduled-sync.test.ts; waiting for it here would make the spec ten minutes long.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width has its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const CHANNEL = '/t/engineering/c/design';
let stack: Stack;

test.beforeAll(async () => {
  stack = await connectorsStack({ MANYTHREADS_STACK_MEETINGS: '1' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the planned room shows as a chip in the header, and its popover says when, who organizes and how many are invited', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', CHANNEL);
  try {
    const chip = page.getByTestId('scheduled-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Design review');
    await chip.click();
    const pop = page.getByTestId('scheduled-pop');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Organized by Nadia');
    await expect(page.getByTestId('scheduled-invited')).toBeVisible();
    await expect(page.getByTestId('scheduled-join')).toBeVisible();
    // only the organizer can cancel
    await expect(page.getByTestId('scheduled-cancel')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the event at the organizer’s calendar carries the join link in its description and its location, and lists Rafi', async () => {
  const seeded = seededOf(stack);
  const state = await stateOf(stack);
  const event = state.workspace.createdEvents.find((e) => e.title === 'Design review');
  expect(event, 'the fake calendar holds the Design review event').toBeTruthy();
  expect(event!.account).toBe(personas.nadia.email);
  expect(event!.guests).toContain(personas.rafi.email);
  const detail = state.workspace.createdEventDetails.find((d) => d.eventId && d.account === personas.nadia.email && d.description.includes(`/join/${seeded.scheduledMeetingId}`));
  expect(detail, 'the description holds the join link').toBeTruthy();
  expect(detail!.location).toContain(`/join/${seeded.scheduledMeetingId}`);
  // the agenda comes first, then the link
  expect(detail!.description).toContain('Icon set');
});

test('Nadia plans a second room in the dialog with Rafi and an outside address: the calendar invites both, and the outside address is not kept', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', CHANNEL);
  try {
    await page.getByTestId('schedule-open').click();
    const dialog = page.getByTestId('schedule-dialog');
    await expect(dialog).toBeVisible();
    // the organizer has Google connected, so there is one calendar and no choice to make
    await expect(page.getByTestId('schedule-calendar-one')).toContainText('Google');
    const at = dialogDateTime(new Date(Date.now() + 3 * 3_600_000));
    await page.getByTestId('schedule-title').fill('Icon review');
    await page.getByTestId('schedule-date').fill(at.date);
    await page.getByTestId('schedule-time').fill(at.time);
    await page.getByTestId('schedule-length').selectOption('30');
    await page.getByTestId('schedule-people').getByLabel(/Rafi/).check();
    await page.getByTestId('schedule-outside').fill('guest@outside.test');
    await expect(page.getByTestId('schedule-invited')).toContainText('2 of');
    await page.getByTestId('schedule-agenda').fill('Pick the icon set.');
    await page.getByTestId('schedule-save').click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }

  const plan = await rows<{ id: string; outside_count: number; status: string }>(stack, `SELECT id, outside_count, status FROM app.scheduled_meetings WHERE title = 'Icon review'`);
  expect(plan).toHaveLength(1);
  expect(plan[0]).toMatchObject({ outside_count: 1, status: 'scheduled' });
  // the outside address went to the calendar and nowhere else
  expect(await rows(stack, `SELECT 1 FROM app.scheduled_meetings WHERE row_to_json(scheduled_meetings)::text LIKE '%outside.test%'`)).toHaveLength(0);
  expect(await rows(stack, `SELECT 1 FROM app.scheduled_meeting_attendees WHERE row_to_json(scheduled_meeting_attendees)::text LIKE '%outside.test%'`)).toHaveLength(0);
  const state = await stateOf(stack);
  const event = state.workspace.createdEvents.find((e) => e.title === 'Icon review');
  expect(event?.guests).toEqual(expect.arrayContaining([personas.rafi.email, 'guest@outside.test']));
  const published = await rows<{ n: string }>(stack, `SELECT count(*)::text AS n FROM app.events WHERE type = 'meetings.scheduled.created' AND payload::text LIKE '%outside.test%'`);
  expect(published[0]!.n).toBe('0');
});

test('the organizer cancels: the plan is cancelled, the chip goes, and the event is removed at the calendar', async ({ browser, playwright }) => {
  const seeded = seededOf(stack);
  // a plan of its own, an hour and a half ahead, so it is the next one and its chip is the one the header shows
  const nadiaApi = await apiOn(playwright, stack, 'nadia');
  let planId: string;
  try {
    const made = await nadiaApi.post<{ scheduledMeeting: { id: string } }>(`/api/channels/${seeded.designChannelId}/scheduled-meetings`, {
      title: 'Cancel me',
      startsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      lengthMinutes: 15,
      agendaMd: '',
      calendarProvider: 'google',
      attendeePersonIds: [],
      outsideAddresses: [],
    });
    planId = made.scheduledMeeting.id;
  } finally {
    await nadiaApi.ctx.dispose();
  }
  const before = (await stateOf(stack)).workspace.deletedEvents.length;
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', CHANNEL);
  try {
    await page.getByTestId('scheduled-chip').first().click();
    await expect(page.getByTestId('scheduled-pop')).toContainText('Cancel me');
    await page.getByTestId('scheduled-cancel').click();
    await expect.poll(async () => (await rows<{ status: string }>(stack, `SELECT status FROM app.scheduled_meetings WHERE id = $1`, [planId]))[0]!.status).toBe('cancelled');
  } finally {
    await context.close();
  }
  await expect.poll(async () => (await stateOf(stack)).workspace.deletedEvents.length, { timeout: 30_000 }).toBeGreaterThan(before);
  // a cancelled plan cannot be opened
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    expect(await rafi.status('POST', `/api/scheduled-meetings/${planId}/join`, {})).toBe(409);
  } finally {
    await rafi.ctx.dispose();
  }
});

test('five minutes before the start the invited people get "starts in 5 minutes", once, and the join page opens the room', async ({ browser, playwright }) => {
  // the minute job picks the plan up on its next tick (up to a minute), and the join page then opens the room
  test.setTimeout(240_000);
  const seeded = seededOf(stack);
  const nadia = await apiOn(playwright, stack, 'nadia');
  let planId: string;
  try {
    // 4 minutes 30 seconds ahead is inside the five-minute window, so the next tick of the minute job picks it up
    const startsAt = new Date(Date.now() + 270_000).toISOString();
    const made = await nadia.post<{ scheduledMeeting?: { id: string }; id?: string }>(`/api/channels/${seeded.designChannelId}/scheduled-meetings`, {
      title: 'Soon review',
      startsAt,
      lengthMinutes: 15,
      agendaMd: 'A short one.',
      calendarProvider: 'google',
      attendeePersonIds: [personas.rafi.personId],
      outsideAddresses: [],
    });
    planId = made.scheduledMeeting?.id ?? made.id ?? '';
    expect(planId).not.toBe('');
  } finally {
    await nadia.ctx.dispose();
  }

  await expect
    .poll(async () => (await rows<{ n: string }>(stack, `SELECT count(*)::text AS n FROM app.notifications WHERE kind = 'meeting_soon' AND ref_type = 'scheduled_meeting' AND ref_id = $1 AND person_id = $2`, [planId, personas.rafi.personId]))[0]!.n, {
      timeout: 150_000,
      intervals: [2_000, 5_000],
      message: 'Rafi to get the "starts in 5 minutes" notification',
    })
    .toBe('1');
  // never twice, and never to the organizer (she planned it)
  expect((await rows<{ n: string }>(stack, `SELECT count(*)::text AS n FROM app.notifications WHERE kind = 'meeting_soon' AND ref_id = $1`, [planId]))[0]!.n).toBe('1');

  const rafi = await openOn(browser, playwright, stack, 'rafi', `/join/${planId}`);
  try {
    await expect(rafi.page.getByTestId('join-scheduled')).toBeVisible();
    await expect(rafi.page.getByTestId('join-scheduled')).toContainText('Soon review');
    await rafi.page.getByTestId('join-scheduled-go').click();
    await expect(rafi.page.getByTestId('call-dock')).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
    expect((await rows<{ status: string }>(stack, `SELECT status FROM app.scheduled_meetings WHERE id = $1`, [planId]))[0]!.status).toBe('started');
  } finally {
    await rafi.context.close();
  }
});

test('a person with no calendar connected is told to connect one, and the page they are sent to is Settings, Connections', async ({ browser, playwright }) => {
  // Priya is in Engineering and has no Google or Microsoft sign-in in the seed
  const { page, context } = await openOn(browser, playwright, stack, 'priya', CHANNEL);
  try {
    await page.getByTestId('schedule-open').click();
    await expect(page.getByTestId('schedule-connect')).toContainText('Connect your Google or Microsoft calendar');
    await expect(page.getByTestId('schedule-save')).toBeDisabled();
    await page.getByTestId('schedule-connect-link').click();
    await expect(page).toHaveURL(/\/settings\/connections/);
  } finally {
    await context.close();
  }
});

test('a person who cannot read the channel finds no plan: not its title, not its time', async ({ playwright }) => {
  const seeded = seededOf(stack);
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    const res = await lena.ctx.get(`/api/scheduled-meetings/${seeded.scheduledMeetingId}`);
    const text = await res.text();
    expect(text).not.toContain('Design review');
    expect(text).not.toContain(seeded.startsAt);
  } finally {
    await lena.ctx.dispose();
  }
});

test('the dialog and the header fit a phone', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', CHANNEL, { viewport: PHONE, mobile: true });
  try {
    await page.getByTestId('schedule-open').click();
    await expect(page.getByTestId('schedule-dialog')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
