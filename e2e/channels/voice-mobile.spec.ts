import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, noSidewaysScroll, type StackApi } from '../support/stack-browser.ts';
import { FAKE_TEXT, VOICE_STACK_ENV, bar, deleteButton, liveTracks, mic, openVoice, pauseButton, sendButton, startRecording, timerSeconds } from './voice-support.ts';

/**
 * Voice messages on a 390 x 844 phone (PLAN P14-17 "Phone 390 px", rewritten in P32-07), on a stack of its own with the server's stand-in speech model: the mic is a
 * 44 x 44 target, a long press records and the release sends (no preview), sliding left cancels, the bar and its buttons fit the width and are finger-sized, and the
 * message is flat (no card), fits the row and has the transcript under it. Run by the `voice-mobile` project (touch, 390 wide); the desktop project skips this file.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => !isMobile, 'the phone layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let dev = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...VOICE_STACK_ENV });
  omar = await apiOn(playwright, stack, 'omar');
  dev = (await channelsOf(omar))['dev']!;
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

const voiceMessages = async (): Promise<Array<{ meta: { voice?: { transcript: string } } }>> => (await omar.get<{ items: Array<{ meta: { voice?: { transcript: string } } }> }>(`/api/channels/${dev}/messages`)).items.filter((m) => m.meta.voice);

test('hold to record, release to send: no preview, the flat voice message fits the row with the transcript under it', async ({ browser, playwright }) => {
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
    await expect(page.getByTestId('voice-hint')).toHaveText('Slide left to cancel');
    await expect.poll(() => timerSeconds(page)).toBeGreaterThanOrEqual(1);
    expect(await noSidewaysScroll(page)).toBe(true);
    const held = (await bar(page).boundingBox())!;
    expect(held.x).toBeGreaterThanOrEqual(0);
    expect(held.x + held.width).toBeLessThanOrEqual(390);
    await page.mouse.up();
    // released: sent at once, no preview
    await expect(bar(page)).toBeHidden();
    await expect(page.getByTestId('voice-preview')).toHaveCount(0);
    const row = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('voice-words')).toHaveText(FAKE_TEXT);
    await expect(row.getByTestId('voice-transcript-heading')).toHaveCount(0);

    // the voice message is flat (P32-10): no card, inside the row and the screen, its left edge at the message text's; the play button is finger-sized
    const card = (await row.getByTestId('voice-message').boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    expect(card.x + card.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    const flat = await row.getByTestId('voice-message').evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, pad: s.paddingLeft, bg: s.backgroundColor };
    });
    expect(flat).toEqual({ border: '0px', radius: '0px', pad: '0px', bg: 'rgba(0, 0, 0, 0)' });
    const play = (await row.getByTestId('voice-play').boundingBox())!;
    expect(play.width).toBeGreaterThanOrEqual(44);
    expect(Math.abs(play.x - card.x)).toBeLessThanOrEqual(1);
    // the transcript sits under the player, at the same left edge
    const words = (await row.getByTestId('voice-words').boundingBox())!;
    const player = (await row.getByTestId('voice-player').boundingBox())!;
    expect(words.y).toBeGreaterThanOrEqual(player.y + player.height - 1);
    expect(Math.abs(words.x - player.x)).toBeLessThanOrEqual(1);
    // the length is there (it says whether it was played; no played dot); the sent time and a second picture are not
    await expect(row.getByTestId('voice-time')).toBeVisible();
    await expect(row.getByTestId('voice-sent')).toHaveCount(0);
    await expect(row.getByTestId('voice-played')).toHaveAccessibleName('Not played yet');
    await expect(row.locator('.vp-heard')).toHaveCount(0);
    await expect(row.getByTestId('voice-player').locator('.av')).toHaveCount(0);
    const speed = (await row.getByTestId('voice-speed').boundingBox())!;
    expect(speed.width).toBeGreaterThanOrEqual(44);
    expect(speed.height).toBeGreaterThanOrEqual(44);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expect.poll(() => liveTracks(page)).toBe(0);
    expect((await voiceMessages()).length).toBe(1);
  } finally {
    await context.close();
  }
});

test('a tap opens the bar: delete, pause and send are finger-sized and fit; pause then Send sends', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { mobile: true });
  try {
    await startRecording(page, 1);
    const shape = (await bar(page).boundingBox())!;
    expect(shape.x).toBeGreaterThanOrEqual(0);
    expect(shape.x + shape.width).toBeLessThanOrEqual(390);
    for (const [name, button] of [['delete', deleteButton(page)], ['pause', pauseButton(page)], ['send', sendButton(page)]] as const) {
      const b = (await button.boundingBox())!;
      expect(b.width, name).toBeGreaterThanOrEqual(40);
      expect(b.height, name).toBeGreaterThanOrEqual(40);
      expect(b.x + b.width, name).toBeLessThanOrEqual(390);
    }
    expect(await noSidewaysScroll(page)).toBe(true);
    await pauseButton(page).tap();
    await expect(bar(page)).toHaveAttribute('data-state', 'paused');
    expect(await noSidewaysScroll(page)).toBe(true);
    const before = (await voiceMessages()).length;
    await sendButton(page).tap();
    await expect(bar(page)).toBeHidden();
    await expect.poll(async () => (await voiceMessages()).length).toBe(before + 1);
    await expect.poll(() => liveTracks(page)).toBe(0);
  } finally {
    await context.close();
  }
});

test('sliding left while holding cancels on the phone too, with nothing sent', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { mobile: true });
  try {
    const before = (await voiceMessages()).length;
    const at = (await mic(page).boundingBox())!;
    const x = at.x + at.width / 2;
    const y = at.y + at.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(bar(page)).toBeVisible();
    await page.mouse.move(x - 150, y, { steps: 6 });
    await expect(page.getByTestId('voice-hint')).toHaveText('Release to cancel');
    await page.mouse.up();
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    expect((await voiceMessages()).length).toBe(before);
  } finally {
    await context.close();
  }
});
