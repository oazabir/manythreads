import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, closePerson, dock, enterRoom, leave, meetingsStack, openAs, showSpeaking, turnOnTranscription, answerConsent, say, type Person } from './support.ts';

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

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Nadia starts a room, Rafi joins, both call bars show both people', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia');
  await expect(nadia.page.getByTestId('call-start')).toContainText('Start voice room');
  await enterRoom(nadia);
  await expect(nadia.page.getByTestId('call-face')).toHaveCount(1);

  rafi = await openAs(browser, playwright, stack, 'rafi');
  // the room is live for Rafi: the button says so, and the channel shows who is in it
  await expect(rafi.page.getByTestId('call-start')).toContainText('Join voice room');
  await enterRoom(rafi);

  for (const p of [nadia, rafi]) {
    await expect(p.page.getByTestId('call-face')).toHaveCount(2);
    await expect(p.page.getByTestId('call-roster')).toContainText('You');
  }
  await expect(nadia.page.getByTestId('call-roster')).toContainText('Rafi');
  await expect(rafi.page.getByTestId('call-roster')).toContainText('Nadia');
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
  await expect(dock(a)).toBeHidden();
  await expect.poll(async () => (await stack.sql<{ state: string }>(`SELECT state FROM app.meetings ORDER BY started_at DESC LIMIT 1`))[0]?.state).toBe('ended');
  // nobody is in a live room any more: the channel offers a new one
  await expect(a.page.getByTestId('call-start')).toContainText('Start voice room');
});
