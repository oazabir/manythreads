import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { answerConsent, closePerson, endForEveryone, enterRoom, finishNotes, installBots, lastMeeting, leave, meetingsStack, openAs, repoText, say, statusOf, turnOnTranscription, type Person } from './support.ts';

/**
 * A call in a private channel (PLAN P15-17). Omar makes a private room with Nadia and Rafi (Priya is in Engineering but not in it). The transcript and the notes
 * go to the channel's Files folder, never to the team repository, so the whole team cannot read them; nothing is sent to team memory unasked; Priya is refused
 * on the meeting, its transcript and its files.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const ROOM = 'leads-private';
let stack: Stack;
let omar: StackApi;
let priya: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let meetingId = '';
let notes: Awaited<ReturnType<typeof finishNotes>>;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  priya = await apiOn(playwright, stack, 'priya');
  const room = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: ROOM, private: true })).channel.id;
  for (const who of ['nadia', 'rafi'] as const) {
    const api = await apiOn(playwright, stack, who);
    const me = await api.get<{ person: { id: string } }>('/api/session');
    await omar.post(`/api/channels/${room}/members`, { personId: me.person.id });
    await api.ctx.dispose();
  }
  await installBots(stack, omar);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await priya?.ctx.dispose();
  await stack?.stop();
});

test('Nadia and Rafi hold the call in the private room and it ends', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${ROOM}`);
  await enterRoom(nadia);
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  meetingId = (await lastMeeting(stack, ROOM)).id;
  rafi = await openAs(browser, playwright, stack, 'rafi', `/t/engineering/c/${ROOM}`);
  await enterRoom(rafi);
  await answerConsent(rafi, 'yes');
  await say(nadia, 'About the salary bands for the leads.');
  await say(rafi, 'We decided to keep them as they are.');
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND final AND text <> ''`, [meetingId])).length).toBe(2);

  // Priya cannot even see that the room is live
  expect(await priya.status('GET', `/api/meetings/${meetingId}`)).toBe(404);
  await leave(rafi);
  await endForEveryone(nadia);
});

test('the transcript and the notes are in the channel Files folder and not in the repository', async () => {
  notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  expect(notes.location).toBe('channel_files');
  const rows = await stack.sql<{ file_ids: string[] }>('SELECT file_ids FROM app.meeting_notes WHERE meeting_id = $1', [meetingId]);
  expect(rows[0]!.file_ids.length).toBe(2);

  // nothing at that path in the team repository, and nothing at all under meetings/
  expect(await repoText(nadia!.api, 'engineering', notes.transcript_path)).toBeNull();
  const tree = await nadia!.api.ctx.get('/api/teams/engineering/repo/tree?path=meetings');
  if (tree.status() === 200) expect(JSON.stringify(await tree.json())).not.toContain('salary');

  // the members read the files
  for (const fileId of rows[0]!.file_ids) {
    const res = await nadia!.api.ctx.get(`/api/files/${fileId}/content`);
    expect(res.status()).toBe(200);
  }
  const transcript = await nadia!.api.get<{ lines: Array<{ text: string }> }>(`/api/meetings/${meetingId}/transcript`);
  expect(transcript.lines.map((l) => l.text)).toEqual(['About the salary bands for the leads.', 'We decided to keep them as they are.']);
  const rafiRead = await rafi!.api.ctx.get(`/api/meetings/${meetingId}/transcript`);
  expect(rafiRead.status()).toBe(200);
});

test('nothing reached team memory unasked', async () => {
  expect(notes.memory_item_id).toBeNull();
  expect(await stack.sql(`SELECT 1 FROM app.memory_inbox_items`)).toEqual([]);
});

test('Priya is refused on the meeting, the transcript, the notes and the files', async ({ browser, playwright }) => {
  const fileIds = (await stack.sql<{ file_ids: string[] }>('SELECT file_ids FROM app.meeting_notes WHERE meeting_id = $1', [meetingId]))[0]!.file_ids;
  for (const path of [`/api/meetings/${meetingId}`, `/api/meetings/${meetingId}/transcript`, `/api/meetings/${meetingId}/notes`, `/api/meetings/${meetingId}/summary`]) {
    expect([403, 404], `Priya GET ${path}`).toContain(await priya.status('GET', path));
  }
  for (const fileId of fileIds) {
    expect([403, 404], `Priya GET file ${fileId}`).toContain(await priya.status('GET', `/api/files/${fileId}/content`));
  }
  expect(await statusOf(priya, 'POST', `/api/meetings/${meetingId}/join`)).toBeGreaterThanOrEqual(403);

  // and the page says the same to her
  const seen = await openAs(browser, playwright, stack, 'priya', `/meetings/${meetingId}`);
  try {
    await expect(seen.page.getByTestId('meeting-error')).toBeVisible();
    await expect(seen.page.getByText('salary')).toHaveCount(0);
  } finally {
    await closePerson(seen);
  }
});
