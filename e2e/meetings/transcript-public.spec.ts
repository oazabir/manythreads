import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { answerConsent, closePerson, endForEveryone, enterRoom, finishNotes, installBots, lastMeeting, leave, meetingsStack, openAs, repoText, say, threadLines, turnOnTranscription, type Person } from './support.ts';

/**
 * A public channel's transcript (PLAN P15-17). Nadia and Rafi hold a room in #dev with transcription on their own devices. When the room ends the transcript and
 * the notes are committed to the team repository under `meetings/yyyy/mm/dd-hhmm-slug/` (a guarded folder), with both speakers in the transcript, and the Scribe
 * posts the notes into the room's thread. The meeting page and the Files tree show the same.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let meetingId = '';
let notes: Awaited<ReturnType<typeof finishNotes>>;

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

test('Nadia and Rafi talk in the room and it ends', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await enterRoom(nadia);
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  meetingId = (await lastMeeting(stack, 'dev')).id;
  rafi = await openAs(browser, playwright, stack, 'rafi');
  await enterRoom(rafi);
  await answerConsent(rafi, 'yes');

  await say(nadia, 'Good morning, the release branch is cut.');
  await say(rafi, 'We decided to ship on Thursday morning.');
  await say(nadia, 'I will write the rollback note by 2026-11-12.');
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND final AND text <> ''`, [meetingId])).length).toBe(3);

  // while the call is on, the meeting page says so and has no notes yet
  const other = await rafi.context.newPage();
  await other.goto(`/meetings/${meetingId}`);
  await expect(other.getByTestId('meeting-live')).toBeVisible();
  await other.close();
  await leave(rafi);
  await endForEveryone(nadia);
});

test('the transcript and the notes are committed in meetings/yyyy/mm/dd-hhmm-slug/, with both speakers', async () => {
  notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  expect(notes.location).toBe('repo');
  expect(notes.transcript_path).toMatch(/^meetings\/\d{4}\/\d{2}\/\d{2}-\d{4}-[a-z0-9-]+\/transcript\.md$/);
  expect(notes.notes_path).toBe(notes.transcript_path.replace(/transcript\.md$/, 'notes.md'));

  const transcript = await repoText(nadia!.api, 'engineering', notes.transcript_path);
  expect(transcript).not.toBeNull();
  expect(transcript).toContain('Nadia');
  expect(transcript).toContain('Rafi');
  expect(transcript).toContain('Good morning, the release branch is cut.');
  expect(transcript).toContain('We decided to ship on Thursday morning.');
  expect(transcript).toContain('I will write the rollback note by 2026-11-12.');

  const md = await repoText(nadia!.api, 'engineering', notes.notes_path!);
  expect(md).toContain('We decided to ship on Thursday morning.');
  expect(md).toContain('I will write the rollback note by 2026-11-12.');

});

test('a person cannot write into the meetings folder themselves', async () => {
  const res = await nadia!.api.ctx.post('/api/teams/engineering/repo/commit', {
    data: { message: 'sneaky', changes: [{ path: 'meetings/2026/11/08-0900-fake/transcript.md', op: 'put', content: 'Rafi said something he did not say.' }] },
    headers: await nadia!.api.headers(),
  });
  const text = await res.text();
  expect(res.status(), text).toBe(403);
  expect(text).toMatch(/guarded|platform|proposal|meetings/i);
});

test('the Scribe posts the notes in the room thread, and the meeting page shows them', async () => {
  const lines = await threadLines(stack, meetingId);
  const post = lines.find((l) => l.body.startsWith('**Notes from'));
  expect(post, `a notes line in the thread: ${JSON.stringify(lines.map((l) => l.body.slice(0, 60)))}`).toBeDefined();
  expect(post!.body).toContain(`[Open the notes](/meetings/${meetingId})`);
  expect(post!.body).toMatch(/1 decision · 1 action item/);

  const a = nadia!;
  await a.page.goto(`/meetings/${meetingId}`);
  await expect(a.page.getByTestId('notes-summary')).toContainText('Nadia and Rafi');
  await expect(a.page.getByTestId('notes-decisions')).toContainText('We decided to ship on Thursday morning.');
  await expect(a.page.getByTestId('notes-actions')).toContainText('I will write the rollback note');
  await a.page.getByTestId('meeting-tab-transcript').click();
  await expect(a.page.getByTestId('transcript-line')).toHaveCount(3);
});

test('the Files tree shows the meetings folder', async () => {
  const a = nadia!;
  await a.page.goto('/t/engineering/files');
  await expect(a.page.getByText('meetings', { exact: true }).first()).toBeVisible();
});
