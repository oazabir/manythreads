import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { answerConsent, closePerson, endForEveryone, enterRoom, finishNotes, installBots, lastMeeting, leave, meetingsStack, openAs, repoText, say, turnOnTranscription, type Person } from './support.ts';

/**
 * From the call to team memory and the board (PLAN P15-17). A stand-up in #dev: when the notes are written the platform drops them into the team inbox
 * (origin `meeting`) and the Archivist files a `Meeting` concept, naming the people who said yes. An action item becomes a card with "Add to board", with its
 * owner and day in it. A second room, in #releases with Lena (a guest of the workspace) in it, is held for a lead instead of being filed.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let lena: Person | undefined;
let meetingId = '';
let notes: Awaited<ReturnType<typeof finishNotes>>;

const itemOf = async (id: string) => (await stack.sql<{ state: string; origin: string; hold_reason: string | null; filed_paths: string[]; name: string }>('SELECT state, origin, hold_reason, filed_paths, name FROM app.memory_inbox_items WHERE id = $1', [id]))[0]!;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await installBots(stack, omar);
  await omar.post('/api/teams/engineering/boards', { name: 'Team board' });
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await closePerson(lena);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('a stand-up in #dev is filed into team memory as a Meeting concept', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await enterRoom(nadia);
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  meetingId = (await lastMeeting(stack, 'dev')).id;
  rafi = await openAs(browser, playwright, stack, 'rafi');
  await enterRoom(rafi);
  await answerConsent(rafi, 'yes');
  await say(nadia, 'We decided to move the release to Thursday.');
  await say(rafi, 'I will update the runbook by 2026-11-14.');
  await say(nadia, 'I will write the rollback note by 2026-11-12.');
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND final AND text <> ''`, [meetingId])).length).toBe(3);
  await leave(rafi);
  await endForEveryone(nadia);

  notes = await finishNotes(stack, meetingId);
  expect(notes.status).toBe('written');
  expect(notes.memory_item_id).not.toBeNull();
  await expect.poll(async () => (await itemOf(notes.memory_item_id!)).state, { timeout: 90_000, message: 'the Archivist to file the meeting' }).toBe('filed');
  const item = await itemOf(notes.memory_item_id!);
  expect(item.origin).toBe('meeting');
  expect(item.filed_paths.length).toBeGreaterThan(0);

  const concept = item.filed_paths.find((p) => p.startsWith('memory/meetings/'));
  expect(concept, `a Meeting concept among ${JSON.stringify(item.filed_paths)}`).toBeDefined();
  const text = await repoText(omar, 'engineering', concept!);
  expect(text).toMatch(/type:\s*Meeting/);
  expect(text).toContain('Voice room');
  // the item it was filed from names the meeting and the people who said yes
  const reference = item.filed_paths.find((p) => p.startsWith('memory/references/'));
  expect(reference).toBeDefined();
  const source = await repoText(omar, 'engineering', reference!);
  expect(source).toContain('We decided to move the release to Thursday.');
  expect(source).toContain('Nadia');
  expect(source).toContain('Rafi');
});

test('Add to board makes a card with the owner and the day in it', async () => {
  const a = nadia!;
  await a.page.goto(`/meetings/${meetingId}`);
  const rows = a.page.getByTestId('action-item');
  await expect(rows).toHaveCount(2);
  const mine = rows.filter({ hasText: 'rollback note' });
  await expect(mine.getByTestId('action-owner')).toContainText('Nadia');
  await mine.getByTestId('action-to-board').click();
  await mine.getByTestId('note-board-add').click();
  await expect(mine.getByTestId('action-added')).toContainText('Added to Team board');

  const [card] = await stack.sql<{ title: string; description: string }>(`SELECT title, description FROM app.tasks WHERE title LIKE '%rollback note%'`);
  expect(card?.title).toBe('I will write the rollback note by 2026-11-12.');
  expect(card?.description).toContain('Owner: Nadia');
  expect(card?.description).toContain('Due: 2026-11-12');
  expect(card?.description).toContain('Voice room');

  // and the board shows it
  await a.page.goto('/t/engineering/boards');
  await expect(a.page.getByText('I will write the rollback note by 2026-11-12.').first()).toBeVisible();
});

test('a room with a guest in it is held for a lead and not filed by itself', async ({ browser, playwright }) => {
  await closePerson(nadia);
  await closePerson(rafi);
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/releases');
  await enterRoom(nadia);
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  const room = await lastMeeting(stack, 'releases');
  lena = await openAs(browser, playwright, stack, 'lena', '/t/engineering/c/releases');
  await enterRoom(lena);
  await answerConsent(lena, 'yes');
  await say(nadia, 'We decided the next release is Friday.');
  await say(lena, 'That works for the customer.');
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND final AND text <> ''`, [room.id])).length).toBe(2);
  await leave(lena);
  await endForEveryone(nadia);

  const guestNotes = await finishNotes(stack, room.id);
  expect(guestNotes.status).toBe('written');
  expect(guestNotes.memory_item_id).not.toBeNull();
  await expect.poll(async () => (await itemOf(guestNotes.memory_item_id!)).state, { timeout: 30_000 }).toBe('held');
  const held = await itemOf(guestNotes.memory_item_id!);
  expect(held.filed_paths).toEqual([]);
  expect(held.hold_reason).not.toBeNull();
  // nothing of the guest room is in memory
  expect(JSON.stringify(await stack.sql(`SELECT filed_paths FROM app.memory_inbox_items WHERE id = $1`, [guestNotes.memory_item_id]))).not.toContain('memory/');
});
