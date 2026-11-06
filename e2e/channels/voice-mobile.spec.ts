import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, noSidewaysScroll, type StackApi } from '../support/stack-browser.ts';
import { FAKE_TEXT, liveTracks, mic, openVoice, preview, timerSeconds, transcriptBox } from './voice-support.ts';

/**
 * Voice messages on a 390 x 844 phone (PLAN P14-17 "Phone 390 px"), on a stack of its own: the mic is a 44 x 44 target, a long press records and
 * the release opens the preview, sliding left cancels, and the player is one row that fits the message with the words wrapping under it.
 * Run by the `voice-mobile` project (touch, 390 wide); the desktop project skips this file.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => !isMobile, 'the phone layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let dev = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  dev = (await channelsOf(omar))['dev']!;
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('hold to record, release to preview, player fits the row', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { mobile: true });
  try {
    await expect(mic(page)).toBeVisible();
    const at = (await mic(page).boundingBox())!;
    expect(at.width).toBeGreaterThanOrEqual(44);
    expect(at.height).toBeGreaterThanOrEqual(44);
    const x = at.x + at.width / 2;
    const y = at.y + at.height / 2;

    // a long press records for as long as the finger is down
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(page.getByTestId('voice-recording')).toContainText('Recording · slide left to cancel');
    await expect.poll(() => timerSeconds(page)).toBeGreaterThanOrEqual(1);
    expect(await noSidewaysScroll(page)).toBe(true);
    const bar = (await page.getByTestId('voice-recording').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390);
    await page.mouse.up();
    await expect(preview(page)).toBeVisible();
    await expect(transcriptBox(page)).toHaveValue(FAKE_TEXT);
    const pv = (await preview(page).boundingBox())!;
    expect(pv.x + pv.width).toBeLessThanOrEqual(390);
    expect(await noSidewaysScroll(page)).toBe(true);
    // every control in the preview is a comfortable target
    for (const id of ['voice-discard', 'voice-send']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.height, id).toBeGreaterThanOrEqual(32);
    }
    await page.getByTestId('voice-send').click();
    await expect(preview(page)).toBeHidden();

    // the player is one row inside the message, with the words wrapping under it
    const row = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
    await expect(row).toBeVisible();
    const player = (await row.getByTestId('voice-player').boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    expect(player.x + player.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(player.x + player.width).toBeLessThanOrEqual(390);
    const play = (await row.getByTestId('voice-play').boundingBox())!;
    expect(play.width).toBeGreaterThanOrEqual(32);
    const words = (await row.locator('.txt').boundingBox())!;
    expect(words.y).toBeGreaterThanOrEqual(player.y + player.height - 1);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expect.poll(() => liveTracks(page)).toBe(0);
    expect((await omar.get<{ items: Array<{ meta: { voice?: unknown } }> }>(`/api/channels/${dev}/messages`)).items.some((m) => m.meta.voice)).toBe(true);
  } finally {
    await context.close();
  }
});

test('sliding left while holding cancels on the phone too, with nothing sent', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { mobile: true });
  try {
    const before = (await omar.get<{ items: unknown[] }>(`/api/channels/${dev}/messages`)).items.length;
    const at = (await mic(page).boundingBox())!;
    const x = at.x + at.width / 2;
    const y = at.y + at.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(page.getByTestId('voice-recording')).toBeVisible();
    await page.mouse.move(x - 150, y, { steps: 6 });
    await expect(page.getByTestId('voice-recording')).toContainText('Release to cancel');
    await page.mouse.up();
    await expect(page.getByTestId('voice-recording')).toBeHidden();
    await expect(preview(page)).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    expect((await omar.get<{ items: unknown[] }>(`/api/channels/${dev}/messages`)).items.length).toBe(before);
  } finally {
    await context.close();
  }
});
