import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, answerConsent, closePerson, endForEveryone, enterRoom, finishNotes, installBots, lastMeeting, leave, meetingsStack, openAs, say, storedLines, turnOnTranscription, type Person } from './support.ts';

/**
 * Consent (PLAN P15-17, §3 criterion on "Transcribe my voice"). Nadia turns transcription on; Rafi is asked when he joins, before his microphone opens.
 * He first says yes and speaks, then changes his mind: the words he said are blanked, his stretch shows as "Rafi spoke (not transcribed)" in the transcript,
 * and the notes the Scribe writes never quote him (the model is never shown his words). A second room: a person who says no at the prompt gets no engine
 * at all, and a device that kept sending after "no" has its lines stored blank.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const SECRET = 'I will secretly publish the staging password hunter2.';
const spool = join(mkdtempSync(join(tmpdir(), 'manythreads-consent-spool-')), 'hermes.jsonl');

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let meetingId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content', { HERMES_FAKE_SPOOL: spool });
  omar = await apiOn(playwright, stack, 'omar');
  await installBots(stack, omar);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('a late joiner is asked before the microphone opens; Rafi says yes and speaks', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await enterRoom(nadia);
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  meetingId = (await lastMeeting(stack, 'dev')).id;

  rafi = await openAs(browser, playwright, stack, 'rafi');
  await enterRoom(rafi);
  const prompt = rafi.page.getByTestId('call-consent');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Nadia turned on transcription');
  await expect(prompt).toContainText('If you say no, you can still talk');
  // nothing is listening on his device until he answers
  expect(await rafi.page.evaluate(() => (window as unknown as { __manythreadsSay?: (t: string) => boolean }).__manythreadsSay?.('too early') ?? false)).toBe(false);
  await answerConsent(rafi, 'yes');
  await expect(rafi.page.getByTestId('call-chip')).toHaveText('Transcribing');

  await say(nadia, 'Morning, let us look at the release.');
  await say(rafi, SECRET);
  await expect.poll(async () => (await storedLines(stack, meetingId)).map((l) => l.text)).toEqual(expect.arrayContaining(['Morning, let us look at the release.', SECRET]));
});

test('Rafi changes his mind: his words are blanked, his stretch is "spoke (not transcribed)", and a device that keeps sending stores nothing of him', async () => {
  const [a, b] = [nadia!, rafi!];
  const res = await b.api.ctx.post(`/api/meetings/${meetingId}/consent`, { data: { transcribe: 'no' }, headers: await b.api.headers() });
  expect(res.status()).toBe(200);
  // his page shows the new answer and stops listening
  await expect(b.page.getByTestId('call-chip')).toHaveText('Not transcribing you');
  await expect.poll(() => b.page.evaluate(() => (window as unknown as { __manythreadsSay?: (t: string) => boolean }).__manythreadsSay?.('still here') ?? false)).toBe(false);

  // the words he said before are gone from the database
  const rafiRows = (await storedLines(stack, meetingId)).filter((l) => l.speaker === actorOf('rafi'));
  expect(rafiRows.length).toBeGreaterThan(0);
  expect(rafiRows.every((l) => l.text === '')).toBe(true);

  // a device that did not stop: the route says the lines were blanked, the database keeps no words
  const post = await b.api.ctx.post(`/api/meetings/${meetingId}/segments`, {
    data: { segments: [{ clientSegId: 'stale-device-1', startMs: 40_000, endMs: 42_000, text: 'And the production key is hunter3.', final: true }] },
    headers: await b.api.headers(),
  });
  expect(post.status()).toBe(200);
  expect(((await post.json()) as { blanked: boolean }).blanked).toBe(true);
  const all = JSON.stringify(await stack.sql('SELECT text FROM app.meeting_segments WHERE meeting_id = $1', [meetingId]));
  expect(all).not.toContain('hunter');

  // what Nadia reads
  const transcript = await a.api.get<{ lines: Array<{ speakerName: string; text: string; transcribed: boolean }> }>(`/api/meetings/${meetingId}/transcript`);
  const rafiLines = transcript.lines.filter((l) => l.speakerName === 'Rafi');
  expect(rafiLines.length).toBeGreaterThan(0);
  for (const l of rafiLines) {
    expect(l.transcribed).toBe(false);
    expect(l.text).toBe('Rafi spoke (not transcribed)');
  }
  expect(transcript.lines.some((l) => l.speakerName === 'Nadia' && l.text === 'Morning, let us look at the release.' && l.transcribed)).toBe(true);
});

test('the room ends: the transcript file and the notes show Rafi only as "spoke (not transcribed)"; the model was never shown his words', async () => {
  const [a, b] = [nadia!, rafi!];
  await leave(b);
  await endForEveryone(a);
  const notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  expect(notes.location).toBe('repo');

  expect(notes.notes_md).not.toMatch(/hunter|secretly|staging password/i);
  expect(JSON.stringify(notes.items)).not.toMatch(/hunter|secretly|staging password/i);

  const file = await a.api.ctx.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(notes.transcript_path)}`);
  expect(file.status()).toBe(200);
  const markdown = ((await file.json()) as { content: string }).content;
  expect(markdown).toContain('Rafi spoke (not transcribed)');
  expect(markdown).toContain('Morning, let us look at the release.');
  expect(markdown).not.toMatch(/hunter|secretly|staging password/i);

  // the page of the meeting says the same
  await a.page.goto(`/meetings/${meetingId}`);
  await a.page.getByTestId('meeting-tab-transcript').click();
  await expect(a.page.getByTestId('transcript-line').filter({ hasText: 'Rafi spoke (not transcribed)' }).first()).toBeVisible();
  await expect(a.page.getByTestId('transcript-line').filter({ hasText: 'Rafi' }).filter({ hasNotText: 'spoke (not transcribed)' })).toHaveCount(0);
  await expect(a.page.getByTestId('transcript')).not.toContainText('hunter');

  // every prompt the stand-in model got, at any step
  expect(existsSync(spool), 'the stand-in model was asked at least once').toBe(true);
  const prompts = readFileSync(spool, 'utf8');
  expect(prompts).toContain('Write the notes of a meeting.');
  expect(prompts).not.toMatch(/hunter|secretly|staging password/i);
});

test('a person who says no at the prompt never gets an engine, and still hears and talks', async ({ browser, playwright }) => {
  await closePerson(nadia);
  await closePerson(rafi);
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await enterRoom(nadia);
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  rafi = await openAs(browser, playwright, stack, 'rafi');
  await enterRoom(rafi);
  await expect(rafi.page.getByTestId('call-consent')).toBeVisible();
  await answerConsent(rafi, 'no');
  await expect(rafi.page.getByTestId('call-chip')).toHaveText('Not transcribing you');
  await expect(rafi.page.getByTestId('call-mute')).toBeEnabled();
  expect(await rafi.page.evaluate(() => (window as unknown as { __manythreadsSay?: (t: string) => boolean }).__manythreadsSay?.('Not me.') ?? false)).toBe(false);
  // Nadia sees his answer on her side
  await expect(nadia.page.getByTestId('call-face').filter({ hasText: 'Rafi' })).toHaveAttribute('title', /not transcribed/);
  // and nothing of Rafi was stored for this room
  const second = await lastMeeting(stack, 'dev');
  expect(second.id).not.toBe(meetingId);
  expect((await storedLines(stack, second.id)).filter((l) => l.speaker === actorOf('rafi'))).toEqual([]);
});
