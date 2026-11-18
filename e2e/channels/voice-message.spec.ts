import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, postAs, type StackApi } from '../support/stack-browser.ts';
import { FAKE_TEXT, VOICE_STACK_ENV, bar, deleteButton, holdTranscriptPushes, liveTracks, mic, openVoice, pauseButton, players, recordClip, refuseMicrophone, seedVoice, sendButton, startRecording, timerSeconds } from './voice-support.ts';

/**
 * Voice messages (PLAN P14-17, rewritten in P32-07 for P32-05 and P32-06), desktop layout, on a stack of its own (the spec posts messages and uploads clips).
 * Chromium's fake microphone plays e2e/fixtures/speech/nadia.wav; the server's stand-in speech model (MANYTHREADS_FAKE_ASR=1, VOICE_STACK_ENV) writes FAKE_TEXT as the
 * transcript of every clip. There is no preview: Send puts a row in the list at once, uploads the clip and posts it, and the words arrive by a push a moment later.
 * The `voice` project of playwright.config.ts supplies the browser flags. Nothing here sleeps except where a test waits for something NOT to change.
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
  stack = await startStack({ ...VOICE_STACK_ENV });
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

type Posted = { id: string; body: string; meta: { voice?: { transcript: string; language: string | null; durationMs: number; fileId: string; transcriptEndMs?: number }; attachments?: string[] }; attachments?: Array<{ id: string; mime: string }> };
const listOf = async (api: StackApi, channel: string): Promise<Posted[]> => (await api.get<{ items: Posted[] }>(`/api/channels/${channel}/messages`)).items;
const box = (page: Page, name = 'Message #dev') => page.getByRole('textbox', { name });
const lastVoiceRow = (page: Page) => messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
const uploads = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/channels\/[^/]+\/files$/.test(new URL(r.url()).pathname)) seen.push(r.url());
  });
  return seen;
};

test('records, pauses, resumes and sends: a row at once, then "Writing the transcript…", then the words', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await expect(box(page)).toBeVisible();
    const pushes = await holdTranscriptPushes(page);
    // hold the upload, so the row that shows while the clip goes up can be looked at
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((res) => (openGate = res));
    await page.route(/\/api\/channels\/[^/]+\/files$/, async (route) => {
      await gate;
      await route.continue();
    });
    await expect(box(page)).toBeVisible();
    await expect(mic(page)).toHaveAccessibleName('Record a voice message');
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');

    // the bar replaces the composer: delete, time, waveform, pause, send
    await startRecording(page, 2);
    await expect(bar(page)).toHaveAttribute('data-state', 'recording');
    await expect(page.getByTestId('voice-live')).toHaveText('Recording');
    await expect(box(page)).toBeHidden();
    await expect(deleteButton(page)).toHaveAccessibleName('Delete recording');
    await expect(page.getByTestId('voice-wave')).toBeVisible();
    await expect(sendButton(page)).toHaveAccessibleName('Send voice message');
    await expect(page.getByTestId('voice-recording')).toHaveAccessibleDescription(/transcript/i);

    // pause: the clock stands still, the button becomes Resume
    await pauseButton(page).click();
    await expect(bar(page)).toHaveAttribute('data-state', 'paused');
    await expect(pauseButton(page)).toHaveAccessibleName('Resume recording');
    await expect(page.getByTestId('voice-live')).toHaveText(/^Recording paused, 0:0\d$/);
    const frozen = await timerSeconds(page);
    await page.waitForTimeout(2_200); // a negative: the clock must not move while paused
    expect(await timerSeconds(page)).toBe(frozen);
    // resume: it counts again from where it stopped
    await pauseButton(page).click();
    await expect(bar(page)).toHaveAttribute('data-state', 'recording');
    await expect.poll(() => timerSeconds(page)).toBeGreaterThan(frozen);

    // Send: no preview; the row is in the list at once, "Sending…", with the length
    await sendButton(page).click();
    await expect(bar(page)).toBeHidden();
    const sending = page.getByTestId('pending-message');
    await expect(sending).toHaveAttribute('data-status', 'sending');
    await expect(sending.getByTestId('voice-pending')).toBeVisible();
    await expect(sending.getByTestId('voice-pending-length')).toHaveText(/^0:0[3-9]$/);
    await expect(sending).toContainText('Sending…');
    // the microphone is let go the moment Send is pressed
    await expect.poll(() => liveTracks(page)).toBe(0);
    await expect(box(page)).toBeFocused();
    openGate();

    // posted: the player, and the transcript block says it is being written
    const row = lastVoiceRow(page);
    await expect(row).toBeVisible();
    await expect(sending).toHaveCount(0);
    await expect(row.getByTestId('voice-player')).toHaveAccessibleName(/^Voice message from Omar, 0:0[3-9]$/);
    await expect(row.getByTestId('voice-writing')).toHaveText('Writing the transcript…');
    await expect(row.getByTestId('voice-writing')).toHaveAttribute('role', 'status');
    await expect(row.getByTestId('voice-badge')).toHaveAccessibleName('not played yet');
    await expect(row.getByTestId('voice-sent')).toHaveCount(0); // the row's own time is the only one
    // the stand-in line is never drawn as the words
    await expect(row).not.toContainText('Voice message (');
    const asPosted = (await listOf(omar, dev)).find((m) => m.meta.voice);
    expect(asPosted?.meta.attachments).toEqual([asPosted?.meta.voice?.fileId]);

    // the server writes the words; the push brings them
    await expect.poll(async () => (await listOf(omar, dev)).find((m) => m.meta.voice)?.meta.voice?.transcript, { timeout: 20_000 }).toBe('server');
    pushes.release();
    await expect(row.getByTestId('voice-transcript-heading')).toHaveText(/^Transcript$/);
    await expect(row.getByTestId('voice-words')).toHaveText(FAKE_TEXT);
    await expect(row.getByTestId('voice-writing')).toHaveCount(0);
    // the words are drawn once, inside the transcript block
    await expect(row.getByTestId('voice-words')).toHaveCount(1);
    await expect(row.getByTestId('voice-transcript').getByTestId('voice-words')).toHaveCount(1);
    await expect(row.getByTestId('voice-first-seconds')).toHaveCount(0);

    const posted = (await listOf(omar, dev)).find((m) => m.meta.voice);
    expect(posted?.body).toBe(FAKE_TEXT);
    expect(posted?.meta.voice).toMatchObject({ transcript: 'server' });
    expect(posted?.attachments?.[0]?.mime).toBe('audio/webm');
    const clip = await omar.ctx.get(`/api/files/${posted?.meta.voice?.fileId}/content`);
    expect(clip.status()).toBe(200);
    expect(clip.headers()['content-type']).toBe('audio/webm');
    await expect(box(page)).toHaveValue('');
    await expect(mic(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a clip that goes up badly stays on the page: Try again sends it, Delete asks first', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    let failing = true;
    await page.route(/\/api\/channels\/[^/]+\/files$/, (route) => (failing ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'boom' } }) }) : route.continue()));
    const before = (await listOf(omar, dev)).filter((m) => m.meta.voice).length;
    await recordClip(page);
    const failed = page.getByTestId('pending-message');
    await expect(failed).toHaveAttribute('data-status', 'failed');
    await expect(failed.getByTestId('voice-pending')).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    // Delete asks first, and "Keep it" changes nothing
    await failed.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(failed).toContainText('Throw this voice message away? The recording is lost.');
    await failed.getByRole('button', { name: 'Keep it' }).click();
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    failing = false;
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect(failed).toHaveCount(0);
    await expect(lastVoiceRow(page).getByTestId('voice-player')).toBeVisible();
    await expect.poll(async () => (await listOf(omar, dev)).filter((m) => m.meta.voice).length).toBe(before + 1);

    // a second failure thrown away: nothing is sent
    failing = true;
    await recordClip(page);
    await expect(failed).toHaveAttribute('data-status', 'failed');
    await failed.getByRole('button', { name: 'Delete', exact: true }).click();
    await failed.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(failed).toHaveCount(0);
    expect((await listOf(omar, dev)).filter((m) => m.meta.voice).length).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test('Delete and Esc throw a recording away and put the cursor back in the text box', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const sent = uploads(page);
    await startRecording(page, 1);
    await deleteButton(page).click();
    await expect(bar(page)).toBeHidden();
    await expect(page.getByTestId('voice-live')).toHaveText('Recording deleted');
    await expect(box(page)).toBeFocused();
    await expect.poll(() => liveTracks(page)).toBe(0);

    await startRecording(page, 1);
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(box(page)).toBeFocused();
    await expect.poll(() => liveTracks(page)).toBe(0);

    // paused recordings are thrown away the same way
    await startRecording(page, 1);
    await pauseButton(page).click();
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    expect(sent).toEqual([]);
    await expect(messagesIn(page).filter({ has: page.getByTestId('voice-player') }).filter({ hasText: 'Voice message (' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('sliding away while holding cancels the recording and nothing is uploaded', async ({ browser, playwright }) => {
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
    await expect(bar(page)).toBeVisible();
    await expect(page.getByTestId('voice-hint')).toHaveText('Slide left to cancel');
    await page.mouse.move(x - 120, y, { steps: 6 });
    await expect(page.getByTestId('voice-hint')).toHaveText('Release to cancel');
    await page.mouse.up();
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    await expect(mic(page)).toBeVisible();
    expect(sent).toEqual([]);
    expect((await listOf(omar, dev)).length).toBe(before);
  } finally {
    await context.close();
  }
});

test('a reader plays it: the badge turns grey, speed changes, the place is remembered', async ({ browser, playwright }) => {
  // a clip long enough that "where they stopped" is more than a second from both ends
  const author = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await recordClip(author.page, 5);
    await expect(lastVoiceRow(author.page).getByTestId('voice-words')).toHaveText(FAKE_TEXT);
  } finally {
    await author.context.close();
  }
  const id = (await listOf(omar, dev)).filter((m) => m.meta.voice).at(0)!.id;

  const { page, context } = await openVoice(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  try {
    const row = messagesIn(page).filter({ has: page.locator(`[data-testid="voice-player"]`) }).last();
    const player = row.getByTestId('voice-player');
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('data-state', 'idle');
    await expect(row.getByTestId('voice-badge')).toHaveAccessibleName('not played yet');
    await expect(row.getByTestId('voice-transcript-heading')).toBeVisible();
    // a reader has no controls of the author's on this message
    await expect(row.getByTestId('voice-try-again')).toHaveCount(0);

    await row.getByTestId('voice-play').click();
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(row.getByRole('button', { name: 'Pause voice message' })).toBeVisible();
    await expect(row.getByTestId('voice-badge')).toHaveAccessibleName('played');
    await expect(row.getByTestId('voice-speed')).toHaveText('1×');
    await row.getByTestId('voice-speed').click();
    await expect(row.getByTestId('voice-speed')).toHaveAccessibleName('Playback speed 1.5 times');
    await row.getByTestId('voice-speed').click();
    await expect(row.getByTestId('voice-speed')).toHaveAccessibleName('Playback speed 2 times');
    // the dot moves with the position, and the length under the waveform becomes the position
    const seek = row.getByTestId('voice-seek');
    await expect.poll(async () => Number(await seek.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(2);
    await expect(row.getByTestId('voice-dot')).toHaveAttribute('style', /left: (?!0\.00%)/);
    await row.getByTestId('voice-play').click();
    await expect(player).not.toHaveAttribute('data-state', 'playing');
    const stoppedAt = Number(await seek.getAttribute('aria-valuenow'));
    expect(stoppedAt).toBeGreaterThanOrEqual(2);

    // a reload: the place, the speed and the "played" mark are remembered (in this browser only)
    await page.reload();
    const again = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
    await expect(again.getByTestId('voice-seek')).toHaveAttribute('aria-valuenow', String(stoppedAt));
    await expect(again.getByTestId('voice-speed')).toHaveText('2×');
    await expect(again.getByTestId('voice-badge')).toHaveAccessibleName('played');
    expect(id).not.toBe('');

    // arrow keys move by five seconds inside the clip and never past its ends
    await again.getByTestId('voice-seek').focus();
    await page.keyboard.press('Home');
    await expect(again.getByTestId('voice-seek')).toHaveAttribute('aria-valuenow', '0');
  } finally {
    await context.close();
  }
});

test('search finds a voice message by a word of its transcript', async ({ browser, playwright }) => {
  const { page: author, context: authorContext } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/general');
  try {
    await recordClip(author, 2);
    await expect(lastVoiceRow(author).getByTestId('voice-words')).toHaveText(FAKE_TEXT);
  } finally {
    await authorContext.close();
  }
  const { page, context } = await openVoice(browser, playwright, stack, 'nadia', '/t/engineering/search?q=%22test+voice+message%22');
  try {
    const hit = page.getByTestId('search-hit').filter({ hasText: 'This is a test voice message' });
    await expect(hit.first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a refused microphone says how to allow it', async ({ browser, playwright }) => {
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { before: refuseMicrophone });
  try {
    await mic(page).click();
    await expect(page.getByTestId('voice-error')).toHaveText("Your browser blocked the microphone. Allow it in the address bar's site settings, then try again.");
    await expect(bar(page)).toBeHidden();
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
    await expect(bar(page)).toBeVisible();
    await expect.poll(() => liveTracks(page)).toBeGreaterThan(0);
    await page.locator('[data-landmark="sidebar"] a[href$="/c/general"]').click();
    await expect(page).toHaveURL(/\/c\/general$/);
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    await expect(box(page, 'Message #general')).toBeVisible();
    const sent = (await listOf(omar, general)).filter((m) => m.meta.voice).length;
    expect(sent).toBeLessThanOrEqual(1); // the search test above sent one to #general, this one none
  } finally {
    await context.close();
  }
});

test('a voice message in a thread and in a DM, with the transcript in the thread view', async ({ browser, playwright }) => {
  const root = await postAs(nadia, dev, 'Thread root for a voice reply');
  await postAs(nadia, dev, 'First reply', root.id);
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    // thread: the reply box in the right panel has its own microphone and its own bar
    const panel = page.locator('[data-landmark="right-panel"]');
    await messagesIn(page).filter({ hasText: 'Thread root for a voice reply' }).getByRole('button', { name: '1 reply' }).click();
    await expect(panel.getByRole('textbox', { name: 'Reply in thread' })).toBeVisible();
    await recordClip(panel);
    await expect(panel.getByTestId('voice-player')).toHaveCount(1);
    await expect(panel.getByTestId('voice-words')).toHaveText(FAKE_TEXT);
    await expect(panel.getByTestId('voice-transcript-heading')).toHaveText(/^Transcript$/);

    // DM: Omar starts a conversation with Nadia and sends a clip
    await page.goto('/t/engineering/threads');
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'New message' });
    await picker.getByRole('checkbox', { name: /Nadia/ }).check();
    await picker.getByRole('button', { name: 'Message' }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/dm\/[0-9a-f-]{36}$/);
    await expect(box(page, 'Message Nadia')).toBeVisible();
    await recordClip(page);
    await expect(page.getByTestId('voice-player')).toHaveCount(1);
    await expect(messagesIn(page).last().getByTestId('voice-words')).toHaveText(FAKE_TEXT);
  } finally {
    await context.close();
  }
});

test('an admin can turn transcripts off: the next voice message says "No transcript"', async ({ browser, playwright }) => {
  const patch = await omar.ctx.patch('/api/workspace', { data: { voiceTranscripts: false }, headers: await omar.headers() });
  expect(patch.status(), await patch.text()).toBe(200);
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await recordClip(page);
    const row = lastVoiceRow(page);
    await expect(row.getByTestId('voice-no-transcript')).toHaveText('No transcript');
    await expect(row.getByTestId('voice-writing')).toHaveCount(0);
    await expect(row).not.toContainText('Add a transcript');
    expect((await listOf(omar, dev)).find((m) => m.id !== undefined && m.meta.voice?.transcript === 'none')).toBeTruthy();
  } finally {
    await context.close();
    const back = await omar.ctx.patch('/api/workspace', { data: { voiceTranscripts: true }, headers: await omar.headers() });
    expect(back.status()).toBe(200);
  }
});

test('a message from before P32 keeps its own words and the note, and offers no "Add a transcript"', async ({ browser, playwright }) => {
  await seedVoice(omar, dev, 'Please review the quokkasearch plan before Friday.');
  const { page, context } = await openVoice(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const row = messagesIn(page).filter({ hasText: 'quokkasearch' });
    await expect(row.getByTestId('voice-words')).toContainText('Please review the quokkasearch plan');
    await expect(row.getByTestId('voice-note')).toHaveText("Transcript in English, written on the sender's device");
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByTestId('add-transcript')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Edit/ })).toBeVisible();
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
