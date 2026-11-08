import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { closePerson, installBots, meetingsStack, noteTakerMeeting, notesCardMessage, openAs, repoText, statusOf, type Person } from './support.ts';

/**
 * Sharing and saving the note-taker's notes (PLAN P15-17, criteria 13 and 14). The notes start private to Nadia, who organized the call. She shares them with Rafi from the
 * card the bot sent her: he can read the notes and the transcript, Priya (not shared) cannot, and taking the share back closes the door again. Then she saves them to the team
 * meeting notes: the files appear under `meetings/` in the team repository and the Archivist files a `Meeting` concept.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const NADIA_LINE = 'Let us decide the rollback owner for the settings release.';
const RAFI_LINE = 'I can write the rollback note by Friday.';

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let priya: Person | undefined;
let meetingId = '';
let channelId = '';
let messageId = '';

test.beforeAll(async ({ playwright, browser }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await installBots(stack, omar, ['note-taker', 'archivist']);
  const ran = await noteTakerMeeting(browser, playwright, stack, omar, { nadia: NADIA_LINE, rafi: RAFI_LINE });
  nadia = ran.nadia;
  rafi = ran.rafi;
  meetingId = ran.meetingId;
  expect(ran.notes.status).toBe('written');
  ({ channelId, messageId } = await notesCardMessage(stack, meetingId));
  priya = await openAs(browser, playwright, stack, 'priya', '/t/engineering/c/general');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await closePerson(priya);
  await omar?.ctx.dispose();
  await stack?.stop();
});

const readable = (p: Person) => statusOf(p.api, 'GET', `/api/meetings/${meetingId}/transcript?copy=organizer`);

test('before sharing, nobody but Nadia can read the notes', async () => {
  expect(await readable(nadia!)).toBe(200);
  for (const p of [rafi!, priya!]) {
    expect([403, 404], `${p.key} reads the transcript`).toContain(await readable(p));
    expect([403, 404], `${p.key} reads the notes`).toContain(await statusOf(p.api, 'GET', `/api/meetings/${meetingId}/notes`));
  }
  // the page of the meeting says so to Rafi
  await rafi!.page.goto(`/meetings/${meetingId}`);
  await expect(rafi!.page.getByTestId('meeting-error').or(rafi!.page.getByTestId('notes-error')).or(rafi!.page.getByTestId('notes-none'))).toBeVisible();
  await expect(rafi!.page.getByTestId('notes-card')).toHaveCount(0);
});

test('Nadia shares the notes with Rafi from the card; Rafi reads them, Priya still cannot', async () => {
  await nadia!.page.goto(`/t/engineering/chat/${channelId}?thread=${messageId}`);
  const card = nadia!.page.getByTestId('meeting-notes-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId('meeting-card-share').click();
  const dialog = nadia!.page.getByTestId('share-dialog');
  await expect(dialog.getByTestId('share-none')).toBeVisible();
  await dialog.getByTestId('share-person').selectOption({ label: 'Rafi' });
  await dialog.getByTestId('share-add').click();
  await expect(dialog.getByTestId('share-row')).toHaveCount(1);
  await expect(dialog.getByTestId('share-row')).toContainText('Rafi');

  // Rafi reads the notes and the transcript, in the page and in the API
  expect(await readable(rafi!)).toBe(200);
  expect(await statusOf(rafi!.api, 'GET', `/api/meetings/${meetingId}/notes`)).toBe(200);
  const copy = await rafi!.api.get<{ lines: Array<{ text: string }> }>(`/api/meetings/${meetingId}/transcript?copy=organizer`);
  expect(copy.lines.map((l) => l.text)).toEqual(expect.arrayContaining([NADIA_LINE, RAFI_LINE]));
  await rafi!.page.goto(`/meetings/${meetingId}`);
  await expect(rafi!.page.getByTestId('meeting-view')).toBeVisible();
  await expect(rafi!.page.getByTestId('meeting-notetaker')).toContainText('Note-taker');
  await rafi!.page.getByTestId('meeting-tab-transcript').click();
  await expect(rafi!.page.getByTestId('transcript-line').filter({ hasText: NADIA_LINE })).toBeVisible();
  // a reader is not the organizer: no Share button for him
  await expect(rafi!.page.getByTestId('meeting-share')).toHaveCount(0);

  // Priya was not given it
  expect([403, 404]).toContain(await readable(priya!));
});

test('Nadia takes the share back and Rafi is refused again', async () => {
  const dialog = nadia!.page.getByTestId('share-dialog');
  await dialog.getByTestId('share-stop').click();
  await expect(dialog.getByTestId('share-none')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => readable(rafi!)).not.toBe(200);
  expect([403, 404]).toContain(await readable(rafi!));
});

test('Nadia saves the notes to the team: the files are under meetings/ in the repository and the Meeting concept is filed', async () => {
  const card = nadia!.page.getByTestId('meeting-notes-card');
  await card.getByTestId('meeting-card-save').click();
  const dialog = nadia!.page.getByTestId('save-team-dialog');
  await expect(dialog.getByTestId('save-team-memory')).toBeChecked();
  const pick = dialog.getByTestId('save-team-pick');
  if (await pick.count()) await pick.selectOption({ value: 'engineering' });
  await dialog.getByTestId('save-team-go').click();
  await expect(dialog.getByTestId('save-team-done')).toContainText('meeting notes');
  await expect(dialog.getByTestId('save-team-done')).toContainText('team’s memory');
  await dialog.getByRole('button', { name: 'Done' }).click();
  // the card no longer offers Save again
  await expect(card.getByTestId('meeting-card-save')).toHaveCount(0);

  const row = (await stack.sql<{ saved_path: string | null; memory_item_id: string | null }>('SELECT saved_path, memory_item_id FROM app.meeting_notes WHERE meeting_id = $1', [meetingId]))[0]!;
  expect(row.saved_path).toMatch(/^meetings\/\d{4}\/\d{2}\/[^/]+\/notes\.md$/);
  const base = row.saved_path!.replace(/\/[^/]+$/, '');
  const notesMd = await repoText(nadia!.api, 'engineering', `${base}/notes.md`);
  const transcriptMd = await repoText(nadia!.api, 'engineering', `${base}/transcript.md`);
  expect(notesMd, `${base}/notes.md in the repository`).not.toBeNull();
  expect(transcriptMd).toContain(NADIA_LINE);
  expect(transcriptMd).toContain(RAFI_LINE);

  // the team memory got the meeting, with a Meeting concept
  expect(row.memory_item_id).not.toBeNull();
  await expect
    .poll(async () => (await stack.sql<{ state: string }>('SELECT state FROM app.memory_inbox_items WHERE id = $1', [row.memory_item_id]))[0]?.state, { timeout: 60_000, message: 'the memory item to be filed' })
    .toBe('filed');
  const item = (await stack.sql<{ origin: string; filed_paths: string[] }>('SELECT origin, filed_paths FROM app.memory_inbox_items WHERE id = $1', [row.memory_item_id]))[0]!;
  expect(item.origin).toBe('meeting');
  expect(item.filed_paths.some((p) => p.startsWith('memory/meetings/'))).toBe(true);

  // saving twice is refused
  expect(await statusOf(nadia!.api, 'POST', `/api/meetings/${meetingId}/save-to-team`, { addToMemory: true, teamSlug: 'engineering' })).toBe(409);
});
