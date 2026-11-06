/*
 * The speech worker (PLAN P14-16): receives a clip as 16 kHz samples, finds the speech, finds the language, writes the words, and answers with
 * the text and how long each step took. It runs one job at a time and keeps the model between jobs; the page stops the worker after a minute of
 * quiet (client.ts), which is what gives the memory back. The model library is loaded here and nowhere else, so the main bundle does not carry it.
 */
import { isClientMessage, type ClientMessage, type SpeechStats, type WorkerMessage } from './protocol';
import { VAD_SAMPLE_RATE, fixedWindows, planWindows, speechRegions, windowsMs, type Region } from './vad';
import { dominantLanguage, detectLanguage, disposeWhisper, loadVad, loadWhisper, pickDevice, transcribeWindow, type WhisperSession } from './whisper';
import type { SpeechSegment, Transcript } from './types';

interface WorkerScope {
  postMessage(message: WorkerMessage): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;

const post = (m: WorkerMessage): void => scope.postMessage(m);
const now = (): number => performance.now();

let session: WhisperSession | null = null;
let queue: Promise<void> = Promise.resolve();

/** Gets the model for this job, reusing the one in memory. A graphics-card failure on `auto` falls back to the processor. */
async function ensureSession(msg: ClientMessage, onFraction: (f: number) => void): Promise<WhisperSession> {
  const wanted = await pickDevice(msg.device);
  if (session && session.name === msg.model && session.device === wanted) return session;
  await disposeWhisper(session);
  session = null;
  try {
    session = await loadWhisper(msg.model, wanted, onFraction);
  } catch (err) {
    if (wanted !== 'webgpu' || msg.device !== 'auto') throw err;
    session = await loadWhisper(msg.model, 'wasm', onFraction);
  }
  return session;
}

/** A failure while getting the model, so the page can say "couldn't get the speech model". */
class ModelError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

async function run(msg: ClientMessage): Promise<void> {
  const t0 = now();
  let s: WhisperSession;
  try {
    s = await ensureSession(msg, (fraction) => post({ type: 'progress', id: msg.id, stage: 'model', fraction }));
  } catch (err) {
    throw new ModelError(err);
  }
  const loadMs = Math.round(now() - t0);
  post({ type: 'progress', id: msg.id, stage: 'model', fraction: 1 });

  // where the speech is
  const tVad = now();
  const vad = await loadVad(s);
  let windows: Region[];
  if (vad) {
    const probs = await vad.probabilities(msg.samples);
    windows = planWindows(speechRegions(probs, msg.samples.length));
  } else {
    windows = fixedWindows(msg.samples.length);
  }
  const vadMs = Math.round(now() - tVad);
  const audioMs = Math.round((msg.samples.length * 1000) / VAD_SAMPLE_RATE);
  const speechMs = windowsMs(windows);
  post({ type: 'progress', id: msg.id, stage: 'listening', fraction: 0.05 });

  const slice = (i: number): Float32Array => msg.samples.subarray(windows[i]!.start, windows[i]!.end);
  const startMs = (i: number): number => Math.round((windows[i]!.start * 1000) / VAD_SAMPLE_RATE);

  // which language: given, or read from the first window and used for the rest
  let language: string | null = msg.language ?? null;
  let languageMs = 0;
  if (!language && windows.length > 0) {
    const tLang = now();
    language = await detectLanguage(s, slice(0));
    languageMs = Math.round(now() - tLang);
  }

  const tDecode = now();
  const segments: SpeechSegment[] = [];
  const found: { language: string | null; ms: number }[] = [];
  let doneSamples = 0;
  const totalSamples = windows.reduce((n, w) => n + (w.end - w.start), 0);
  for (let i = 0; i < windows.length; i++) {
    const part = await transcribeWindow(s, slice(i), startMs(i), language ?? 'en');
    segments.push(...part);
    found.push({ language, ms: windows[i]!.end - windows[i]!.start });
    doneSamples += windows[i]!.end - windows[i]!.start;
    post({ type: 'progress', id: msg.id, stage: 'listening', fraction: 0.05 + 0.95 * (doneSamples / totalSamples) });
  }
  const decodeMs = Math.round(now() - tDecode);

  const transcript: Transcript = { segments, text: segments.map((x) => x.text).join(' '), language: dominantLanguage(found) };
  const stats: SpeechStats = { model: s.name, device: s.device, loadMs, vadMs, languageMs, decodeMs, audioMs, speechMs, windows: windows.length };
  post({ type: 'result', id: msg.id, transcript, stats });
}

scope.onmessage = (e: MessageEvent) => {
  const msg: unknown = e.data;
  if (!isClientMessage(msg)) return;
  queue = queue.then(() =>
    run(msg).catch((err: unknown) => {
      post({ type: 'error', id: msg.id, code: 'failed', during: err instanceof ModelError ? 'model' : 'work', message: err instanceof Error ? err.message : String(err) });
    }),
  );
};
