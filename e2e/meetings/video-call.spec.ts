import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { closePerson, dock, meetingsStack, openAs, type Person } from './support.ts';

/**
 * A video call (PLAN P36-02), on the fake media server: Nadia presses Video call in a channel's header, the dialog says it is a video call, she starts it and is
 * in it with her camera on (her tile on the stage), the call is stored as video; while it is live the header offers only Join, so the channel keeps one call.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');
test.describe.configure({ mode: 'serial' });

const ROOM = 'video-room';

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  await omar.post('/api/teams/engineering/channels', { name: ROOM });
});
test.afterAll(async () => {
  await closePerson(nadia);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Video call starts a video call with the camera on; while it is live the header offers only Join', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${ROOM}`);
  const page = nadia.page;
  await page.getByTestId('call-start-video').click();
  await expect(page.getByTestId('call-start-dialog')).toContainText('Start a video call');
  await page.getByTestId('call-start-submit').click();
  await expect(dock(nadia)).toBeVisible();
  await expect(dock(nadia)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  await expect(page.locator('[data-testid="stage-tile"][data-source="camera"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('call-camera')).toHaveAttribute('aria-pressed', 'true');
  const kind = await stack.sql<{ kind: string }>(`SELECT m.kind FROM app.meetings m JOIN app.channels c ON c.id = m.channel_id WHERE c.name = $1 ORDER BY m.started_at DESC LIMIT 1`, [ROOM]);
  expect(kind[0]?.kind).toBe('video');
  // a call is live here: no second start of either kind is offered
  await expect(page.getByTestId('call-start-video')).toHaveCount(0);
});
