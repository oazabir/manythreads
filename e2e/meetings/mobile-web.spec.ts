import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, type StackApi } from '../support/stack-browser.ts';
import { answerConsent, closePerson, dock, endForEveryone, enterRoom, finishNotes, installBots, lastMeeting, leave, meetingsStack, openAs, say, turnOnTranscription, type Person } from './support.ts';

/**
 * The voice room on a 390 px phone (PLAN P15-17, project `mobile-web`). The call bar is a sheet at the bottom of the channel: collapsed it is one line, and a tap on its handle
 * opens the people and the settings. Every control is big enough for a thumb, the consent question and the settings fit the screen, the chat opens as a full sheet, and the page of the
 * meeting reads as one column with tabs. Nothing on any of these screens scrolls sideways.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => !isMobile, 'phone viewport only');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let meetingId = '';

/** The box of an element must lie inside the 390 x 844 screen. */
async function fitsTheScreen(p: Person, testId: string): Promise<void> {
  const box = await p.page.getByTestId(testId).first().boundingBox();
  expect(box, `${testId} is on screen`).not.toBeNull();
  expect(box!.x, `${testId} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${testId} right edge`).toBeLessThanOrEqual(390.5);
  expect(box!.y + box!.height, `${testId} bottom edge`).toBeLessThanOrEqual(844.5);
}

/** Every button in the call bar is at least 44 px square: a thumb can hit it. */
async function thumbSized(p: Person, testIds: string[]): Promise<void> {
  for (const id of testIds) {
    const box = await p.page.getByTestId(id).boundingBox();
    expect(box, `${id} is on screen`).not.toBeNull();
    expect(box!.width, `${id} width`).toBeGreaterThanOrEqual(43.5);
    expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(43.5);
  }
}

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await installBots(stack, omar);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Nadia starts a room from her phone: the call bar is a sheet that fits, with thumb-sized controls', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/dev', { mobile: true });
  // the button is an icon on a phone, still with its name for a screen reader
  await expect(nadia.page.getByTestId('call-start')).toBeVisible();
  await expect(nadia.page.getByTestId('call-start')).toHaveAccessibleName('Start voice room');
  await enterRoom(nadia);
  meetingId = (await lastMeeting(stack, 'dev')).id;
  await expect(dock(nadia)).toHaveClass(/sheet/);
  await fitsTheScreen(nadia, 'call-dock');
  expect(await noSidewaysScroll(nadia.page)).toBe(true);
  await thumbSized(nadia, ['call-mute', 'call-deafen', 'call-captions', 'call-settings-btn']);

  // collapsed: one line, the people are behind the handle
  await expect(nadia.page.getByTestId('call-roster')).toBeHidden();
  await nadia.page.getByRole('button', { name: 'Show call details' }).click();
  await expect(nadia.page.getByTestId('call-roster')).toBeVisible();
  await expect(nadia.page.getByTestId('call-face')).toHaveCount(1);
  await fitsTheScreen(nadia, 'call-dock');
  await nadia.page.getByRole('button', { name: 'Hide call details' }).click();
  await expect(nadia.page.getByTestId('call-roster')).toBeHidden();

  // mute works by tap
  await nadia.page.getByTestId('call-mute').tap();
  await expect(nadia.page.getByTestId('call-mute')).toHaveAttribute('aria-pressed', 'true');
  await nadia.page.getByTestId('call-mute').tap();
  await expect(nadia.page.getByTestId('call-mute')).toHaveAttribute('aria-pressed', 'false');
});

test('transcription on a phone: the settings and the consent question fit the screen, and the words reach the room', async ({ browser, playwright }) => {
  rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/c/dev');
  await enterRoom(rafi);
  await nadia!.page.getByRole('button', { name: 'Show call details' }).click();
  await expect(nadia!.page.getByTestId('call-face')).toHaveCount(2);

  await turnOnTranscription(nadia!);
  const prompt = nadia!.page.getByTestId('call-consent');
  await expect(prompt).toBeVisible();
  await fitsTheScreen(nadia!, 'consent-yes');
  await fitsTheScreen(nadia!, 'consent-no');
  expect(await noSidewaysScroll(nadia!.page)).toBe(true);
  await answerConsent(nadia!, 'yes');
  await answerConsent(rafi, 'yes');
  await expect(nadia!.page.getByTestId('call-chip')).toHaveText('Transcribing');

  await say(nadia!, 'I will write the rollback note by 2026-12-01.');
  await say(rafi, 'We agreed to ship on Thursday.');
  await expect
    .poll(async () => (await stack.sql<{ text: string }>('SELECT text FROM app.meeting_segments WHERE meeting_id = $1 AND final ORDER BY start_ms', [meetingId])).map((r) => r.text), { timeout: 20_000 })
    .toEqual(['I will write the rollback note by 2026-12-01.', 'We agreed to ship on Thursday.']);
  // not one audio chunk left the phone while its own engine was on
  expect(nadia!.requests.filter((r) => r.includes('audio-chunks'))).toEqual([]);

  // captions: the strip shows lines inside the sheet
  await nadia!.page.getByTestId('call-captions').tap();
  await expect(nadia!.page.getByTestId('call-captions-strip')).toBeVisible();
  await fitsTheScreen(nadia!, 'call-captions-strip');
  expect(await noSidewaysScroll(nadia!.page)).toBe(true);
});

test('the chat of the call opens as a full sheet and closes again', async () => {
  await nadia!.page.getByTestId('call-chat').tap();
  const sheet = nadia!.page.locator('[data-landmark="right-panel"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('thread-view')).toBeVisible();
  expect(await noSidewaysScroll(nadia!.page)).toBe(true);
  await sheet.getByRole('button', { name: 'Close panel' }).tap();
  await expect(sheet).toBeHidden();
  await expect(dock(nadia!)).toBeVisible();
});

test('the room ends; the meeting page on a phone is one column with Notes and Transcript tabs', async () => {
  await leave(rafi!);
  await endForEveryone(nadia!);
  const notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  await nadia!.page.goto(`/meetings/${meetingId}`);
  await expect(nadia!.page.getByTestId('meeting-view')).toBeVisible();
  await expect(nadia!.page.getByTestId('notes-card')).toBeVisible();
  expect(await noSidewaysScroll(nadia!.page)).toBe(true);
  await expect(nadia!.page.getByTestId('action-item').first()).toBeVisible();
  await nadia!.page.getByTestId('meeting-tab-transcript').tap();
  await expect(nadia!.page.getByTestId('transcript-line').first()).toBeVisible();
  await expect(nadia!.page.getByTestId('transcript-line').filter({ hasText: 'ship on Thursday' })).toBeVisible();
  expect(await noSidewaysScroll(nadia!.page)).toBe(true);
});
