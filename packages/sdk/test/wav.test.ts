import { describe, expect, it } from 'vitest';
import { WAV_SAMPLE_RATE, encodeWav16kMono, makeFakeAsrWav, readFakeAsrText, readWavInfo } from '../src/index.ts';

// The one audio format between the browser, the upload route and the transcriber: 16 kHz, mono, 16-bit WAV.
describe('WAV helpers', () => {
  it('writes a canonical header and reads it back with the length in milliseconds', () => {
    const wav = encodeWav16kMono(new Int16Array(WAV_SAMPLE_RATE * 2));
    expect(wav.length).toBe(44 + WAV_SAMPLE_RATE * 4);
    expect(readWavInfo(wav)).toMatchObject({ ok: true, sampleRate: 16000, channels: 1, bitsPerSample: 16, dataOffset: 44, durationMs: 2000 });
  });
  it('refuses what is not that one format, without throwing', () => {
    expect(readWavInfo(new Uint8Array(10))).toMatchObject({ ok: false });
    expect(readWavInfo(new Uint8Array(100))).toMatchObject({ ok: false });
    const stereo = encodeWav16kMono(new Int16Array(100));
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(readWavInfo(stereo)).toMatchObject({ ok: false, reason: expect.stringContaining('16 kHz') });
    const cut = encodeWav16kMono(new Int16Array(1000)).subarray(0, 300);
    expect(readWavInfo(cut)).toMatchObject({ ok: true, dataBytes: 256 });
  });
  it('a fake-ASR file says what its "speaker" said, and a plain one says nothing', () => {
    expect(readFakeAsrText(makeFakeAsrWav('ship it on friday'))).toBe('ship it on friday');
    expect(readWavInfo(makeFakeAsrWav('x', 3000))).toMatchObject({ ok: true, durationMs: 3000 });
    expect(readFakeAsrText(encodeWav16kMono(new Int16Array(500)))).toBe('');
    expect(readFakeAsrText(new Uint8Array(3))).toBe('');
  });
});
