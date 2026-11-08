import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, answerConsent, closePerson, endForEveryone, enterRoom, finishNotes, installBots, lastMeeting, leave, mediaState, meetingsStack, openAs, speakToListener, statusOf, type Person } from './support.ts';

/**
 * The note-taker in a call (PLAN P15-17, §3 criteria 11 to 14). Nadia adds the Note-taker bot to a call in #general; Rafi says yes to being written down and Priya
 * says no. The bot listens on the server to the people who said yes only. The transcript is in Nadia's own My files and nowhere else; when the room ends she is
 * told in her conversation with the bot, with links; the notes never quote Priya; Rafi, who was in the room, is refused on the folder until she shares it.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const PRIYA_SECRET = 'I will secretly forward the pricing sheet to the competitor.';
const spool = join(mkdtempSync(join(tmpdir(), 'manythreads-notetaker-spool-')), 'hermes.jsonl');

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let priya: Person | undefined;
let meetingId = '';
let notes: Awaited<ReturnType<typeof finishNotes>>;
let fileIds: string[] = [];

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content', { HERMES_FAKE_SPOOL: spool });
  omar = await apiOn(playwright, stack, 'omar');
  await installBots(stack, omar, ['note-taker']);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await closePerson(priya);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Nadia adds the Note-taker; Rafi says yes and Priya says no', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  await enterRoom(nadia);
  meetingId = (await lastMeeting(stack, 'general')).id;
  rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/c/general');
  await enterRoom(rafi);
  priya = await openAs(browser, playwright, stack, 'priya', '/t/engineering/c/general');
  await enterRoom(priya);

  await nadia.page.getByTestId('call-notetaker-btn').click();
  await expect(nadia.page.getByTestId('notetaker-option')).toHaveCount(1);
  await nadia.page.getByTestId('notetaker-add-note-taker').click();
  for (const p of [nadia, rafi, priya]) {
    await expect(p.page.getByTestId('call-notetaker-face')).toBeVisible();
    // everybody is asked again, in words that say who listens, where, and that only a yes is written down
    await expect(p.page.getByTestId('call-consent')).toContainText('Let the note-taker write down my voice?');
  }
  await answerConsent(nadia, 'yes');
  await answerConsent(rafi, 'yes');
  await answerConsent(priya, 'no');
  await expect(priya.page.getByTestId('call-chip')).toContainText('Not transcribing you');
  await expect(nadia.page.getByTestId('call-notetaker-badge')).toContainText(/listening/i);
});

test('the bot hears Nadia and Rafi and never Priya; it publishes nothing', async () => {
  // the listener follows a consent change within a couple of seconds
  await expect
    .poll(async () => [...((await mediaState(stack, omar, meetingId)).listeners[0]?.subscriptions ?? [])].sort(), { timeout: 20_000, message: 'the listener to follow the answers' })
    .toEqual([actorOf('nadia'), actorOf('rafi')].sort());
  const heard = await mediaState(stack, omar, meetingId);
  expect(heard.listeners).toHaveLength(1);
  expect(await speakToListener(stack, omar, meetingId, 'priya', 'probe')).toBe(false);
  expect(heard.published).toEqual([]);
  expect(heard.tokens.filter((t) => t.kind === 'bot').every((t) => !t.canPublish && t.listenOnly)).toBe(true);

  for (const [who, text] of [['nadia', 'Let us start the design review for the settings page.'], ['rafi', 'The spacing looks consistent at 390 pixels.']] as const) {
    await expect.poll(() => speakToListener(stack, omar, meetingId, who, text), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await nadia!.api.get<{ lines: Array<{ text: string }> }>(`/api/meetings/${meetingId}/transcript`)).lines.map((l) => l.text), { timeout: 20_000 }).toContain(text);
  }
  // Priya talks too; nothing of her reaches the server
  expect(await speakToListener(stack, omar, meetingId, 'priya', PRIYA_SECRET)).toBe(false);
  expect(JSON.stringify(await stack.sql('SELECT text FROM app.meeting_segments WHERE meeting_id = $1', [meetingId]))).not.toContain('competitor');
});

test('the room ends: the transcript and the notes are in Nadia’s My files and nowhere else, and Nadia is told in her conversation with the bot', async () => {
  await leave(priya!);
  await leave(rafi!);
  await endForEveryone(nadia!);
  notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  expect(notes.location).toBe('personal');
  expect(notes.transcript_path).toMatch(/^Meetings\/\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\/transcript\.md$/);
  expect(notes.notes_path).toBe(notes.transcript_path.replace(/transcript\.md$/, 'notes.md'));
  fileIds = (await stack.sql<{ file_ids: string[] }>('SELECT file_ids FROM app.meeting_notes WHERE meeting_id = $1', [meetingId]))[0]!.file_ids;
  expect(fileIds.length).toBeGreaterThanOrEqual(2);

  // not in the team repository, not in the channel's Files
  const blob = await nadia!.api.ctx.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(notes.transcript_path)}`);
  expect(blob.status()).toBe(404);
  const inChannel = await stack.sql(`SELECT 1 FROM app.files f WHERE f.id = ANY($1::uuid[]) AND f.channel_id IS NOT NULL`, [fileIds]);
  expect(inChannel).toEqual([]);

  // Nadia reads her own copy
  for (const id of fileIds) expect((await nadia!.api.ctx.get(`/api/files/${id}/content`)).status(), `Nadia reads file ${id}`).toBe(200);

  // the message from the note-taker, in her conversation with it, with the links
  const messages = await stack.sql<{ id: string; channel_id: string; body: string; meta: Record<string, unknown> | null }>(
    `SELECT m.id, m.channel_id, m.body, m.meta FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE a.kind = 'bot' AND m.meta ? 'meetingNotes' ORDER BY m.id`,
  );
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages[0]!.meta)).toContain(meetingId);
  await nadia!.page.goto(`/t/engineering/chat/${messages[0]!.channel_id}?thread=${messages[0]!.id}`);
  const card = nadia!.page.getByTestId('meeting-notes-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('meeting-card-share')).toBeVisible();
  await expect(card.getByTestId('meeting-card-save')).toBeVisible();
  await card.getByTestId('meeting-card-open').click();
  await expect(nadia!.page).toHaveURL(new RegExp(`/meetings/${meetingId}`));
  await expect(nadia!.page.getByTestId('meeting-notetaker')).toContainText('Note-taker');
});

test('the notes never quote Priya', async () => {
  const everything = JSON.stringify([notes.notes_md, notes.items]);
  expect(everything).not.toMatch(/competitor|pricing sheet|secretly/i);
  const text = await (await nadia!.api.ctx.get(`/api/files/${fileIds[0]}/content`)).text();
  const other = await (await nadia!.api.ctx.get(`/api/files/${fileIds[1]}/content`)).text();
  expect(text + other).not.toMatch(/competitor|pricing sheet|secretly/i);
  expect(text + other).toContain('Let us start the design review for the settings page.');
  expect(existsSync(spool), 'the stand-in model was asked').toBe(true);
  expect(readFileSync(spool, 'utf8')).not.toMatch(/competitor|pricing sheet|secretly/i);
});

test('Rafi, who was in the room, is refused on the folder', async () => {
  for (const id of fileIds) expect([403, 404], `Rafi reads file ${id}`).toContain((await rafi!.api.ctx.get(`/api/files/${id}/content`)).status());
  expect([403, 404]).toContain(await statusOf(rafi!.api, 'GET', `/api/meetings/${meetingId}/transcript?copy=organizer`));
  expect([403, 404]).toContain(await statusOf(rafi!.api, 'GET', `/api/meetings/${meetingId}/notes`));
  const me = await nadia!.api.get<{ person: { id: string } }>('/api/session');
  const tree = await rafi!.api.ctx.get(`/api/people/${me.person.id}/files/tree`);
  expect([403, 404]).toContain(tree.status());
  // priya too
  expect([403, 404]).toContain((await priya!.api.ctx.get(`/api/files/${fileIds[0]}/content`)).status());
});
