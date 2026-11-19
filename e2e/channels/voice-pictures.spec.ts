import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn } from '../support/stack-browser.ts';
import { VOICE_STACK_ENV, bar, holdTranscriptPushes, openVoice, pauseButton, recordClip, sendButton, startRecording } from './voice-support.ts';

/**
 * The pictures of P32-08: the recording bar (recording, paused) and the voice message (sending, "Writing the transcript…", with its transcript, and a failed
 * transcript with Try again), in Graphite dark and Linen light, at 1440 and 390 px. This is a tool, not a check: it is skipped unless MANYTHREADS_VOICE_PICTURES=1, and it
 * writes the PNGs to MANYTHREADS_VOICE_PICTURES_DIR (default temp/screenshots/p32-flat in the repository). Run it with
 * `MANYTHREADS_VOICE_PICTURES=1 pnpm e2e --project=voice channels/voice-pictures.spec.ts` (and `--project=voice-mobile` for the 390 px ones: the phone project owns
 * only voice-mobile.spec.ts, so the 390 px pictures are taken here by a desktop browser with a phone viewport).
 */
test.skip(!process.env['MANYTHREADS_VOICE_PICTURES'], 'a picture tool, run on purpose');
test.skip(({ isMobile }) => isMobile, 'takes its own sizes');
test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 10_000 });

const OUT = process.env['MANYTHREADS_VOICE_PICTURES_DIR'] ?? fileURLToPath(new URL('../../temp/screenshots/p32-flat/', import.meta.url));
const LOOKS = [
  { name: 'graphite-dark', theme: 'dark', palette: 'graphite' },
  { name: 'linen-light', theme: 'light', palette: 'linen' },
] as const;
const SIZES = [
  { name: '1440', mobile: false },
  { name: '390', mobile: true },
] as const;

let stack: Stack;
test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
// a fresh stack for each picture set, so one set never shows the rows of another
test.beforeEach(async () => {
  stack = await startStack({ ...VOICE_STACK_ENV });
});
test.afterEach(async () => {
  await stack?.stop();
});

for (const look of LOOKS) {
  for (const size of SIZES) {
    test(`${look.name} at ${size.name}`, async ({ browser, playwright }) => {
      const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { mobile: size.mobile, look: { theme: look.theme, palette: look.palette }, reducedMotion: false });
      const shot = (what: string) => page.screenshot({ path: `${OUT}${look.name}-${size.name}-${what}.png` });
      try {
        await expect(page.getByRole('textbox', { name: 'Message #dev' })).toBeVisible();
        const pushes = await holdTranscriptPushes(page);
        await expect(page.getByRole('textbox', { name: 'Message #dev' })).toBeVisible();
        let open: () => void = () => undefined;
        const gate = new Promise<void>((res) => (open = res));
        await page.route(/\/api\/channels\/[^/]+\/files$/, async (route) => {
          await gate;
          await route.continue();
        });

        await startRecording(page, 4);
        await shot('bar-recording');
        await pauseButton(page).click();
        await expect(bar(page)).toHaveAttribute('data-state', 'paused');
        await shot('bar-paused');

        await sendButton(page).click();
        await expect(page.getByTestId('pending-message')).toBeVisible();
        await shot('message-sending');
        open();
        const row = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
        await expect(row.getByTestId('voice-writing')).toBeVisible();
        await row.scrollIntoViewIfNeeded();
        await shot('message-pending');
        pushes.release();
        await expect(row.getByTestId('voice-words')).toBeVisible();
        await shot('message-transcript');

        // a failed transcript: the state the server writes when the model is busy three times
        // (the guard on messages lets only the system role change `meta`: the owner steps into it for this one statement, as the job does)
        await stack.sql(
          `SET ROLE manythreads_system;
           UPDATE app.messages SET body = 'Voice message (0:04)', body_plain = 'Voice message (0:04)',
                  meta = jsonb_set(meta, '{voice}', (meta->'voice') - 'transcriptEndMs' || '{"transcript":"failed","transcriptNote":"The speech model did not answer. You can ask again.","transcriptRetry":true}'::jsonb)
            WHERE meta ? 'voice' AND id = (SELECT id FROM app.messages WHERE meta ? 'voice' ORDER BY created_at DESC, id DESC LIMIT 1)`,
        );
        await page.reload();
        const failed = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
        await expect(failed.getByTestId('voice-try-again')).toBeVisible();
        await failed.scrollIntoViewIfNeeded();
        await shot('message-failed');
      } finally {
        await context.close();
      }
    });

    // P32-10: voice messages are flat. Three in a row from one person, one between text messages, the pending and failed lines, played and not played.
    test(`flat run, ${look.name} at ${size.name}`, async ({ browser, playwright }) => {
      const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { mobile: size.mobile, look: { theme: look.theme, palette: look.palette }, reducedMotion: false });
      const shot = (what: string) => page.screenshot({ path: `${OUT}${look.name}-${size.name}-${what}.png` });
      const nadia = await apiOn(playwright, stack, 'nadia');
      const omar = await apiOn(playwright, stack, 'omar');
      const dev = (await channelsOf(omar))['dev']!;
      const say = (api: typeof omar, body: string) => api.post(`/api/channels/${dev}/messages`, { channelId: dev, body, threadRootId: null, attachments: [] });
      const voiceRows = () => messagesIn(page).filter({ has: page.getByTestId('voice-player') });
      const toBottom = () => messagesIn(page).last().evaluate((el) => el.scrollIntoView({ block: 'end' }));
      try {
        await expect(page.getByRole('textbox', { name: 'Message #dev' })).toBeVisible();
        const pushes = await holdTranscriptPushes(page);
        await expect(page.getByRole('textbox', { name: 'Message #dev' })).toBeVisible();
        await say(nadia, 'Did the release go out this morning?');
        await expect(messagesIn(page).filter({ hasText: 'Did the release go out this morning?' })).toBeVisible();

        // three voice messages in a row from one person, the words not yet written
        for (let i = 0; i < 3; i += 1) await recordClip(page, 3);
        await expect(page.getByTestId('voice-writing')).toHaveCount(3);
        await toBottom();
        await shot('run-pending');

        pushes.release();
        await expect(page.getByTestId('voice-words')).toHaveCount(3);
        await expect(page.getByTestId('voice-writing')).toHaveCount(0);
        await toBottom();
        await shot('run-of-three');

        // a voice message between text messages
        await say(nadia, 'Thanks. Can you say what changed?');
        await say(omar, 'Sure, a short note.');
        await say(omar, 'The flag is gone now.');
        await recordClip(page, 3);
        await expect(page.getByTestId('voice-words')).toHaveCount(4);
        await say(nadia, 'Got it, thank you.');
        await expect(messagesIn(page).filter({ hasText: 'Got it, thank you.' })).toBeVisible();
        // reload: the list as the server has it (a message pushed from another session and one this tab posted differ in a detail of the author until the next load)
        await page.reload();
        await expect(messagesIn(page).filter({ hasText: 'Got it, thank you.' })).toBeVisible();
        await toBottom();
        await shot('between-text');

        // played and not played: the first one is played, the others are not
        const first = voiceRows().first();
        await first.getByTestId('voice-play').click();
        await expect(first.getByTestId('voice-player')).toHaveAttribute('data-state', 'playing');
        await first.getByTestId('voice-play').click();
        await expect(first.getByTestId('voice-badge')).toHaveAccessibleName('played');
        await first.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await shot('played-and-not-played');

        // a failed transcript, as the server writes it when the model is busy three times
        await stack.sql(
          `SET ROLE manythreads_system;
           UPDATE app.messages SET body = 'Voice message (0:03)', body_plain = 'Voice message (0:03)',
                  meta = jsonb_set(meta, '{voice}', (meta->'voice') - 'transcriptEndMs' || '{"transcript":"failed","transcriptNote":"The speech model did not answer. You can ask again.","transcriptRetry":true}'::jsonb)
            WHERE meta ? 'voice' AND id = (SELECT id FROM app.messages WHERE meta ? 'voice' ORDER BY created_at DESC, id DESC LIMIT 1)`,
        );
        await page.reload();
        await expect(voiceRows().last().getByTestId('voice-try-again')).toBeVisible();
        await toBottom();
        await shot('failed');
      } finally {
        await nadia.ctx.dispose();
        await omar.ctx.dispose();
        await context.close();
      }
    });
  }
}
