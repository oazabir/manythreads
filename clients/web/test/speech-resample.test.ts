import { describe, expect, it } from 'vitest';
import { SPEECH_SAMPLE_RATE, downmixToMono, durationMs, resample, toSpeechAudio } from '../src/speech/resample';
import { decodeToSpeechAudio, type DecodeContext } from '../src/speech/decode';
import { SpeechError } from '../src/speech/types';

const sine = (hz: number, rate: number, seconds: number): Float32Array => {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / (a.length || 1));

describe('downmixToMono', () => {
  it('returns a single channel unchanged', () => {
    const a = Float32Array.of(1, 2, 3);
    expect(downmixToMono([a])).toBe(a);
  });
  it('averages two channels sample by sample', () => {
    expect(Array.from(downmixToMono([Float32Array.of(1, 0.5, 0), Float32Array.of(0, 0.5, -1)]))).toEqual([0.5, 0.5, -0.5]);
  });
  it('is empty for no channels', () => {
    expect(downmixToMono([]).length).toBe(0);
  });
});

describe('resample', () => {
  it('keeps the audio when the rate already matches', () => {
    const a = sine(440, 16000, 0.1);
    expect(resample(a, 16000, 16000)).toBe(a);
  });
  it('gives the right length when going from 48 kHz and 44.1 kHz down', () => {
    expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
    expect(resample(new Float32Array(44100), 44100).length).toBe(16000);
    expect(resample(new Float32Array(24000 * 3), 24000).length).toBe(48000);
  });
  it('keeps a tone inside the speech band at about the same strength', () => {
    const out = resample(sine(440, 48000, 1), 48000);
    expect(rms(out)).toBeGreaterThan(0.68);
    expect(rms(out)).toBeLessThan(0.73);
  });
  it('removes a tone above the new Nyquist limit instead of folding it back', () => {
    const out = resample(sine(20000, 48000, 1), 48000);
    expect(rms(out)).toBeLessThan(0.2);
  });
  it('interpolates when going up', () => {
    expect(Array.from(resample(Float32Array.of(0, 1), 8000, 16000))).toEqual([0, 0.5, 1, 1]);
  });
  it('handles empty input and refuses a bad rate', () => {
    expect(resample(new Float32Array(0), 48000).length).toBe(0);
    expect(() => resample(Float32Array.of(1), 0)).toThrow(RangeError);
  });
  it('stays linear in the clip length (five minutes of 48 kHz audio)', () => {
    const big = new Float32Array(48000 * 300);
    const t = performance.now();
    expect(resample(big, 48000).length).toBe(16000 * 300);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('toSpeechAudio and durationMs', () => {
  it('folds stereo and resamples in one step', () => {
    const l = sine(300, 32000, 1);
    const out = toSpeechAudio([l, l], 32000);
    expect(out.length).toBe(SPEECH_SAMPLE_RATE);
  });
  it('reports durations in whole milliseconds', () => {
    expect(durationMs(24000, 16000)).toBe(1500);
  });
});

describe('decodeToSpeechAudio', () => {
  const ctx = (buf: { sampleRate: number; chans: Float32Array[] } | Error, closed: string[] = []): (() => DecodeContext) => () => ({
    async decodeAudioData() {
      if (buf instanceof Error) throw buf;
      return { numberOfChannels: buf.chans.length, sampleRate: buf.sampleRate, length: buf.chans[0]!.length, getChannelData: (c: number) => buf.chans[c]! };
    },
    async close() {
      closed.push('closed');
    },
  });

  it('decodes to mono 16 kHz and closes the context', async () => {
    const closed: string[] = [];
    const chans = [new Float32Array(48000), new Float32Array(48000)];
    const pcm = await decodeToSpeechAudio(new Blob([new Uint8Array(10)]), ctx({ sampleRate: 48000, chans }, closed));
    expect(pcm.sampleRate).toBe(16000);
    expect(pcm.samples.length).toBe(16000);
    expect(closed).toEqual(['closed']);
  });
  it('says plainly when the bytes are not audio', async () => {
    const err = await decodeToSpeechAudio(new Blob([new Uint8Array(10)]), ctx(new Error('EncodingError'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechError);
    expect((err as SpeechError).code).toBe('decode');
    expect((err as SpeechError).message).toBe('This recording could not be read.');
  });
  it('rejects an empty clip', async () => {
    await expect(decodeToSpeechAudio(new Blob([]), ctx({ sampleRate: 16000, chans: [new Float32Array(1)] }))).rejects.toMatchObject({ code: 'decode' });
  });
});
