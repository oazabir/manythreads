import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_TABLE, TOO_WEAK_REASON, chooseModel, hasSpeechPlatform, readDeviceFacts, type DeviceFacts } from '../src/speech/device';
import { NO_BACKEND_REASON, NO_PLATFORM_REASON, chooseSpeechEngine, getSpeechEngine, registerWhisperBackend, resetSpeechEngine } from '../src/speech/engine';
import { SpeechError, type WhisperBackend } from '../src/speech/types';
import type { DecodeContextFactory } from '../src/speech/decode';

const facts = (over: Partial<DeviceFacts> = {}): DeviceFacts => ({ webgpu: false, memoryGb: 8, cores: 8, phone: false, ...over });

afterEach(() => {
  vi.unstubAllEnvs();
  registerWhisperBackend(null);
  resetSpeechEngine();
});

describe('chooseModel', () => {
  it('gives the larger model to a graphics-adapter laptop with enough memory', () => {
    expect(chooseModel(facts({ webgpu: true, memoryGb: 8 })).model).toBe('base');
    expect(chooseModel(facts({ webgpu: true, memoryGb: DEVICE_TABLE.baseMinMemoryGb })).model).toBe('base');
  });
  it('gives the smaller model when there is no adapter or the memory is short or unknown', () => {
    expect(chooseModel(facts({ webgpu: false })).model).toBe('tiny');
    expect(chooseModel(facts({ webgpu: true, memoryGb: 2 })).model).toBe('tiny');
    expect(chooseModel(facts({ webgpu: true, memoryGb: null })).model).toBe('tiny');
  });
  it('caps a phone at the smaller model', () => {
    expect(chooseModel(facts({ webgpu: true, memoryGb: 8, phone: true })).model).toBe('tiny');
  });
  it('treats unknown memory as fine for the smaller model', () => {
    expect(chooseModel(facts({ memoryGb: null, cores: 4 })).model).toBe('tiny');
  });
  it('calls a device too weak with a plain sentence', () => {
    for (const f of [facts({ cores: 2 }), facts({ memoryGb: 1 }), facts({ cores: 1, memoryGb: null })]) {
      expect(chooseModel(f)).toEqual({ model: null, reason: TOO_WEAK_REASON });
    }
    expect(TOO_WEAK_REASON).toBe('This device is too slow to write out voice messages.');
  });
});

describe('readDeviceFacts', () => {
  it('reads memory, cores, the adapter and a phone-sized touch screen', async () => {
    const f = await readDeviceFacts({
      navigator: { deviceMemory: 4, hardwareConcurrency: 8, gpu: { requestAdapter: async () => ({}) } },
      innerWidth: 390,
      matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }),
    });
    expect(f).toEqual({ webgpu: true, memoryGb: 4, cores: 8, phone: true });
  });
  it('is not a phone on a wide screen or with a mouse', async () => {
    const coarse = (): { matches: boolean } => ({ matches: true });
    expect((await readDeviceFacts({ navigator: {}, innerWidth: 1200, matchMedia: coarse })).phone).toBe(false);
    expect((await readDeviceFacts({ navigator: {}, innerWidth: 390, matchMedia: () => ({ matches: false }) })).phone).toBe(false);
  });
  it('survives a missing or failing adapter and missing hints', async () => {
    const f = await readDeviceFacts({ navigator: { gpu: { requestAdapter: async () => { throw new Error('no'); } } } });
    expect(f).toEqual({ webgpu: false, memoryGb: null, cores: 1, phone: false });
    expect((await readDeviceFacts({ navigator: { gpu: { requestAdapter: async () => null } } })).webgpu).toBe(false);
    expect((await readDeviceFacts({})).webgpu).toBe(false);
  });
});

describe('hasSpeechPlatform', () => {
  it('needs a Worker and an audio context', () => {
    expect(hasSpeechPlatform({})).toBe(false);
    expect(hasSpeechPlatform({ Worker: class {} })).toBe(false);
    expect(hasSpeechPlatform({ Worker: class {}, AudioContext: class {} })).toBe(true);
    expect(hasSpeechPlatform({ Worker: class {}, webkitAudioContext: class {} })).toBe(true);
  });
});

describe('chooseSpeechEngine', () => {
  const backend: WhisperBackend = {
    transcribe: async (model) => ({ segments: [{ text: model, startMs: 0, endMs: 10 }], text: model, language: 'en' }),
  };
  const ctx: DecodeContextFactory = () => ({
    decodeAudioData: async () => ({ numberOfChannels: 1, sampleRate: 16000, length: 16000, getChannelData: () => new Float32Array(16000) }),
  });

  it('says none, with a reason, when the browser lacks the pieces', async () => {
    const e = await chooseSpeechEngine({ platform: false });
    expect(e).toMatchObject({ kind: 'none', model: null, reason: NO_PLATFORM_REASON });
    await expect(e.transcribe(new Blob([]))).rejects.toMatchObject({ code: 'unavailable', message: NO_PLATFORM_REASON });
  });
  it('says none with the too-slow sentence on a weak device', async () => {
    const e = await chooseSpeechEngine({ platform: true, facts: facts({ cores: 2 }) });
    expect(e).toMatchObject({ kind: 'none', reason: TOO_WEAK_REASON });
  });
  it('says none until the worker is registered, then whisper with the chosen model', async () => {
    expect(await chooseSpeechEngine({ platform: true, facts: facts() })).toMatchObject({ kind: 'none', reason: NO_BACKEND_REASON });
    registerWhisperBackend(backend);
    const e = await chooseSpeechEngine({ platform: true, facts: facts({ webgpu: true }), makeContext: ctx });
    expect(e).toMatchObject({ kind: 'whisper', model: 'base' });
    const t = await e.transcribe(new Blob([new Uint8Array(4)]));
    expect(t.text).toBe('base');
  });
  it('refuses to start when the signal has already fired', async () => {
    registerWhisperBackend(backend);
    const e = await chooseSpeechEngine({ platform: true, facts: facts(), makeContext: ctx });
    const err = await e.transcribe(new Blob([new Uint8Array(4)]), { signal: AbortSignal.abort() }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SpeechError);
    expect((err as SpeechError).code).toBe('aborted');
  });
  it('uses the fake engine whenever the test switch is on, and checks only once', async () => {
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '1');
    const a = await getSpeechEngine();
    expect(a.kind).toBe('fake');
    expect(await getSpeechEngine()).toBe(a);
  });
});
