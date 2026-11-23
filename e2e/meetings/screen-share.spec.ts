import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { closePerson, enterRoom, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Camera and screen sharing in a call (PLAN P35-08), on the fake media server: Nadia turns her camera on (the stage shows her tile), shares her screen (the
 * stage shows it large, the button says how to stop), and the stage goes full size and back; Rafi's own share is refused while hers is on, with her name
 * (the other person's screen is played by the fake media layer for him). Stopping both empties the stage.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');
test.describe.configure({ mode: 'serial' });

const ROOM = 'share-room';

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: ROOM });
});
test.afterAll(async () => {
  await closePerson(nadia);
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
  await page.getByTestId('call-screen').click();
  await expect(page.getByTestId('call-notice')).toContainText('one screen is shared at a time');

  await page.evaluate(() => {
    const media = (window as unknown as { __manythreadsFakeMedia: { last(): { remoteVideo(a: string, s: string, on: boolean): void } } }).__manythreadsFakeMedia;
    media.last().remoteVideo('00000000-0000-4000-8000-00000000beef', 'screen', false);
  });
  await page.getByTestId('call-camera').click();
  await expect(page.getByTestId('call-stage')).toHaveCount(0);
});
