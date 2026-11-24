import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, closePerson, enterRoom, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Camera and screen sharing in a call (PLAN P35-08), on the fake media server: Nadia turns her camera on (the stage shows her tile), shares her screen (the
 * stage shows it large, the button says how to stop), and the stage goes full size and back; while someone else shares, her button asks them for a turn instead
 * of sharing (the other person's screen is played by the fake media layer). Stopping both empties the stage.
 *
 * "Ask to share" (PLAN P17-02) between two browsers: Rafi joins while Nadia shares, his button reads "Ask to share"; she gets his request through the server and
 * answers "Not now" (he is told), then, asked again, "Stop and let Rafi share": her screen stops, he is told he may share now and shares with his own press. (Each
 * browser has its own fake media layer, so his page is told by hand that her screen came and went; the request and the answers go through the real server.)
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');
test.describe.configure({ mode: 'serial' });

const ROOM = 'share-room';

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let rafi: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: ROOM });
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('a camera and a shared screen show on the stage, full size and back; one sharer at a time', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${ROOM}`);
  await enterRoom(nadia);
  const page = nadia.page;
  await expect(page.getByTestId('call-stage')).toHaveCount(0);

  await page.getByTestId('call-camera').click();
  await expect(page.getByTestId('call-camera')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('stage-tile')).toHaveCount(1);
  await expect(page.getByTestId('stage-tile').first()).toHaveAttribute('data-source', 'camera');

  await page.getByTestId('call-screen').click();
  await expect(page.getByTestId('call-screen')).toHaveAttribute('aria-label', 'Stop sharing your screen');
  await expect(page.locator('[data-testid="stage-tile"][data-source="screen"]')).toHaveCount(1);
  await expect(page.getByTestId('call-stage')).toContainText('You are sharing a screen');

  await page.getByTestId('stage-full').click();
  await expect(page.getByTestId('call-stage')).toHaveClass(/full/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('call-stage')).not.toHaveClass(/full/);

  // someone else is sharing: the fake media layer plays Rafi's screen in Nadia's room, and her own share is refused while it is on
  await page.getByTestId('call-screen').click();
  await expect(page.locator('[data-testid="stage-tile"][data-source="screen"]')).toHaveCount(0);
  await page.evaluate(() => {
    const media = (window as unknown as { __manythreadsFakeMedia: { last(): { remoteVideo(a: string, s: string, on: boolean): void } } }).__manythreadsFakeMedia;
    media.last().remoteVideo('00000000-0000-4000-8000-00000000beef', 'screen', true);
  });
  await expect(page.getByTestId('call-screen')).toHaveAttribute('aria-label', /is sharing their screen/);
  // the button asks them for a turn instead (P17-02); this stand-in sharer is not in the call, so the server refuses the request
  await expect(page.getByTestId('call-screen')).toHaveAttribute('data-action', 'ask');
  await expect(page.getByTestId('call-screen')).toHaveText('Ask to share');
  await page.getByTestId('call-screen').click();
  await expect(page.getByTestId('call-notice')).toContainText('not in the call');
  await expect(page.getByTestId('call-share-ask')).toHaveCount(0);

  await page.evaluate(() => {
    const media = (window as unknown as { __manythreadsFakeMedia: { last(): { remoteVideo(a: string, s: string, on: boolean): void } } }).__manythreadsFakeMedia;
    media.last().remoteVideo('00000000-0000-4000-8000-00000000beef', 'screen', false);
  });
  await page.getByTestId('call-camera').click();
  await expect(page.getByTestId('call-stage')).toHaveCount(0);
});

/** Tells this page's fake media layer that `actorId`'s screen came (true) or went (false). */
const remoteScreen = (p: Person, actorId: string, on: boolean) =>
  p.page.evaluate(
    ([a, o]) => {
      const media = (window as unknown as { __manythreadsFakeMedia: { last(): { remoteVideo(a: string, s: string, on: boolean): void } } }).__manythreadsFakeMedia;
      media.last().remoteVideo(a, 'screen', o);
    },
    [actorId, on] as const,
  );

test('ask to share: Rafi asks Nadia for a turn; "Not now" is said, then yes stops her screen and he shares', async ({ browser, playwright }) => {
  const n = nadia!.page;
  rafi = await openAs(browser, playwright, stack, 'rafi', `/t/engineering/c/${ROOM}`);
  await enterRoom(rafi);
  const r = rafi.page;
  await expect(n.getByTestId('call-face')).toHaveCount(2);

  await n.getByTestId('call-screen').click();
  await expect(n.getByTestId('call-screen')).toHaveAttribute('aria-label', 'Stop sharing your screen');
  await remoteScreen(rafi, actorOf('nadia'), true);
  await expect(r.getByTestId('call-screen')).toHaveAttribute('data-action', 'ask');
  await expect(r.getByTestId('call-screen')).toHaveText('Ask to share');

  // the first request: Nadia says not now, and Rafi is told
  await r.getByTestId('call-screen').click();
  await expect(r.getByTestId('call-share-ask')).toHaveAttribute('data-state', 'asking');
  await expect(r.getByTestId('call-screen')).toBeDisabled();
  await expect(n.getByTestId('call-share-asked')).toContainText('Rafi');
  await expect(n.getByTestId('call-share-asked')).toContainText('asks to share their screen');
  await n.getByTestId('call-share-asked-no').click();
  await expect(n.getByTestId('call-share-asked')).toHaveCount(0);
  await expect(n.getByTestId('call-screen')).toHaveAttribute('aria-label', 'Stop sharing your screen');
  await expect(r.getByTestId('call-share-ask')).toHaveAttribute('data-state', 'declined');
  await expect(r.getByTestId('call-share-ask')).toContainText('said not now');
  await r.getByTestId('call-share-ask-close').click();
  await expect(r.getByTestId('call-share-ask')).toHaveCount(0);

  // the same person may be asked again a minute after the last request: the spec moves that request a minute back instead of waiting
  await stack.sql(`UPDATE app.meeting_share_requests SET asked_at = now() - interval '61 seconds' WHERE asker_id = $1`, [actorOf('rafi')]);
  // asked again: the server takes her yes first, then her screen stops, and he may share now (his own press shares it)
  await r.getByTestId('call-screen').click();
  await expect(n.getByTestId('call-share-asked-yes')).toContainText('Stop and let Rafi');
  await n.getByTestId('call-share-asked-yes').click();
  await expect(n.getByTestId('call-screen')).toHaveAttribute('aria-label', 'Share your screen');
  await expect(r.getByTestId('call-share-ask')).toHaveAttribute('data-state', 'may-share');
  // until his page sees her screen go, Share waits
  await expect(r.getByTestId('call-share-ask-share')).toBeDisabled();
  await remoteScreen(rafi, actorOf('nadia'), false);
  await expect(r.getByTestId('call-share-ask')).toContainText('You can share now');
  await r.getByTestId('call-share-ask-share').click();
  await expect(r.getByTestId('call-screen')).toHaveAttribute('aria-label', 'Stop sharing your screen');
  await expect(r.getByTestId('call-share-ask')).toHaveCount(0);

  // both answers are in the event log (and so the audit log), ids only; a request is recorded when it is answered
  const rows = await stack.sql<{ answer: string }>(
    `SELECT payload->>'answer' AS answer FROM app.events WHERE type = 'meetings.share_request.answered' AND payload->>'askedBy' = $1 ORDER BY id`,
    [actorOf('rafi')],
  );
  expect(rows).toEqual([{ answer: 'decline' }, { answer: 'accept' }]);
  await r.getByTestId('call-screen').click();
});
