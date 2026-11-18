import { readFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, DESKTOP, PHONE, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the voice message specs (P14-17, rewritten in P32-07). The `voice` projects of playwright.config.ts start Chromium with a fake microphone that
 * plays e2e/fixtures/speech/nadia.wav (real speech, 8.6 s) on a loop. The words of a message are written by the server, not the browser: the stack of each
 * spec starts with MANYTHREADS_FAKE_ASR=1 (VOICE_STACK_ENV), whose stand-in answers FAKE_TEXT for every clip after a short delay. Nothing here sleeps:
 * every wait is on something the page shows.
 */

export const FAKE_TEXT = 'This is a test voice message.';

/** The server's stand-in speech model: every clip "says" FAKE_TEXT. Passed to `startStack`. */
export const VOICE_STACK_ENV = { MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_FAKE_ASR: '1' } as const;

declare global {
  interface Window {
    /** Every audio track the page opened with getUserMedia (so a test can see whether the microphone was let go). */
    __tracks: MediaStreamTrack[];
    /** Every `Audio` the page made (the shared player), so a test can see whether it still plays. */
    __audios: HTMLAudioElement[];
  }
}

/** Runs in the page before any script: records the microphone tracks and `Audio` objects. */
function instrument(): void {
  window.__tracks = [];
  window.__audios = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const stream = await gum(c);
    stream.getAudioTracks().forEach((t) => window.__tracks.push(t));
    return stream;
  };
  const NativeAudio = window.Audio;
  window.Audio = function (this: unknown, src?: string) {
    const a = new NativeAudio(src);
    window.__audios.push(a);
    return a;
  } as unknown as typeof Audio;
}

/** The microphone refused (the person clicked Block). */
export function refuseMicrophone(): void {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
}

export interface VoiceSession {
  page: Page;
  context: BrowserContext;
}

/** A browser context of the persona on the stack with the microphone allowed and the page instrumented, open at `path`. */
export async function openVoice(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey | string,
  path: string,
  opts: { mobile?: boolean; before?: () => void; microphone?: boolean; look?: { theme: 'light' | 'dark'; palette: 'classic' | 'graphite' | 'linen' | 'harbor' }; reducedMotion?: boolean } = {},
): Promise<VoiceSession> {
  const api = await apiOn(playwright, stack, who);
  // a picture is taken in one look: the person's saved look is set through the real route, and this browser's copy is seeded so the first frame agrees
  if (opts.look) {
    const saved = await api.ctx.put('/api/me/appearance', { data: { theme: opts.look.theme, density: 'comfortable', palette: opts.look.palette }, headers: await api.headers() });
    expect(saved.status(), 'saving the look').toBe(200);
  }
  const state = await api.ctx.storageState();
  await api.ctx.dispose();
  const storageState = opts.look ? { ...state, origins: [...state.origins.filter((o) => o.origin !== stack.origin), { origin: stack.origin, localStorage: [{ name: 'mt.appearance', value: JSON.stringify({ theme: opts.look.theme, density: 'comfortable', palette: opts.look.palette }) }] }] } : state;
  const context = await browser.newContext({
    baseURL: stack.origin,
    viewport: opts.mobile ? PHONE : DESKTOP,
    storageState,
    ...(opts.look ? { colorScheme: opts.look.theme } : {}),
    reducedMotion: opts.reducedMotion === false ? 'no-preference' : 'reduce',
    ...(opts.microphone === false ? {} : { permissions: ['microphone'] }),
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(instrument);
  if (opts.before) await context.addInitScript(opts.before);
  const page = await context.newPage();
  await page.goto(path);
  return { page, context };
}

/** A page, or a region of it (the thread panel has a composer of its own, with its own microphone). */
export type Scope = Page | Locator;

export const mic = (s: Scope) => s.getByTestId('voice-mic');
/** The recording bar. */
export const bar = (s: Scope) => s.getByTestId('voice-recording');
export const sendButton = (s: Scope) => s.getByTestId('voice-send');
export const pauseButton = (s: Scope) => s.getByTestId('voice-pause');
export const deleteButton = (s: Scope) => s.getByTestId('voice-delete');

/** Seconds the recording timer shows (`0:07` is 7). */
export async function timerSeconds(page: Scope): Promise<number> {
  const text = (await page.getByTestId('voice-timer').textContent()) ?? '';
  const m = /^(\d+):(\d\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Taps the mic and waits until the timer on screen shows `seconds`: the bar is open and recording. */
export async function startRecording(page: Scope, seconds = 2): Promise<void> {
  await mic(page).click();
  await expect(bar(page)).toBeVisible();
  await expect.poll(() => timerSeconds(page), { timeout: seconds * 1000 + 8000 }).toBeGreaterThanOrEqual(seconds);
}

/** Records for `seconds` and presses Send. The row appears in the list at once ("Sending…"). */
export async function recordClip(page: Scope, seconds = 2): Promise<void> {
  await startRecording(page, seconds);
  await sendButton(page).click();
  await expect(bar(page)).toBeHidden();
}

/** How many of the page's microphone tracks are still live. */
export function liveTracks(page: Page): Promise<number> {
  return page.evaluate(() => window.__tracks.filter((t) => t.readyState === 'live').length);
}

/** The voice message rows of the page, newest last. */
export const players = (page: Page) => page.getByTestId('voice-player');

/** What a browser's recording starts with: an EBML header (WebM) and some bytes. It sniffs as a video; the declared audio type must win. */
export const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('opus clip bytes')]);

export type UploadedFile = { id: string; mime: string };

/** Uploads bytes to a channel the way the web client does (raw body, the type in the header). */
export async function uploadFile(api: StackApi, channel: string, body: Buffer, type: string, name: string): Promise<{ status: number; file: UploadedFile | null }> {
  const res = await api.ctx.post(`/api/channels/${channel}/files`, { data: body, headers: { ...(await api.headers()), 'content-type': type, 'x-file-name': encodeURIComponent(name) } });
  return { status: res.status(), file: res.status() === 201 ? ((await res.json()) as UploadedFile) : null };
}

export const voiceMeta = (fileId: string, over: Record<string, unknown> = {}) => ({ fileId, durationMs: 4000, language: 'en', transcript: 'device', peaks: [3, 40, 200, 90, 20], ...over });

const HELLO_WAV = readFileSync(new URL('../fixtures/speech/hello.wav', import.meta.url));

/** Posts a voice message as `api` straight through the server the way a client from before P32 did (its own words, `transcript: 'device'`; the clip is the fixture, a 6 s file a browser can play). */
export async function seedVoice(api: StackApi, channel: string, body: string): Promise<{ id: string; fileId: string }> {
  const f = await uploadFile(api, channel, HELLO_WAV, 'audio/wav', 'seeded.wav');
  expect(f.status, 'upload of the fixture clip').toBe(201);
  const m = await api.post<{ id: string }>(`/api/channels/${channel}/messages`, { channelId: channel, body, threadRootId: null, attachments: [f.file!.id], voice: voiceMeta(f.file!.id, { durationMs: 6000 }) });
  return { id: m.id, fileId: f.file!.id };
}

/** Keeps the server's `message.edited` pushes back until `release()`, so a test can look at the "Writing the transcript…" state for as long as it needs. Reloads the page, so its socket goes through the route. */
export async function holdTranscriptPushes(page: Page): Promise<{ release: () => void }> {
  const held: Array<() => void> = [];
  let holding = true;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (holding && typeof m === 'string' && m.includes('"message.edited"')) held.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  // the page's socket is opened when it loads: one opened before the route existed would not pass through it
  await page.reload();
  return {
    release: () => {
      holding = false;
      held.splice(0).forEach((f) => f());
    },
  };
}
