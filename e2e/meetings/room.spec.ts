import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, closePerson, dock, enterRoom, lastMeeting, leave, mediaState, meetingsStack, openAs, showSpeaking, turnOnTranscription, answerConsent, say, type Person } from './support.ts';

/**
 * The voice room (PLAN P15-17, e2e/meetings, §3 criterion 1). Nadia starts a room in #dev and Rafi joins it from his own browser. Both call bars show
 * both faces, and a speaker the media server reports gets the speaking ring on every page. The transcription is on-device here (the room's default
 * mode), so whatever is said goes through the page's own engine: not a single `audio-chunks` request leaves either page, and the words still arrive as
 * lines of the room.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;
let omarPage: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await closePerson(omarPage);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Nadia starts a call from the dialog inviting Rafi, Rafi joins, both call bars show both people', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await expect(nadia.page.getByTestId('call-start')).toHaveAccessibleName('Audio call');
  // "Audio call" opens the start dialog (P15-25): the title filled in, Nadia ticked and locked, Start call
  await enterRoom(nadia, { invite: ['Rafi'] });
  await expect(nadia.page.getByTestId('call-face')).toHaveCount(1);

  rafi = await openAs(browser, playwright, stack, 'rafi');
  // the room is live for Rafi: the icon says so (with a green dot), and the call card drawn in place of its start message has Join call, Live and who started it
  await expect(rafi.page.getByTestId('call-start')).toHaveAccessibleName('Join call');
  await expect(rafi.page.getByTestId('room-card')).toBeVisible();
  await expect(rafi.page.getByTestId('room-card-join')).toHaveText('Join call');
  await expect(rafi.page.getByTestId('room-card-live')).toHaveText(/^Live \d+:\d{2}/);
  await expect(rafi.page.getByTestId('room-card-by')).toContainText('Started by Nadia');
  await expect(rafi.page.getByTestId('room-card-end')).toHaveCount(0);
  // the people asked as the call started are named on the card (P15-27)
  await expect(rafi.page.getByTestId('room-card-invited')).toContainText('Rafi');
  await enterRoom(rafi);

  for (const p of [nadia, rafi]) {
    await expect(p.page.getByTestId('call-face')).toHaveCount(2);
    await expect(p.page.getByTestId('call-roster')).toContainText('You');
  }
  await expect(nadia.page.getByTestId('call-roster')).toContainText('Rafi');
  await expect(rafi.page.getByTestId('call-roster')).toContainText('Nadia');
});

test('both may speak and hear (P36-01): each one\'s media token publishes and subscribes', async () => {
  const meeting = await lastMeeting(stack, 'dev');
  const state = await mediaState(stack, omar, meeting.id);
  for (const who of ['nadia', 'rafi'] as const) {
    const tokens = state.tokens.filter((t) => t.identity === actorOf(who));
    expect(tokens.length, who).toBeGreaterThan(0);
    expect(tokens.every((t) => t.kind === 'person' && t.canPublish && t.canSubscribe && !t.listenOnly), who).toBe(true);
  }
});

test('one call per channel (P36-01): Omar presses the call button while it is live and joins the same call, not a new one', async ({ browser, playwright }) => {
  const before = await lastMeeting(stack, 'dev');
  omarPage = await openAs(browser, playwright, stack, 'omar');
  await expect(omarPage.page.getByTestId('call-start')).toHaveAccessibleName('Join call');
  await enterRoom(omarPage);
  for (const p of [nadia!, rafi!, omarPage]) await expect(p.page.getByTestId('call-face')).toHaveCount(3);
  expect((await lastMeeting(stack, 'dev')).id).toBe(before.id);
  const live = await stack.sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.meetings m JOIN app.channels c ON c.id = m.channel_id WHERE c.name = 'dev' AND m.state <> 'ended'`,
  );
  expect(live[0]!.n).toBe('1');
  await leave(omarPage);
  for (const p of [nadia!, rafi!]) await expect(p.page.getByTestId('call-face')).toHaveCount(2);
});

test('the speaking ring follows who the media server reports, on both pages', async () => {
  const [a, b] = [nadia!, rafi!];
  await showSpeaking(a, [actorOf('rafi')]);
  await showSpeaking(b, [actorOf('rafi')]);
  for (const p of [a, b]) {
    await expect(p.page.locator('[data-testid="call-face"][data-speaking="true"]')).toHaveCount(1);
  }
  await expect(a.page.locator('[data-testid="call-face"][data-speaking="true"]')).toContainText('Rafi');
  await expect(b.page.locator('[data-testid="call-face"][data-speaking="true"]')).toContainText('You');

  await showSpeaking(a, [actorOf('nadia'), actorOf('rafi')]);
  await expect(a.page.locator('[data-testid="call-face"][data-speaking="true"]')).toHaveCount(2);

  await showSpeaking(a, []);
  await showSpeaking(b, []);
  for (const p of [a, b]) await expect(p.page.locator('[data-testid="call-face"][data-speaking="true"]')).toHaveCount(0);
});

test('with on-device transcription nothing is sent to the audio route, yet the words reach the room', async () => {
  const [a, b] = [nadia!, rafi!];
  await turnOnTranscription(a);
  // everybody in the room is asked, with the name of the person who turned it on
  for (const p of [a, b]) await expect(p.page.getByTestId('call-consent')).toContainText('Nadia turned on transcription');
  await answerConsent(a, 'yes');
  await answerConsent(b, 'yes');

  await say(a, 'Good morning everybody.');
  await say(b, 'Morning Nadia, the build is green.');

  await expect
    .poll(async () => (await stack.sql<{ text: string }>(`SELECT text FROM app.meeting_segments WHERE final ORDER BY start_ms`)).map((r) => r.text), { timeout: 20_000 })
    .toEqual(['Good morning everybody.', 'Morning Nadia, the build is green.']);

  // PLAN §3 criterion 1: no audio left a device while the on-device engine was on
  for (const p of [a, b]) expect(p.requests.filter((r) => r.includes('audio-chunks')), `${p.key} requests`).toEqual([]);
  // and the words did go to the line route
  expect(a.requests.some((r) => /POST \/api\/meetings\/[^/]+\/segments/.test(r))).toBe(true);
});

test('Rafi leaves, then Nadia ends the room for everyone', async () => {
  const [a, b] = [nadia!, rafi!];
  await leave(b);
  await expect(a.page.getByTestId('call-face')).toHaveCount(1);
  await expect(a.page.getByTestId('call-start')).toHaveCount(0);
  await a.page.getByTestId('call-settings-btn').click();
  await a.page.getByTestId('call-end-all').click();
  await a.page.getByTestId('call-end-confirm-yes').click();
  await expect(dock(a)).toBeHidden();
  await expect.poll(async () => (await stack.sql<{ state: string }>(`SELECT state FROM app.meetings ORDER BY started_at DESC LIMIT 1`))[0]?.state).toBe('ended');
  // nobody is in a live room any more: the channel offers a new one
  await expect(a.page.getByTestId('call-start')).toHaveAccessibleName('Audio call');
  await expect(a.page.getByTestId('room-card')).toHaveCount(0);
  // the start message is now one muted event line: who started it, how long, how many joined (P34-02)
  const line = a.page.locator('[data-testid="call-event"][data-state="ended"]').last();
  await expect(line).toBeVisible();
  // Nadia, Rafi and Omar (who joined the live call instead of starting another) joined
  await expect(line).toContainText(/Nadia started a call · \d{2}:\d{2} · .+ · 3 joined/);
});
