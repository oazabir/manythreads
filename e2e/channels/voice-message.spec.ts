import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, postAs, type StackApi } from '../support/stack-browser.ts';
import { FAKE_TEXT, liveTracks, mic, openVoice, players, preview, recordClip, refuseMicrophone, seedVoice, timerSeconds, transcriptBox } from './voice-support.ts';

/**
 * Voice messages (PLAN P14-17), desktop layout, on a stack of its own (the spec posts messages and uploads clips). Chromium's fake microphone plays
 * e2e/fixtures/speech/hello.wav; the fake speech engine (VITE_MANYTHREADS_FAKE_ASR=1 in the e2e web build) writes FAKE_TEXT for every clip. The
 * `voice` project of playwright.config.ts supplies the browser flags. Nothing here sleeps: each step waits for what the page shows.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; voice-mobile.spec.ts runs the phone');
test.describe.configure({ mode: 'default' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let dev = '';
let general = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  const ids = await channelsOf(omar);
  dev = ids['dev']!;
  general = ids['general']!;
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

type Posted = { id: string; body: string; meta: { voice?: { transcript: string; language: string | null; durationMs: number; fileId: string }; attachments?: string[] }; attachments?: Array<{ id: string; mime: string }> };
const listOf = async (api: StackApi, channel: string): Promise<Posted[]> => (await api.get<{ items: Posted[] }>(`/api/channels/${channel}/messages`)).items;
const box = (page: Page, name = 'Message #dev') => page.getByRole('textbox', { name });
const uploads = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/channels\/[^/]+\/files$/.test(new URL(r.url()).pathname)) seen.push(r.url());
  });
  return seen;
};

test('records a voice message, shows the device transcript in the preview, and sends it', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await expect(box(page)).toBeVisible();
    await expect(mic(page)).toHaveAccessibleName('Record a voice message');
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
    await mic(page).click();
    await expect(page.getByTestId('voice-recording')).toBeVisible();
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('voice-live')).toHaveText('Recording');
    await expect.poll(() => timerSeconds(page)).toBeGreaterThanOrEqual(2);
    await mic(page).click();

    // the preview: the clip, its length, the words the device wrote, and the language it found
    await expect(preview(page)).toBeVisible();
    await expect(page.getByTestId('voice-length')).toHaveText(/^0:00 \/ 0:0[2-9]$/);
    await expect(transcriptBox(page)).toHaveValue(FAKE_TEXT);
    await expect(page.getByTestId('voice-transcript-language')).toHaveText('Language: English');
    await expect(page.getByTestId('voice-transcript-live')).toHaveText('Transcript ready');
    await expect(page.getByTestId('voice-send')).toBeEnabled();
    // the recording stopped: the microphone is let go the moment the preview is open
    await expect.poll(() => liveTracks(page)).toBe(0);

    await page.getByTestId('voice-send').click();
    await expect(preview(page)).toBeHidden();
    const row = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('voice-player')).toHaveAccessibleName(/^Voice message from Omar, 0:0[2-9]$/);
    // the words are the message's text, with a quiet line that says where they came from
    await expect(row.locator('.txt')).toContainText(FAKE_TEXT);
    await expect(row.getByTestId('voice-note')).toHaveText("Transcript in English, written on the sender's device");
    // the recording is shown as the player, not as a file card
    await expect(row.locator('.atts')).toHaveCount(0);
    await expect(messagesIn(page).filter({ hasText: 'Voice message (' })).toHaveCount(0);

    // the server kept it as audio, with the transcript in the body and the clip as the single attachment
    const posted = (await listOf(omar, dev)).find((m) => m.meta.voice);
    expect(posted?.body).toBe(FAKE_TEXT);
    expect(posted?.meta.voice).toMatchObject({ transcript: 'device', language: 'en' });
    expect(posted?.meta.attachments).toEqual([posted?.meta.voice?.fileId]);
    expect(posted?.attachments?.[0]?.mime).toBe('audio/webm');
    // and gives the recording back to a person with its audio type
    const clip = await omar.ctx.get(`/api/files/${posted?.meta.voice?.fileId}/content`);
    expect(clip.status()).toBe(200);
    expect(clip.headers()['content-type']).toBe('audio/webm');
    // the composer is back to normal and holds no draft
    await expect(box(page)).toHaveValue('');
    await expect(mic(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the sender corrects the transcript before sending', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await recordClip(page);
    await expect(transcriptBox(page)).toHaveValue(FAKE_TEXT);
    await transcriptBox(page).fill('Corrected by hand: quokkaplan is ready.');
    await page.getByTestId('voice-send').click();
    const row = messagesIn(page).filter({ hasText: 'Corrected by hand: quokkaplan is ready.' });
    await expect(row.getByTestId('voice-player')).toBeVisible();
    await expect(row.getByTestId('voice-note')).toHaveText('Transcript in English, corrected by hand');
    const posted = (await listOf(omar, dev)).find((m) => m.body.startsWith('Corrected by hand'));
    expect(posted?.meta.voice?.transcript).toBe('edited');
  } finally {
    await context.close();
  }
});

test('a reader plays it, changes speed and resumes where they stopped', async ({ browser, playwright }) => {
  // a clip long enough that "where they stopped" is more than a second from both ends
  const author = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await recordClip(author.page, 5);
    await transcriptBox(author.page).fill('Resume check clip.');
    await author.page.getByTestId('voice-send').click();
    await expect(messagesIn(author.page).filter({ hasText: 'Resume check clip.' }).getByTestId('voice-player')).toBeVisible();
  } finally {
    await author.context.close();
  }

  const { page, context } = await openVoice(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  try {
    const row = messagesIn(page).filter({ hasText: 'Resume check clip.' });
    const player = row.getByTestId('voice-player');
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('data-state', 'idle');
    // a reader gets the same player; they have no microphone-only controls on someone else's message
    await expect(row.getByTestId('add-transcript')).toHaveCount(0);

    await row.getByTestId('voice-play').click();
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(row.getByRole('button', { name: 'Pause voice message' })).toBeVisible();
    // the speed button cycles 1x, 1.5x, 2x and back
    await expect(row.getByTestId('voice-speed')).toHaveText('1×');
    await row.getByTestId('voice-speed').click();
    await expect(row.getByTestId('voice-speed')).toHaveAccessibleName('Playback speed 1.5 times');
    await row.getByTestId('voice-speed').click();
    await expect(row.getByTestId('voice-speed')).toHaveAccessibleName('Playback speed 2 times');
    // it plays on: the position moves past the second mark
    const seek = row.getByTestId('voice-seek');
    await expect.poll(async () => Number(await seek.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(2);
    await row.getByTestId('voice-play').click();
    await expect(player).not.toHaveAttribute('data-state', 'playing');
    const stoppedAt = Number(await seek.getAttribute('aria-valuenow'));
    expect(stoppedAt).toBeGreaterThanOrEqual(2);
    await expect(seek).toHaveAttribute('aria-valuetext', /^0:0[1-9] of 0:0[5-9]$/);

    // a reload: the place is remembered (in this browser only) and so is the speed
    await page.reload();
    const again = messagesIn(page).filter({ hasText: 'Resume check clip.' });
    await expect(again.getByTestId('voice-seek')).toHaveAttribute('aria-valuenow', String(stoppedAt));
    await expect(again.getByTestId('voice-speed')).toHaveText('2×');

    // arrow keys move by five seconds inside the clip and never past its ends
    await again.getByTestId('voice-seek').focus();
    await page.keyboard.press('Home');
    await expect(again.getByTestId('voice-seek')).toHaveAttribute('aria-valuenow', '0');
  } finally {
    await context.close();
  }
});

test('search finds a voice message by a word of its transcript', async ({ browser, playwright }) => {
  await seedVoice(omar, dev, 'Please review the quokkasearch plan before Friday.');
  const { page, context } = await openVoice(browser, playwright, stack, 'nadia', '/t/engineering/search?q=quokkasearch');
  try {
    const hit = page.getByTestId('search-hit').filter({ hasText: 'quokkasearch' });
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText('Please review the');
  } finally {
    await context.close();
  }
});

test('sliding away cancels the recording and nothing is uploaded', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const sent = uploads(page);
    const before = (await listOf(omar, dev)).length;
    await expect(mic(page)).toBeVisible();
    const at = (await mic(page).boundingBox())!;
    const x = at.x + at.width / 2;
    const y = at.y + at.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(page.getByTestId('voice-recording')).toContainText('Recording · slide left to cancel');
    await page.mouse.move(x - 120, y, { steps: 6 });
    await expect(page.getByTestId('voice-recording')).toContainText('Release to cancel');
    await page.mouse.up();
    await expect(page.getByTestId('voice-recording')).toBeHidden();
    await expect(preview(page)).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    await expect(mic(page)).toBeVisible();
    expect(sent).toEqual([]);
    expect((await listOf(omar, dev)).length).toBe(before);
  } finally {
    await context.close();
  }
});

test('Esc throws a recording away; in the preview Esc first leaves the words box, then discards the clip', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const sent = uploads(page);
    await mic(page).click();
    await expect(page.getByTestId('voice-recording')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('voice-recording')).toBeHidden();
    await expect(preview(page)).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);

    await recordClip(page);
    await transcriptBox(page).focus();
    await page.keyboard.press('Escape');
    // the words box lets go of the focus; the clip is kept
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).getByTestId('voice-play')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(preview(page)).toBeHidden();
    await expect(page.getByTestId('voice-live')).toHaveText('Voice message discarded');
    await expect(box(page)).toBeFocused();
    expect(sent).toEqual([]);

    // the Discard button does the same
    await recordClip(page);
    await page.getByTestId('voice-discard').click();
    await expect(preview(page)).toBeHidden();
    expect(sent).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a refused microphone says how to allow it', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { before: refuseMicrophone });
  try {
    await mic(page).click();
    await expect(page.getByTestId('voice-error')).toHaveText("Your browser blocked the microphone. Allow it in the address bar's site settings, then try again.");
    await expect(page.getByTestId('voice-recording')).toBeHidden();
    await page.getByTestId('voice-error').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('voice-error')).toBeHidden();
    await expect(mic(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('switching to another channel while recording lets go of the microphone', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await mic(page).click();
    await expect(page.getByTestId('voice-recording')).toBeVisible();
    await expect.poll(() => liveTracks(page)).toBeGreaterThan(0);
    await page.locator('[data-landmark="sidebar"] a[href$="/c/general"]').click();
    await expect(page).toHaveURL(/\/c\/general$/);
    await expect(page.getByTestId('voice-recording')).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    await expect(box(page, 'Message #general')).toBeVisible();
    expect((await listOf(omar, general)).some((m) => m.meta.voice)).toBe(false);
  } finally {
    await context.close();
  }
});

test('send without waiting posts the clip and the transcript follows; "Add a transcript" fills a clip that has none', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    // hold the decoder, so the device is still "writing it out" when Send is pressed
    await page.evaluate(() => {
      window.__holdDecode = true;
    });
    await recordClip(page);
    await expect(page.getByTestId('voice-transcript-working')).toBeVisible();
    await expect(page.getByTestId('voice-send')).toBeDisabled();
    await page.getByTestId('voice-send-now').click();
    await expect(preview(page)).toBeHidden();
    const lateRow = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
    await expect(lateRow).toBeVisible();
    // posted with no words: the stand-in line is not shown, "No transcript" is
    await expect(lateRow.getByTestId('voice-no-transcript')).toHaveText('No transcript');
    await expect.poll(async () => (await listOf(omar, dev)).filter((m) => m.meta.voice?.transcript === 'none').length).toBe(1);
    // the device finishes: the words are saved as an edit of that message
    await page.evaluate(() => window.__releaseDecode());
    await expect(lateRow.locator('.txt')).toContainText(FAKE_TEXT);
    await expect(lateRow.getByTestId('voice-no-transcript')).toHaveCount(0);
    // the clip was sent before the language was known, so the note names no language
    await expect(lateRow.getByTestId('voice-note')).toHaveText('Transcript, corrected by hand');

    // a second clip goes out and stays without words (the decoder never finishes before the page closes it): the author adds them from the menu
    await page.evaluate(() => {
      window.__holdDecode = true;
    });
    await recordClip(page);
    await page.getByTestId('voice-send-now').click();
    await expect(preview(page)).toBeHidden();
    const bare = messagesIn(page).filter({ has: page.getByTestId('voice-no-transcript') });
    await expect(bare).toHaveCount(1);
    await expect(bare.getByTestId('voice-player')).toBeVisible();
    // the author's own menu offers it
    await bare.hover();
    await bare.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByTestId('add-transcript')).toBeVisible();
    // let the first run finish quietly so it does not fill this one: the menu path starts a new run on the saved clip
    await page.evaluate(() => {
      window.__holdDecode = false;
    });
    await page.getByTestId('add-transcript').click();
    // (the "No transcript" line is gone once the edit box is open, so find the row by its player)
    await expect(messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last().getByRole('textbox', { name: 'Edit message' })).toHaveValue(FAKE_TEXT);
  } finally {
    await context.close();
  }
});

test('a voice message in a thread and in a DM', async ({ browser, playwright }) => {
  const root = await postAs(nadia, dev, 'Thread root for a voice reply');
  await postAs(nadia, dev, 'First reply', root.id);
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    // thread: the reply box in the right panel has its own microphone
    const panel = page.locator('[data-landmark="right-panel"]');
    await messagesIn(page).filter({ hasText: 'Thread root for a voice reply' }).getByRole('button', { name: '1 reply' }).click();
    await expect(panel.getByRole('textbox', { name: 'Reply in thread' })).toBeVisible();
    await recordClip(panel);
    await panel.getByTestId('voice-send').click();
    await expect(panel.getByTestId('voice-player')).toHaveCount(1);
    await expect(panel.getByTestId('thread-view')).toContainText(FAKE_TEXT);

    // DM: Omar starts a conversation with Nadia and sends a clip
    await page.goto('/t/engineering/threads');
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'New message' });
    await picker.getByRole('checkbox', { name: /Nadia/ }).check();
    await picker.getByRole('button', { name: 'Message' }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/dm\/[0-9a-f-]{36}$/);
    await expect(box(page, 'Message Nadia')).toBeVisible();
    await recordClip(page);
    await page.getByTestId('voice-send').click();
    await expect(page.getByTestId('voice-player')).toHaveCount(1);
    await expect(messagesIn(page).last()).toContainText(FAKE_TEXT);
  } finally {
    await context.close();
  }
});

test('a failed post keeps the voice message: Retry sends the clip with its words', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    let failing = true;
    await page.route(/\/api\/channels\/[^/]+\/messages$/, (route) => {
      if (route.request().method() === 'POST' && failing) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'boom' } }) });
      return route.continue();
    });
    await recordClip(page);
    await transcriptBox(page).fill('Retry keeps the voice, quokkaretry.');
    await page.getByTestId('voice-send').click();
    const pending = page.getByTestId('pending-message');
    await expect(pending).toHaveAttribute('data-status', 'failed');
    await expect(pending).toContainText('Retry keeps the voice, quokkaretry.');
    expect((await listOf(omar, dev)).some((m) => m.body.includes('quokkaretry'))).toBe(false);
    failing = false;
    await pending.getByRole('button', { name: 'Retry' }).click();
    await expect(pending).toHaveCount(0);
    const row = messagesIn(page).filter({ hasText: 'quokkaretry' });
    await expect(row.getByTestId('voice-player')).toBeVisible();
    const posted = (await listOf(omar, dev)).find((m) => m.body.includes('quokkaretry'));
    expect(posted?.meta.voice?.transcript).toBe('edited');
    expect(posted?.meta.attachments).toEqual([posted?.meta.voice?.fileId]);
  } finally {
    await context.close();
  }
});

test('signing out stops the playing voice message', async ({ browser, playwright }) => {
  await seedVoice(omar, dev, 'A clip to play before signing out.');
  const { page, context } = await openVoice(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  try {
    const row = messagesIn(page).filter({ hasText: 'A clip to play before signing out.' });
    await row.getByTestId('voice-play').click();
    await expect(row.getByTestId('voice-player')).toHaveAttribute('data-state', 'playing');
    expect(await page.evaluate(() => window.__audios.some((a) => !a.paused))).toBe(true);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    // no player still plays, and none still has the clip loaded (readyState 0: nothing to play)
    const left = await page.evaluate(() => window.__audios.map((a) => ({ paused: a.paused, src: a.currentSrc, ready: a.readyState })));
    expect(left.filter((a) => !a.paused || a.ready !== 0), JSON.stringify(left)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the service worker keeps a speech model file under /models/ and never an app page standing in for one', async ({ browser, playwright }) => {
  // the e2e build ships no model files; a stand-in file of the shape the worker keys on is served from the build's own folder for this test
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../../clients/web/dist/models/e2e-model/rev1/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}stand-in.json`, '{"model":"stand-in"}');
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    // the worker controls pages after it claims them
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const fetchOk = (path: string) => page.evaluate(async (p) => (await fetch(p)).status, path);
    expect(await fetchOk('/models/e2e-model/rev1/stand-in.json')).toBe(200);
    const cached = await page.evaluate(async () => {
      const cache = await caches.open('manythreads-models-v1');
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(cached).toContain('/models/e2e-model/rev1/stand-in.json');
    // a path that does not exist answers with the app's index page here; it must not be kept
    await page.evaluate(() => fetch('/models/e2e-model/rev1/missing.onnx').then((r) => r.text()));
    const after = await page.evaluate(async () => {
      const cache = await caches.open('manythreads-models-v1');
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(after).not.toContain('/models/e2e-model/rev1/missing.onnx');
    await page.evaluate(async () => {
      await caches.delete('manythreads-models-v1');
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    });
  } finally {
    await context.close();
    rmSync(fileURLToPath(new URL('../../clients/web/dist/models/e2e-model/', import.meta.url)), { recursive: true, force: true });
  }
});

// the players, once more, for the screen reader's name: every voice row says who and how long
test('every voice row names its sender and length', async ({ browser, playwright }) => {
  await seedVoice(omar, dev, 'A clip for the names.');
  const { page, context } = await openVoice(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  try {
    await expect(players(page).first()).toBeVisible();
    for (const label of await players(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) {
      expect(label).toMatch(/^Voice message from \w+, \d+:\d\d$/);
    }
  } finally {
    await context.close();
  }
});
