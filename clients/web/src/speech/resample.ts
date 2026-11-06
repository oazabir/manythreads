/*
 * Pure audio maths for the speech engine: fold channels into one and bring any sample rate to the 16,000 a second that speech models take.
 * Everything here is linear in the length of the clip and touches no browser API, so it is unit-tested in plain Node.
 */

export const SPEECH_SAMPLE_RATE = 16_000;

/** Averages the channels sample by sample. One channel is returned as is (not copied). */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const n = first.length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    const m = Math.min(n, ch.length);
    for (let i = 0; i < m; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0);
  }
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) * k;
  return out;
}

/**
 * Changes the sample rate. Going down averages every input sample that falls inside an output sample's span (a box filter, which keeps
 * high pitches from folding back as noise); going up interpolates between neighbours.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number = SPEECH_SAMPLE_RATE): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('Sample rates must be positive.');
  if (input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate; // input samples per output sample
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const start = i * ratio;
      const end = Math.min(input.length, start + ratio);
      let sum = 0;
      let weight = 0;
      for (let j = Math.floor(start); j < end; j++) {
        const lo = Math.max(j, start);
        const hi = Math.min(j + 1, end);
        const w = hi - lo;
        if (w <= 0) continue;
        sum += (input[j] ?? 0) * w;
        weight += w;
      }
      out[i] = weight > 0 ? sum / weight : 0;
    }
  } else {
    const last = input.length - 1;
    for (let i = 0; i < outLen; i++) {
      const pos = Math.min(last, i * ratio);
      const j = Math.floor(pos);
      const frac = pos - j;
      const a = input[j] ?? 0;
      const b = input[Math.min(last, j + 1)] ?? a;
      out[i] = a + (b - a) * frac;
    }
  }
  return out;
}

/** Mono at 16 kHz from channels at any rate: what a model is fed. */
export function toSpeechAudio(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  return resample(downmixToMono(channels), sampleRate, SPEECH_SAMPLE_RATE);
}

/** How long samples at a rate last, in whole milliseconds. */
export function durationMs(sampleCount: number, sampleRate: number): number {
  return Math.round((sampleCount / sampleRate) * 1000);
}
