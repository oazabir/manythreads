import { readFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, DESKTOP, PHONE, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the voice message specs (P14-17). The `voice` projects of playwright.config.ts start Chromium with a fake microphone that plays
 * e2e/fixtures/speech/hello.wav on a loop, and the web build for the e2e run has the fake speech engine on (VITE_MANYTHREADS_FAKE_ASR=1), which
 * "writes" FAKE_TEXT for every clip. Nothing here sleeps: every wait is on something the page shows.
 */

export const FAKE_TEXT = 'This is a test voice message.';

declare global {
  interface Window {
    /** Every audio track the page opened with getUserMedia (so a test can see whether the microphone was let go). */
    __tracks: MediaStreamTrack[];
    /** Every `Audio` the page made (the shared player), so a test can see whether it still plays. */
    __audios: HTMLAudioElement[];
    /** While true, decodeAudioData waits (the fake engine decodes the clip first), so the transcript stays "being written". */
    __holdDecode: boolean;
    __releaseDecode: () => void;
  }
}

/** Runs in the page before any script: records the microphone tracks and `Audio` objects, and lets a test hold the decoder. */
function instrument(): void {
  window.__tracks = [];
  window.__audios = [];
  window.__holdDecode = false;
  let waiting: Array<() => void> = [];
  window.__releaseDecode = () => {
    window.__holdDecode = false;
    waiting.forEach((f) => f());
    waiting = [];
  };
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
  const decode = AudioContext.prototype.decodeAudioData;
  AudioContext.prototype.decodeAudioData = function (this: AudioContext, data: ArrayBuffer) {
    const run = (): Promise<AudioBuffer> => decode.call(this, data) as Promise<AudioBuffer>;
    if (!window.__holdDecode) return run();
    return new Promise<void>((resolve) => waiting.push(resolve)).then(run);
  } as typeof AudioContext.prototype.decodeAudioData;
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
  opts: { mobile?: boolean; before?: () => void; microphone?: boolean } = {},
): Promise<VoiceSession> {
  const api = await apiOn(playwright, stack, who);
  const storageState = await api.ctx.storageState();
  await api.ctx.dispose();
  const context = await browser.newContext({
    baseURL: stack.origin,
    viewport: opts.mobile ? PHONE : DESKTOP,
    storageState,
    reducedMotion: 'reduce',
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
export const preview = (s: Scope) => s.getByTestId('voice-preview');
export const transcriptBox = (s: Scope) => s.getByTestId('voice-transcript-text');

/** Seconds the recording timer shows (`0:07 / 5:00` is 7). */
export async function timerSeconds(page: Scope): Promise<number> {
  const text = (await page.getByTestId('voice-timer').textContent()) ?? '';
  const m = /^(\d+):(\d\d) /.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Taps the mic, waits until the timer on screen shows `seconds`, taps again: the preview is open. */
export async function recordClip(page: Scope, seconds = 2): Promise<void> {
  await mic(page).click();
  await expect(page.getByTestId('voice-recording')).toBeVisible();
  await expect.poll(() => timerSeconds(page), { timeout: seconds * 1000 + 8000 }).toBeGreaterThanOrEqual(seconds);
  await mic(page).click();
  await expect(preview(page)).toBeVisible();
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

/** Posts a voice message as `api` straight through the server (no recording; the clip is the fixture, a real 6 s recording a browser can play). */
export async function seedVoice(api: StackApi, channel: string, body: string): Promise<{ id: string; fileId: string }> {
  const f = await uploadFile(api, channel, HELLO_WAV, 'audio/wav', 'seeded.wav');
  expect(f.status, 'upload of the fixture clip').toBe(201);
  const m = await api.post<{ id: string }>(`/api/channels/${channel}/messages`, { channelId: channel, body, threadRootId: null, attachments: [f.file!.id], voice: voiceMeta(f.file!.id, { durationMs: 6000 }) });
  return { id: m.id, fileId: f.file!.id };
}
