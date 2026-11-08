import { expect, test } from '@playwright/test';
import { addBot, brainMd } from '../conversations/support.ts';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, closePerson, mediaState, endForEveryone, enterRoom, leave, lastMeeting, meetingsStack, openAs, type Person } from './support.ts';

/**
 * The room's thread, beside the call (PLAN P15-17, §3 criterion 18). Joining opens the call's thread in the right panel; Nadia and Rafi write to each other in it,
 * Rafi shares a file Nadia opens, and a bot mentioned there answers in the thread. The unread count on Chat follows whether the thread is on screen. No bot
 * has a track in the room (the media server's record of the room is read back: no bot token, nothing published). After the call the thread stays, and the
 * meeting page links to it.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let meetingId = '';
let rootId = '';

const panelOf = (p: Person) => p.page.locator('[data-landmark="right-panel"]');
const threadOf = (p: Person) => panelOf(p).getByTestId('thread-view');
const replyBox = (p: Person) => panelOf(p).getByRole('textbox', { name: 'Reply in thread' });

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await addBot(stack, omar, 'helper', brainMd(['hello']));
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('joining opens the call thread in the right panel; Nadia and Rafi write in it', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await enterRoom(nadia);
  const room = await lastMeeting(stack, 'dev');
  meetingId = room.id;
  rootId = room.thread_root_id!;
  await expect(threadOf(nadia)).toBeVisible();
  await expect(threadOf(nadia)).toHaveAttribute('data-root-id', rootId);

  rafi = await openAs(browser, playwright, stack, 'rafi');
  await enterRoom(rafi);
  await expect(threadOf(rafi)).toHaveAttribute('data-root-id', rootId);

  await replyBox(nadia).fill('Can everyone see the build link?');
  await nadia.page.keyboard.press('Enter');
  await expect(threadOf(rafi)).toContainText('Can everyone see the build link?');
  await replyBox(rafi).fill('Yes, I can see it.');
  await rafi.page.keyboard.press('Enter');
  await expect(threadOf(nadia)).toContainText('Yes, I can see it.');
});

test('the Chat count follows whether the thread is on screen', async () => {
  const [a, b] = [nadia!, rafi!];
  await panelOf(b).getByRole('button', { name: 'Close panel' }).click();
  await expect(panelOf(b)).toBeHidden();
  await expect(b.page.getByTestId('call-chat-unread')).toHaveCount(0);
  await replyBox(a).fill('One more thing: the deploy is at noon.');
  await a.page.keyboard.press('Enter');
  await expect(b.page.getByTestId('call-chat-unread')).toHaveText('1');
  await replyBox(a).fill('And the freeze starts at eleven.');
  await a.page.keyboard.press('Enter');
  await expect(b.page.getByTestId('call-chat-unread')).toHaveText('2');
  // opening Chat shows the thread and clears the count
  await b.page.getByTestId('call-chat').click();
  await expect(threadOf(b)).toContainText('And the freeze starts at eleven.');
  await expect(b.page.getByTestId('call-chat-unread')).toHaveCount(0);
});

test('Rafi shares a file in the thread and Nadia opens it', async () => {
  const [a, b] = [nadia!, rafi!];
  await panelOf(b).locator('input[type=file]').setInputFiles({ name: 'release-checklist.md', mimeType: 'text/markdown', buffer: Buffer.from('# Release checklist\n\n- tag the build\n- tell support\n') });
  await expect(panelOf(b).getByTestId('upload')).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await replyBox(b).fill('The checklist is attached.');
  await b.page.keyboard.press('Enter');
  await expect(threadOf(a)).toContainText('release-checklist.md', { timeout: 15_000 });
  // the card is a download of the same bytes, for Nadia as for Rafi
  const card = threadOf(a).getByTestId('attachment').filter({ hasText: 'release-checklist.md' });
  const res = await a.page.request.get((await card.getAttribute('href')) ?? '');
  expect(res.status()).toBe(200);
  expect((await res.text()).trim()).toBe('# Release checklist\n\n- tag the build\n- tell support');
});

test('a bot mentioned in the thread answers in the thread', async () => {
  const a = nadia!;
  // the thread is on top again for Nadia
  if ((await threadOf(a).count()) === 0) await a.page.getByTestId('call-chat').click();
  await expect(threadOf(a)).toBeVisible();
  await replyBox(a).fill('@helper ECHO-ME is the build green?');
  await a.page.keyboard.press('Enter');
  const answer = threadOf(a).getByTestId('message').filter({ hasText: 'Answering:' });
  await expect(answer).toHaveCount(1, { timeout: 90_000 });
  await expect(answer).toContainText('is the build green?');
  // it answered in the call's thread, as the bot
  const rows = await stack.sql<{ kind: string; body: string }>(
    `SELECT a.kind, m.body FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE m.thread_root_id = $1 AND m.body LIKE 'Answering:%'`,
    [rootId],
  );
  expect(rows.map((r) => r.kind)).toEqual(['bot']);
});

test('the room has no bot track: no bot token, nothing published', async () => {
  const state = await mediaState(stack, omar, meetingId);
  expect(state.tokens.map((t) => t.identity).sort()).toEqual([actorOf('nadia'), actorOf('rafi')].sort());
  expect(state.tokens.filter((t) => t.kind === 'bot')).toEqual([]);
  expect(state.published).toEqual([]);
  expect(state.listeners).toEqual([]);
});

test('after the call the thread stays and the meeting page links to it', async () => {
  const [a, b] = [nadia!, rafi!];
  await leave(b);
  await endForEveryone(a);
  await a.page.goto(`/meetings/${meetingId}`);
  await a.page.getByTestId('meeting-thread').click();
  await expect(threadOf(a)).toBeVisible();
  await expect(threadOf(a)).toHaveAttribute('data-root-id', rootId);
  await expect(threadOf(a)).toContainText('Can everyone see the build link?');
  await expect(threadOf(a)).toContainText('release-checklist.md');
  await expect(threadOf(a)).toContainText('Answering:');
});
