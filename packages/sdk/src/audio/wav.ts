// WAV helpers for the voice-room transcriber (PLAN P15-07, P15-19; docs/plugins/meetings.md "Bundle C contracts"). Pure functions over bytes, no Node imports, so the
// browser, the server and the listener's worker thread share them. The only audio format between the parts is one 16 kHz, mono, 16-bit little-endian PCM WAV.

export const WAV_SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;

/** Wrap 16 kHz mono 16-bit PCM samples in a WAV file. */
export function encodeWav16kMono(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(HEADER_BYTES + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, WAV_SAMPLE_RATE, true);
  v.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(HEADER_BYTES + i * 2, samples[i]!, true);
  return out;
}

export type WavInfo = { ok: true; sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataBytes: number; durationMs: number } | { ok: false; reason: string };

/** Read a canonical WAV header (a `fmt ` chunk then a `data` chunk). Never throws; `ok: false` says why the bytes are not the one format accepted. */
export function readWavInfo(bytes: Uint8Array): WavInfo {
  if (bytes.length < HEADER_BYTES) return { ok: false, reason: 'The audio is too short to be a WAV file.' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, reason: 'The audio is not a WAV file.' };
  let at = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 8 + 16 <= bytes.length) {
      fmt = { format: v.getUint16(at + 8, true), channels: v.getUint16(at + 10, true), sampleRate: v.getUint32(at + 12, true), bits: v.getUint16(at + 22, true) };
    } else if (id === 'data') {
      if (!fmt) return { ok: false, reason: 'The WAV file has no format chunk.' };
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.sampleRate !== WAV_SAMPLE_RATE) {
        return { ok: false, reason: 'The audio must be 16 kHz, mono, 16-bit WAV.' };
      }
      const dataBytes = Math.min(size, bytes.length - (at + 8));
      return { ok: true, sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataOffset: at + 8, dataBytes, durationMs: Math.round((dataBytes / 2 / WAV_SAMPLE_RATE) * 1000) };
    }
    at += 8 + size + (size % 2);
  }
  return { ok: false, reason: 'The WAV file has no audio data.' };
}

/** The marker the fake transcriber looks for in a WAV's data (`MANYTHREADS_FAKE_ASR=1`): the text after it is what the "speaker" said. */
export const FAKE_ASR_MARKER = 'FAKEASR:';

/** A test WAV whose data carries `FAKEASR:<text>` (padded with silence to `durationMs`). The fake transcriber answers `<text>`; the real one hears silence. */
export function makeFakeAsrWav(text: string, durationMs = 1000): Uint8Array {
  const payload = new TextEncoder().encode(`${FAKE_ASR_MARKER}${text}`);
  const samples = new Int16Array(Math.max(Math.ceil(payload.length / 2), Math.round((durationMs / 1000) * WAV_SAMPLE_RATE)));
  const bytes = new Uint8Array(samples.buffer);
  bytes.set(payload, 0);
  return encodeWav16kMono(samples);
}

/** What the fake transcriber hears in a WAV: the text after the marker, else the empty string. */
export function readFakeAsrText(wav: Uint8Array): string {
  const info = readWavInfo(wav);
  if (!info.ok) return '';
  const data = wav.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const text = new TextDecoder().decode(data);
  const i = text.indexOf(FAKE_ASR_MARKER);
  if (i < 0) return '';
  const end = text.indexOf('\u0000', i);
  return text.slice(i + FAKE_ASR_MARKER.length, end < 0 ? undefined : end);
}
