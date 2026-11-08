import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, closePerson, endForEveryone, enterRoom, lastMeeting, leave, mediaState, meetingsStack, openAs, repoText, speakToListener, statusOf, type Person } from './support.ts';

/**
 * Recording a call's audio (PLAN P15-17, P15-15 and decision C11). Off until a workspace admin allows it. Then anyone in the call may turn it on, and each person answers
 * "Record my voice?" for themself. Sound is saved only while EVERYONE present has said yes: a newcomer who has not said yes stops it at once, and it starts again when they
 * answer yes or leave. The files are one per person, in the channel's Files storage (never in git), and the page of the meeting lists them.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let priya: Person | undefined;
let meetingId = '';

const rows = () =>
  stack.sql<{ actor_id: string; file_id: string | null; stopped_at: string | null; stop_reason: string | null }>(
    'SELECT actor_id, file_id, stopped_at, stop_reason FROM app.meeting_recordings WHERE meeting_id = $1 ORDER BY started_at, id',
    [meetingId],
  );
const open = async () => (await rows()).filter((r) => r.stopped_at === null).map((r) => r.actor_id).sort();
const recorderHears = async () => [...((await mediaState(stack, omar, meetingId)).listeners.find((l) => l.identity === `recorder:${meetingId}`)?.subscriptions ?? [])].sort();
const answerRecord = async (p: Person, answer: 'yes' | 'no') => {
  await p.page.getByTestId(answer === 'yes' ? 'record-consent-yes' : 'record-consent-no').click();
  await expect(p.page.getByTestId('call-record-consent')).toBeHidden();
};

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await closePerson(priya);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('with the workspace switch off there is no record button, and the route says why', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  await enterRoom(nadia);
  meetingId = (await lastMeeting(stack, 'dev')).id;
  await expect(nadia.page.getByTestId('call-record')).toHaveCount(0);
  expect(await statusOf(nadia.api, 'PUT', `/api/meetings/${meetingId}/recording`, { on: true })).toBeGreaterThanOrEqual(400);
  expect((await nadia.api.get<{ on: boolean; cap: string }>(`/api/meetings/${meetingId}/recording`))).toMatchObject({ cap: 'off', on: false });
  await endForEveryone(nadia);
  await closePerson(nadia);
  nadia = undefined;
});

test('an admin allows recording; Nadia turns it on and nothing is saved until Rafi has also said yes', async ({ browser, playwright }) => {
  expect(await statusOf(omar, 'PUT', '/api/workspace/meetings-settings', { recordingCap: 'on' })).toBe(200);
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  await enterRoom(nadia);
  meetingId = (await lastMeeting(stack, 'dev')).id;
  rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/c/dev');
  await enterRoom(rafi);

  await nadia.page.getByTestId('call-record').click();
  for (const p of [nadia, rafi]) {
    await expect(p.page.getByTestId('call-rec-chip')).toContainText('Recording: waiting for');
    await expect(p.page.getByTestId('call-record-consent')).toBeVisible();
  }
  await answerRecord(nadia, 'yes');
  await expect(nadia.page.getByTestId('call-rec-chip')).toContainText('waiting for 1 person');
  // Rafi has not answered: nobody is heard and no file exists
  expect(await recorderHears()).toEqual([]);
  expect(await speakToListener(stack, omar, meetingId, 'nadia', 'This is not being recorded.')).toBe(false);
  expect(await rows()).toEqual([]);

  await answerRecord(rafi, 'yes');
  for (const p of [nadia, rafi]) await expect(p.page.getByTestId('call-rec-chip')).toHaveText('Recording', { timeout: 30_000 });
  await expect.poll(recorderHears, { timeout: 30_000, message: 'the recorder to hear both' }).toEqual([actorOf('nadia'), actorOf('rafi')].sort());
  expect(await open()).toEqual([actorOf('nadia'), actorOf('rafi')].sort());
  // the recorder only listens
  const state = await mediaState(stack, omar, meetingId);
  expect(state.published).toEqual([]);
  expect(await speakToListener(stack, omar, meetingId, 'nadia', 'Recorded: the release is on Thursday.', 1500)).toBe(true);
  expect(await speakToListener(stack, omar, meetingId, 'rafi', 'Recorded: I will write the note.', 1500)).toBe(true);
});

test('Priya joins without having said yes: recording stops for everybody at once; her no keeps it off; when she leaves it starts again', async ({ browser, playwright }) => {
  priya = await openAs(browser, playwright, stack, 'priya', '/t/engineering/c/dev');
  await enterRoom(priya);
  await expect.poll(open, { timeout: 30_000, message: 'the files to close for the newcomer' }).toEqual([]);
  expect(await recorderHears()).toEqual([]);
  expect((await rows()).map((r) => r.stop_reason).sort()).toEqual(['joined_without_yes', 'joined_without_yes']);
  for (const p of [nadia!, rafi!, priya]) await expect(p.page.getByTestId('call-rec-chip')).toContainText('waiting for 1 person', { timeout: 20_000 });
  // nothing she says is heard
  expect(await speakToListener(stack, omar, meetingId, 'priya', 'Please do not record this.')).toBe(false);

  await expect(priya.page.getByTestId('call-record-consent')).toBeVisible();
  await answerRecord(priya, 'no');
  // wait for the server to have taken her "no" (what her page shows is the server's answer) and show nothing started; a start that came late would show in the next test, which counts exactly four stretches and none of them Priya's
  const hers = priya.api;
  await expect
    .poll(async () => (await hers.get<{ yourConsent: string }>(`/api/meetings/${meetingId}/recording`)).yourConsent, { message: 'the server to hold her no' })
    .toBe('no');
  expect(await open()).toEqual([]);
  expect((await rows()).some((r) => r.actor_id === actorOf('priya'))).toBe(false);

  await leave(priya);
  for (const p of [nadia!, rafi!]) await expect(p.page.getByTestId('call-rec-chip')).toHaveText('Recording', { timeout: 30_000 });
  await expect.poll(open, { timeout: 30_000 }).toEqual([actorOf('nadia'), actorOf('rafi')].sort());
});

test('the room ends: one file per person per stretch, in the channel Files, never in git; the page of the meeting lists them', async () => {
  await leave(rafi!);
  // a person who leaves ends their own file; wait for that before the room ends, or the end closes it first
  await expect.poll(async () => (await rows()).find((r) => r.actor_id === actorOf('rafi') && r.stopped_at !== null && r.stop_reason === 'left')?.stop_reason, { timeout: 30_000 }).toBe('left');
  await endForEveryone(nadia!);
  await expect.poll(async () => (await rows()).every((r) => r.stopped_at !== null && r.file_id !== null), { timeout: 60_000, message: 'every file closed and stored' }).toBe(true);
  const all = await rows();
  expect(all).toHaveLength(4);
  // the first stretch closed because Priya came in; the second ended with Rafi leaving and with the room
  expect(all.map((r) => r.stop_reason).sort()).toEqual(['ended', 'joined_without_yes', 'joined_without_yes', 'left']);
  expect(all.filter((r) => r.stop_reason === 'joined_without_yes')).toHaveLength(2);
  expect(all.some((r) => r.actor_id === actorOf('priya'))).toBe(false);

  const files = await stack.sql<{ id: string; name: string; mime: string; folder_path: string; channel_id: string | null; uploader_id: string }>(
    `SELECT f.id, f.name, f.mime, f.folder_path, f.channel_id, f.uploader_id FROM app.files f JOIN app.meeting_recordings r ON r.file_id = f.id WHERE r.meeting_id = $1 ORDER BY f.name`,
    [meetingId],
  );
  expect(files).toHaveLength(4);
  for (const f of files) {
    expect(f.mime).toBe('audio/wav');
    expect(f.folder_path).toMatch(/^channels\/dev\/meetings\/[^/]+\/audio\/$/);
    expect(f.channel_id).not.toBeNull();
    // it is a sound file, written by the platform, and any reader of the channel can fetch it
    const res = await rafi!.api.ctx.get(`/api/files/${f.id}/content`);
    expect(res.status()).toBe(200);
    const bytes = await res.body();
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WAVE');
  }
  expect(new Set(files.map((f) => f.uploader_id))).toEqual(new Set([actorOf('nadia'), actorOf('rafi')]));
  // not in the team repository
  expect(await repoText(nadia!.api, 'engineering', `${files[0]!.folder_path}${files[0]!.name}`)).toBeNull();

  // the recording state names them to a reader
  const state = await nadia!.api.get<{ on: boolean; recording: boolean; files: unknown[] }>(`/api/meetings/${meetingId}/recording`);
  expect(state.recording).toBe(false);
  expect(state.files).toHaveLength(4);

  // and the page of the meeting says there is audio
  await nadia!.page.goto(`/meetings/${meetingId}`);
  await expect(nadia!.page.getByTestId('meeting-recording')).toBeVisible();
});
