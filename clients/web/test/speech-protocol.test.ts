import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_FAILED, WRITE_FAILED, createWorkerBackend, registerModelCache, type WorkerLike } from '../src/speech/client';
import {
  ModelProgress,
  WORKER_IDLE_MS,
  isClientMessage,
  isWorkerMessage,
  modelFileSizes,
  ortPaths,
  progressText,
  vadModelId,
  whisperModelId,
  type ClientMessage,
  type SpeechStats,
  type WorkerMessage,
} from '../src/speech/protocol';
import { SpeechError, type Transcript } from '../src/speech/types';

afterEach(() => vi.useRealTimers());

const transcript: Transcript = { segments: [{ text: 'Hello there.', startMs: 0, endMs: 900 }], text: 'Hello there.', language: 'en' };
const stats: SpeechStats = { model: 'tiny', device: 'wasm', loadMs: 1, vadMs: 1, languageMs: 1, decodeMs: 1, audioMs: 1000, speechMs: 900, windows: 1 };

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  sent: ClientMessage[] = [];
  transferred: Transferable[][] = [];
  postMessage(message: ClientMessage, transfer: Transferable[]): void {
    this.sent.push(message);
    this.transferred.push(transfer);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(m: WorkerMessage): void {
    this.onmessage?.({ data: m });
  }
}

/** The client queues each clip behind the one before, so a worker appears a moment after the call. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const pcm = () => ({ samples: new Float32Array([0.1, 0.2, 0.3]), sampleRate: 16000 });

function backend(opts: { idleMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  let firstUses = 0;
  const b = createWorkerBackend({
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    onFirstUse: () => void firstUses++,
    ...opts,
  });
  return { b, workers, firstUses: () => firstUses };
}

describe('messages', () => {
  const ok: ClientMessage = { type: 'transcribe', id: 1, model: 'tiny', samples: new Float32Array(4), device: 'auto' };

  it('accepts what the page sends and refuses the rest', () => {
    expect(isClientMessage(ok)).toBe(true);
    expect(isClientMessage({ ...ok, language: 'bn' })).toBe(true);
    expect(isClientMessage({ ...ok, model: 'large' })).toBe(false);
    expect(isClientMessage({ ...ok, samples: [1, 2] })).toBe(false);
    expect(isClientMessage({ ...ok, device: 'gpu' })).toBe(false);
    expect(isClientMessage({ ...ok, id: 'x' })).toBe(false);
    expect(isClientMessage({ type: 'cancel', id: 1 })).toBe(false);
    expect(isClientMessage(null)).toBe(false);
  });

  it('accepts what the worker answers and refuses the rest', () => {
    expect(isWorkerMessage({ type: 'progress', id: 1, stage: 'model', fraction: 0.4 })).toBe(true);
    expect(isWorkerMessage({ type: 'progress', id: 1, stage: 'writing', fraction: 0.4 })).toBe(false);
    expect(isWorkerMessage({ type: 'result', id: 1, transcript, stats })).toBe(true);
    expect(isWorkerMessage({ type: 'result', id: 1 })).toBe(false);
    expect(isWorkerMessage({ type: 'error', id: 1, code: 'failed', during: 'model', message: 'x' })).toBe(true);
    expect(isWorkerMessage({ type: 'error', id: 1, code: 'failed', message: 'x' })).toBe(false);
    expect(isWorkerMessage('hello')).toBe(false);
  });
});

describe('where the files are', () => {
  it('puts the model, the speech finder and the runtime under /models/ at their pinned revisions', () => {
    expect(whisperModelId('tiny')).toMatch(/^whisper-tiny\/[0-9a-f]{40}$/);
    expect(whisperModelId('base')).toMatch(/^whisper-base\/[0-9a-f]{40}$/);
    expect(vadModelId()).toMatch(/^silero-vad\/[0-9a-f]{40}$/);
    expect(ortPaths().mjs).toMatch(/^\/models\/ort\/1\.22\.0-dev\.20250409-89f8206ba4\/ort-wasm-simd-threaded\.jsep\.mjs$/);
    expect(ortPaths('https://x.test').wasm).toMatch(/^https:\/\/x\.test\/models\/ort\/.*\.jsep\.wasm$/);
  });

  it('knows the size of every file a model needs', () => {
    const sizes = modelFileSizes(whisperModelId('tiny'));
    expect(sizes.get('onnx/encoder_model_quantized.onnx')).toBeGreaterThan(1_000_000);
    expect(sizes.has('tokenizer.json')).toBe(true);
  });
});

describe('the progress line', () => {
  const id = whisperModelId('tiny');
  const sizes = modelFileSizes(id);
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);

  it('adds the files up against the whole model and never reaches 100% by itself', () => {
    const p = new ModelProgress(id);
    expect(p.update({ status: 'initiate', file: 'config.json' })).toBeNull();
    const enc = sizes.get('onnx/encoder_model_quantized.onnx')!;
    const half = p.update({ status: 'progress', file: 'onnx/encoder_model_quantized.onnx', loaded: enc / 2, total: enc })!;
    expect(half).toBeCloseTo(enc / 2 / total, 5);
    for (const [file] of sizes) p.update({ status: 'done', file });
    expect(p.fraction()).toBe(0.99);
  });

  it('does not go backwards when a file reports again, and ignores events without a file', () => {
    const p = new ModelProgress(id);
    expect(p.update({ status: 'progress' })).toBeNull();
    const a = p.update({ status: 'progress', file: 'tokenizer.json', loaded: 1000, total: 2480466 })!;
    const b = p.update({ status: 'progress', file: 'tokenizer.json', loaded: 2000, total: 2480466 })!;
    expect(b).toBeGreaterThan(a);
  });

  it('is written for the person', () => {
    expect(progressText({ stage: 'model', fraction: 0.404 })).toBe('Getting the speech model… 40%');
    expect(progressText({ stage: 'listening', fraction: 1.4 })).toBe('Writing it out… 100%');
  });
});

describe('the worker client', () => {
  it('starts a worker on the first clip only, sends a copy of the samples, and hands back the words', async () => {
    const { b, workers, firstUses } = backend();
    expect(workers).toHaveLength(0);
    const input = pcm();
    const done = b.transcribe('tiny', input, { language: 'bn' });
    await flush();
    expect(workers).toHaveLength(1);
    expect(firstUses()).toBe(1);
    const w = workers[0]!;
    expect(w.sent[0]).toMatchObject({ type: 'transcribe', id: 1, model: 'tiny', language: 'bn', device: 'auto' });
    expect(w.sent[0]!).toHaveProperty('samples');
    expect(Array.from((w.sent[0] as { samples: Float32Array }).samples)).toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(w.transferred[0]).toHaveLength(1);
    expect(input.samples).toHaveLength(3); // the caller's samples are still there
    w.say({ type: 'result', id: 1, transcript, stats });
    expect(await done).toEqual(transcript);
    expect(b.lastStats()).toEqual(stats);

    const again = b.transcribe('tiny', pcm(), {});
    await flush();
    expect(workers).toHaveLength(1);
    expect(firstUses()).toBe(1);
    workers[0]!.say({ type: 'result', id: 2, transcript, stats });
    await again;
  });

  it('does not send a language the caller did not give', async () => {
    const { b, workers } = backend();
    const p = b.transcribe('base', pcm(), {});
    await flush();
    expect('language' in workers[0]!.sent[0]!).toBe(false);
    workers[0]!.say({ type: 'result', id: 1, transcript, stats });
    await p;
  });

  it('passes progress on, kept between 0 and 1, and ignores messages for other jobs', async () => {
    const { b, workers } = backend();
    const seen: string[] = [];
    const p = b.transcribe('tiny', pcm(), { onProgress: (x) => seen.push(`${x.stage}:${x.fraction}`) });
    await flush();
    const w = workers[0]!;
    w.say({ type: 'progress', id: 1, stage: 'model', fraction: 0.4 });
    w.say({ type: 'progress', id: 99, stage: 'model', fraction: 0.9 });
    w.say({ type: 'progress', id: 1, stage: 'listening', fraction: 1.7 });
    w.onmessage?.({ data: 'noise' });
    w.say({ type: 'result', id: 1, transcript, stats });
    await p;
    expect(seen).toEqual(['model:0.4', 'listening:1']);
  });

  it('stops the worker when the person cancels, and the next clip starts a new one', async () => {
    const { b, workers } = backend();
    const ac = new AbortController();
    const p = b.transcribe('tiny', pcm(), { signal: ac.signal });
    await flush();
    const first = workers[0]!;
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(first.terminated).toBe(true);
    expect(b.running()).toBe(false);
    // a late answer from the stopped worker is ignored
    first.say({ type: 'result', id: 1, transcript, stats });

    const next = b.transcribe('tiny', pcm(), {});
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]!.say({ type: 'result', id: 2, transcript, stats });
    expect((await next).text).toBe('Hello there.');
  });

  it('refuses at once when the signal has already fired', async () => {
    const { b, workers } = backend();
    const ac = new AbortController();
    ac.abort();
    await expect(b.transcribe('tiny', pcm(), { signal: ac.signal })).rejects.toBeInstanceOf(SpeechError);
    expect(workers).toHaveLength(0);
  });

  it('says one plain sentence when the model cannot be had, another when the writing fails', async () => {
    const { b, workers } = backend();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = b.transcribe('tiny', pcm(), {});
    await flush();
    workers[0]!.say({ type: 'error', id: 1, code: 'failed', during: 'model', message: 'Failed to fetch' });
    await expect(first).rejects.toMatchObject({ code: 'unavailable', message: MODEL_FAILED });
    const second = b.transcribe('tiny', pcm(), {});
    await flush();
    workers[0]!.say({ type: 'error', id: 2, code: 'failed', during: 'work', message: 'out of memory' });
    await expect(second).rejects.toMatchObject({ code: 'unavailable', message: WRITE_FAILED });
    warn.mockRestore();
  });

  it('tells the waiting clip when the worker dies, and starts a fresh one for the next', async () => {
    const { b, workers } = backend();
    const p = b.transcribe('tiny', pcm(), {});
    await flush();
    workers[0]!.onerror?.(new Event('error'));
    await expect(p).rejects.toMatchObject({ code: 'unavailable' });
    expect(workers[0]!.terminated).toBe(true);
    const next = b.transcribe('tiny', pcm(), {});
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]!.say({ type: 'result', id: 2, transcript, stats });
    await next;
  });

  it('stops the worker after a minute without a clip, but not while one is being written', async () => {
    vi.useFakeTimers();
    expect(WORKER_IDLE_MS).toBe(60_000);
    const { b, workers } = backend();
    const p = b.transcribe('tiny', pcm(), {});
    await flush();
    vi.advanceTimersByTime(10 * WORKER_IDLE_MS);
    expect(workers[0]!.terminated).toBe(false); // busy: no idle timer is running
    workers[0]!.say({ type: 'result', id: 1, transcript, stats });
    await p;
    vi.advanceTimersByTime(WORKER_IDLE_MS - 1);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(b.running()).toBe(false);
  });

  it('a new clip within the minute keeps the worker and restarts the count', async () => {
    vi.useFakeTimers();
    const { b, workers } = backend();
    const p1 = b.transcribe('tiny', pcm(), {});
    await flush();
    workers[0]!.say({ type: 'result', id: 1, transcript, stats });
    await p1;
    vi.advanceTimersByTime(50_000);
    const p2 = b.transcribe('tiny', pcm(), {});
    await flush();
    workers[0]!.say({ type: 'result', id: 2, transcript, stats });
    await p2;
    vi.advanceTimersByTime(50_000);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('dispose stops the worker now', async () => {
    const { b, workers } = backend();
    const p = b.transcribe('tiny', pcm(), {});
    await flush();
    b.dispose();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('the model cache', () => {
  it('registers the service worker once, and never throws', async () => {
    const register = vi.fn(async () => ({}));
    registerModelCache({ serviceWorker: { register } });
    registerModelCache({ serviceWorker: { register } });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });
});
