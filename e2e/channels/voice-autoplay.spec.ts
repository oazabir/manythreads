import { expect, test } from '@playwright/test';
import { personas } from '@manythreads/test-utils';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { VOICE_STACK_ENV, openVoice, uploadFile, voiceMeta } from './voice-support.ts';

/**
 * Voice autoplay (owner 2026-11-23): Omar has his direct-message conversation with Nadia open and turns on "Autoplay voice"; Nadia sends a voice message; it
 * plays by itself, in place (the page stays where it is), and the small player in the top right corner pauses and resumes it. A message in a channel does
 * not play by itself, and neither does the history. The `voice` project supplies Chromium's flags; the press on the switch is the page's first gesture.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...VOICE_STACK_ENV });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

const HELLO = Buffer.from(await (await import('node:fs/promises')).readFile(new URL('../fixtures/speech/hello.wav', import.meta.url)));

async function sendVoice(channel: string): Promise<string> {
  const f = await uploadFile(nadia, channel, HELLO, 'audio/wav', 'voice.wav');
  expect(f.status).toBe(201);
  const m = await nadia.post<{ id: string }>(`/api/channels/${channel}/messages`, { channelId: channel, body: 'Voice message', threadRootId: null, attachments: [f.file!.id], voice: voiceMeta(f.file!.id, { durationMs: 2000 }) });
  return m.id;
}

test('an incoming voice message in an open DM plays by itself, in place, and the corner player pauses and resumes it', async ({ browser, playwright }) => {
  const dm = await nadia.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [personas.omar.personId] });
  const channel = dm.dm.channel.id;
  // a voice message sent before Omar opens the conversation is history: it never plays by itself
  await sendVoice(channel);
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', `/t/engineering/dm/${channel}`);
  try {
    const box = page.getByTestId('voice-autoplay-box');
    await expect(box).toBeVisible();
    await box.check();
    const mini = page.getByTestId('voice-autoplay-mini');
    await page.waitForTimeout(1500);
    await expect(mini).toHaveCount(0);
    const before = page.url();

    await sendVoice(channel);
    await expect(mini).toBeVisible({ timeout: 15_000 });
    await expect(mini).toContainText('Nadia');
    await expect(mini).toHaveAttribute('data-state', 'playing');
    await page.getByTestId('voice-autoplay-toggle').click();
    await expect(mini).toHaveAttribute('data-state', 'paused');
    await page.getByTestId('voice-autoplay-toggle').click();
    await expect(mini).toHaveAttribute('data-state', 'playing');
    // the reader stays where they are
    expect(page.url()).toBe(before);
    // the clip ends (2 s): the corner player goes
    await expect(mini).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test('a voice message in a channel does not play by itself, and the switch is not in a channel header', async ({ browser, playwright }) => {
  const channels = await omar.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels');
  const dev = channels.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'dev')!.id;
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await expect(page.getByRole('textbox', { name: 'Message #dev' })).toBeVisible();
    await expect(page.getByTestId('voice-autoplay-switch')).toHaveCount(0);
    await sendVoice(dev);
    await page.waitForTimeout(3000);
    await expect(page.getByTestId('voice-autoplay-mini')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
