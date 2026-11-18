import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { messagesIn } from '../support/stack-browser.ts';
import { VOICE_STACK_ENV, bar, holdTranscriptPushes, openVoice, pauseButton, sendButton, startRecording } from './voice-support.ts';

/**
 * The pictures of P32-08: the recording bar (recording, paused) and the voice message (sending, "Writing the transcript…", with its transcript, and a failed
 * transcript with Try again), in Graphite dark and Linen light, at 1440 and 390 px. This is a tool, not a check: it is skipped unless MANYTHREADS_VOICE_PICTURES=1, and it
 * writes the PNGs to MANYTHREADS_VOICE_PICTURES_DIR (default temp/screenshots/p32 in the repository). Run it with
 * `MANYTHREADS_VOICE_PICTURES=1 pnpm e2e --project=voice channels/voice-pictures.spec.ts` (and `--project=voice-mobile` for the 390 px ones: the phone project owns
 * only voice-mobile.spec.ts, so the 390 px pictures are taken here by a desktop browser with a phone viewport).
 */
test.skip(!process.env['MANYTHREADS_VOICE_PICTURES'], 'a picture tool, run on purpose');
test.skip(({ isMobile }) => isMobile, 'takes its own sizes');
test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 10_000 });

const OUT = process.env['MANYTHREADS_VOICE_PICTURES_DIR'] ?? fileURLToPath(new URL('../../temp/screenshots/p32/', import.meta.url));
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
            WHERE meta ? 'voice' AND id = (SELECT id FROM app.messages WHERE meta ? 'voice' ORDER BY id DESC LIMIT 1)`,
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
  }
}
