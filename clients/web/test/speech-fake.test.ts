import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineAvailable } from '../src/meetings/engine';
import { FAKE_TEXT, createFakeEngine, fakeAsrEnabled, fakeTranscript } from '../src/speech/fake';
import type { DecodeContextFactory } from '../src/speech/decode';

afterEach(() => vi.unstubAllEnvs());

const clip = (seconds: number): DecodeContextFactory => () => ({
  decodeAudioData: async () => ({ numberOfChannels: 1, sampleRate: 16000, length: 16000 * seconds, getChannelData: () => new Float32Array(16000 * seconds) }),
});

describe('fakeTranscript', () => {
  it('says the known sentence, in segments that cover the whole clip with no gaps', () => {
    const t = fakeTranscript(4200);
    expect(t.text).toBe(FAKE_TEXT);
    expect(t.text).toBe('This is a test voice message.');
    expect(t.language).toBe('en');
    expect(t.segments.map((s) => s.text).join(' ')).toBe(FAKE_TEXT);
    expect(t.segments[0]!.startMs).toBe(0);
    expect(t.segments.at(-1)!.endMs).toBe(4200);
    for (let i = 1; i < t.segments.length; i++) expect(t.segments[i]!.startMs).toBe(t.segments[i - 1]!.endMs);
    for (const s of t.segments) expect(s.endMs).toBeGreaterThan(s.startMs);
  });
});

describe('the fake engine', () => {
  it('reads the length of the clip and spreads the words over it', async () => {
    const e = createFakeEngine(clip(5));
    expect(e).toMatchObject({ kind: 'fake', model: 'fake' });
    const progress: number[] = [];
    const t = await e.transcribe(new Blob([new Uint8Array(8)]), { onProgress: (p) => progress.push(p.fraction) });
    expect(t.text).toBe(FAKE_TEXT);
    expect(t.segments.at(-1)!.endMs).toBe(5000);
    expect(progress).toEqual([0, 1]);
  });
  it('still answers when the clip cannot be decoded here', async () => {
    const e = createFakeEngine(() => ({ decodeAudioData: async () => { throw new Error('no'); } }));
    const t = await e.transcribe(new Blob([new Uint8Array(8)]));
    expect(t.text).toBe(FAKE_TEXT);
    expect(t.segments.at(-1)!.endMs).toBe(3000);
  });
  it('keeps a language the caller forces', async () => {
    const t = await createFakeEngine(clip(2)).transcribe(new Blob([new Uint8Array(8)]), { language: 'bn' });
    expect(t.language).toBe('bn');
  });
  it('stops when cancelled', async () => {
    await expect(createFakeEngine(clip(2)).transcribe(new Blob([new Uint8Array(8)]), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('the one switch', () => {
  it('is off by default and on with VITE_MANYTHREADS_FAKE_ASR=1; the call dock reads the same switch', () => {
    expect(fakeAsrEnabled()).toBe(false);
    expect(engineAvailable()).toBe(false);
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '1');
    expect(fakeAsrEnabled()).toBe(true);
    expect(engineAvailable()).toBe(true);
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '0');
    expect(engineAvailable()).toBe(false);
  });
});
