import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, postAs, type StackApi } from '../support/stack-browser.ts';
import { closePerson, finishNotes, installBots, meetingsStack, openAs, repoText, type Person } from '../meetings/support.ts';
import { uploadFile, voiceMeta } from './voice-support.ts';

/**
 * A voice message in a voice room's thread (PLAN P15-14, P15-17, spec row "voice message in the room's thread appears in the transcript at its time"). The words the device
 * wrote for the message are a line of the room's transcript at the time the message was sent, under the same consent rule as speaking in the room: only the author who said
 * yes to "Transcribe my voice" in that call has a line. This spec drives the API for the room (the message is sent as the web client sends one) and the browser for what a
 * person reads afterwards, so it needs no microphone and is not one of the `voice-*` specs that run with the fake microphone.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');
test.describe.configure({ mode: 'serial' });

const CLIP = readFileSync(new URL('../fixtures/speech/hello.wav', import.meta.url));
const RAFI_WORDS = 'The rollback note is written and in the runbook.';
const PRIYA_WORDS = 'I would rather not be written down.';

let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let priya: StackApi;
let reader: Person | undefined;
let dev = '';
let meetingId = '';
let root = '';
let rafiMessage = '';

async function sendVoice(api: StackApi, body: string, durationMs: number): Promise<string> {
  const up = await uploadFile(api, dev, CLIP, 'audio/wav', 'voice.wav');
  expect(up.status, 'upload of the clip').toBe(201);
  const m = await api.post<{ id: string }>(`/api/channels/${dev}/messages`, { channelId: dev, body, threadRootId: root, attachments: [up.file!.id], voice: voiceMeta(up.file!.id, { durationMs }) });
  return m.id;
}

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  priya = await apiOn(playwright, stack, 'priya');
  const omar = await apiOn(playwright, stack, 'omar');
  await installBots(stack, omar);
  await omar.ctx.dispose();
  dev = (await channelsOf(nadia))['dev']!;
});
test.afterAll(async () => {
  await closePerson(reader);
  await Promise.all([nadia?.ctx.dispose(), rafi?.ctx.dispose(), priya?.ctx.dispose()]);
  await stack?.stop();
});

test('a room with transcription on: Rafi says yes, Priya says no', async () => {
  const started = await nadia.post<{ meeting: { id: string; threadRootId: string } }>(`/api/channels/${dev}/meetings`, {});
  meetingId = started.meeting.id;
  root = started.meeting.threadRootId;
  for (const who of [rafi, priya]) await who.post(`/api/meetings/${meetingId}/join`);
  await nadia.ctx.put(`/api/meetings/${meetingId}/transcription`, { data: { mode: 'on_device' }, headers: await nadia.headers() });
  await nadia.post(`/api/meetings/${meetingId}/consent`, { transcribe: 'yes' });
  await rafi.post(`/api/meetings/${meetingId}/consent`, { transcribe: 'yes' });
  await priya.post(`/api/meetings/${meetingId}/consent`, { transcribe: 'no' });
  expect((await nadia.get<{ mode: string }>(`/api/meetings/${meetingId}/transcription`)).mode).toBe('on_device');
});

test('Rafi’s voice message in the thread is a line of the transcript at the time it was sent', async () => {
  rafiMessage = await sendVoice(rafi, RAFI_WORDS, 5000);
  const sentAt = (await stack.sql<{ created_at: Date; started_at: Date }>(`SELECT m.created_at, mt.started_at FROM app.messages m, app.meetings mt WHERE m.id = $1 AND mt.id = $2`, [rafiMessage, meetingId]))[0]!;
  const endMs = sentAt.created_at.getTime() - sentAt.started_at.getTime();

  await expect
    .poll(async () => (await nadia.get<{ lines: Array<{ text: string }> }>(`/api/meetings/${meetingId}/transcript`)).lines.map((l) => l.text), { timeout: 20_000, message: 'the voice message as a line' })
    .toContain(RAFI_WORDS);
  const lines = (await nadia.get<{ lines: Array<{ text: string; speakerName: string; startMs: number; endMs: number; transcribed: boolean }> }>(`/api/meetings/${meetingId}/transcript`)).lines;
  const line = lines.find((l) => l.text === RAFI_WORDS)!;
  expect(line).toMatchObject({ speakerName: 'Rafi', transcribed: true });
  // it ends when the message was sent and lasts as long as the clip
  expect(line.endMs).toBe(endMs);
  expect(line.endMs - line.startMs).toBe(Math.min(5000, endMs));
  // sending the same message twice cannot make a second line: it is keyed by the message
  expect((await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND client_seg_id = $2`, [meetingId, `voice:${rafiMessage}`])).length).toBe(1);
  expect((await stack.sql<{ source: string }>(`SELECT source FROM app.meeting_segments WHERE meeting_id = $1 AND client_seg_id = $2`, [meetingId, `voice:${rafiMessage}`]))[0]!.source).toBe('device');
});

test('a voice message of someone who said no, a plain text message, and a voice message outside the thread add no line', async () => {
  const before = (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1`, [meetingId])).length;
  await sendVoice(priya, PRIYA_WORDS, 3000);
  await postAs(rafi, dev, 'A plain message in the room thread, not a voice message.', root);
  // the same kind of message in the channel itself, outside the room's thread
  const up = await uploadFile(rafi, dev, CLIP, 'audio/wav', 'elsewhere.wav');
  expect(up.status).toBe(201);
  await rafi.post(`/api/channels/${dev}/messages`, { channelId: dev, body: 'A voice message in the channel, not in the room.', threadRootId: null, attachments: [up.file!.id], voice: voiceMeta(up.file!.id, { durationMs: 2000 }) });
  // a negative: a later message that does count is taken after them, so the three above had their turn
  await sendVoice(rafi, 'And that is all from me.', 1000);
  await expect.poll(async () => (await stack.sql<{ text: string }>('SELECT text FROM app.meeting_segments WHERE meeting_id = $1', [meetingId])).map((r) => r.text), { timeout: 20_000 }).toContain('And that is all from me.');
  expect((await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1`, [meetingId])).length).toBe(before + 1);
  const all = JSON.stringify(await stack.sql('SELECT text FROM app.meeting_segments WHERE meeting_id = $1', [meetingId]));
  expect(all).not.toContain('rather not');
  expect(all).not.toContain('plain message');
  expect(all).not.toContain('not in the room');
});

test('the page of the meeting shows the line at its time, and the files of the room hold it', async ({ browser, playwright }) => {
  await nadia.post(`/api/meetings/${meetingId}/end`, {});
  const notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  const all = (await nadia.get<{ lines: Array<{ text: string; startMs: number }> }>(`/api/meetings/${meetingId}/transcript`)).lines;
  const startMs = all.find((l) => l.text === RAFI_WORDS)!.startMs;
  // `?t=` marks the last line that starts at or before the time: when another line starts at the same millisecond (the room's first second), that one is marked
  const markedText = all.filter((l) => l.startMs <= startMs).at(-1)!.text;

  reader = await openAs(browser, playwright, stack, 'nadia', `/meetings/${meetingId}?t=${startMs}`);
  await reader.page.getByTestId('meeting-tab-transcript').click();
  const line = reader.page.getByTestId('transcript-line').filter({ hasText: RAFI_WORDS });
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('data-start-ms', String(startMs));
  await expect(reader.page.getByTestId('transcript-line').filter({ hasText: markedText })).toHaveAttribute('aria-current', 'true');
  await expect(reader.page.getByTestId('transcript')).not.toContainText('rather not');

  const transcript = await repoText(nadia, 'engineering', notes.transcript_path);
  expect(transcript).toContain(RAFI_WORDS);
  expect(transcript).not.toContain('rather not');
});
