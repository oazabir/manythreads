/*
 * Turns a recorded clip (a Blob from MediaRecorder: WebM, Ogg or MP4 with Opus or AAC inside) into mono 16 kHz samples.
 * The browser's own decoder does the hard part; the context is injectable so tests can stand in for it.
 */
import { SpeechError, type PcmAudio } from './types';
import { SPEECH_SAMPLE_RATE, durationMs, toSpeechAudio } from './resample';

/** The slice of AudioContext this file uses. */
export interface DecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<DecodedBuffer>;
  close?(): Promise<void>;
}

export interface DecodedBuffer {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export type DecodeContextFactory = () => DecodeContext;

const DECODE_FAILED = 'This recording could not be read.';

export const browserDecodeContext: DecodeContextFactory = () => {
  const w = globalThis as unknown as { AudioContext?: new () => DecodeContext; webkitAudioContext?: new () => DecodeContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new SpeechError('unavailable', "This browser can't read audio recordings.");
  return new Ctor();
};

/** Decodes a clip and brings it to mono at 16 kHz. Rejects with a SpeechError ('decode') when the bytes are not audio. */
export async function decodeToSpeechAudio(blob: Blob, makeContext: DecodeContextFactory = browserDecodeContext): Promise<PcmAudio> {
  const ctx = makeContext();
  try {
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength === 0) throw new SpeechError('decode', DECODE_FAILED);
    let buf: DecodedBuffer;
    try {
      buf = await ctx.decodeAudioData(bytes);
    } catch {
      throw new SpeechError('decode', DECODE_FAILED);
    }
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    return { samples: toSpeechAudio(channels, buf.sampleRate), sampleRate: SPEECH_SAMPLE_RATE };
  } finally {
    void ctx.close?.().catch(() => undefined);
  }
}

/** The length of a clip in milliseconds, read by decoding it. */
export async function clipDurationMs(blob: Blob, makeContext?: DecodeContextFactory): Promise<number> {
  const pcm = await decodeToSpeechAudio(blob, makeContext);
  return durationMs(pcm.samples.length, pcm.sampleRate);
}
