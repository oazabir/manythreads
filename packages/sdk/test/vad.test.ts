import { describe, expect, it } from 'vitest';
import { VAD_CHUNK_MAX_MS, VAD_SILENCE_MS, createVadSegmenter } from '../src/index.ts';

// The server-side listener cuts a person's audio at pauses (PLAN P15-19, decision C14). The detector is pure: these tests feed it synthetic 16 kHz audio.

const RATE = 16_000;
const PAD = 240; // the quiet kept at each end of a chunk
const ms = (n: number): number => Math.round((n / 1000) * RATE);

/** `n` milliseconds of a steady tone at the given amplitude (RMS about amplitude / 1.41). */
function tone(n: number, amplitude = 6000): Int16Array {
  const out = new Int16Array(ms(n));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return out;
}
const quiet = (n: number): Int16Array => new Int16Array(ms(n));
function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('createVadSegmenter', () => {
  it('cuts speech at a pause of 600 ms or more and keeps a little quiet at each end', () => {
    const vad = createVadSegmenter();
    const chunks = vad.push(join(quiet(1000), tone(2000), quiet(VAD_SILENCE_MS + 100), tone(1500), quiet(900)));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.startMs).toBe(1000 - PAD);
    expect(chunks[0]!.durationMs).toBe(PAD + 2000 + PAD);
    expect(chunks[0]!.samples.length).toBe(ms(2000 + 2 * PAD));
    expect(chunks[1]!.durationMs).toBe(100 + 1500 + PAD); // only the 100 ms of quiet left after the first cut come before it
    expect(chunks[1]!.startMs).toBe(1000 + 2000 + VAD_SILENCE_MS);
    expect(vad.flush()).toEqual([]);
  });

  it('keeps a short pause inside one chunk', () => {
    const vad = createVadSegmenter();
    const chunks = vad.push(join(tone(1000), quiet(400), tone(1000), quiet(800)));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.durationMs).toBe(1000 + 400 + 1000 + PAD);
  });

  it('never makes a chunk longer than 30 seconds, and loses no speech at the cut', () => {
    const vad = createVadSegmenter();
    const chunks = [...vad.push(join(tone(75_000), quiet(900))), ...vad.flush()];
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.durationMs).toBeLessThanOrEqual(VAD_CHUNK_MAX_MS);
    const speechMs = chunks.reduce((a, c) => a + c.durationMs, 0) - PAD; // the quiet at the end of the last one
    expect(speechMs).toBe(75_000);
    expect(chunks[1]!.startMs).toBe(chunks[0]!.durationMs);
  });

  it('drops a click or a breath shorter than 250 ms of speech', () => {
    const vad = createVadSegmenter();
    expect(vad.push(join(quiet(500), tone(100), quiet(1500)))).toEqual([]);
    expect(vad.flush()).toEqual([]);
    expect(vad.push(join(tone(300), quiet(900)))).toHaveLength(1);
  });

  it('gives the same chunks however the audio is cut into pieces', () => {
    const audio = join(quiet(300), tone(1234), quiet(700), tone(2222), quiet(1000));
    const whole = createVadSegmenter().push(audio);
    for (const piece of [1, 7, 319, 321, 4096]) {
      const vad = createVadSegmenter();
      const got = [];
      for (let at = 0; at < audio.length; at += piece) got.push(...vad.push(audio.subarray(at, at + piece)));
      expect(got.map((c) => [c.startMs, c.durationMs])).toEqual(whole.map((c) => [c.startMs, c.durationMs]));
      expect(got[0]!.samples).toEqual(whole[0]!.samples);
    }
  });

  it('flush turns the speech still open into a last chunk', () => {
    const vad = createVadSegmenter();
    expect(vad.push(join(quiet(200), tone(1000)))).toEqual([]);
    const last = vad.flush();
    expect(last).toHaveLength(1);
    expect(last[0]!.durationMs).toBe(200 + 1000);
  });

  it('discard forgets what was heard: nothing of it comes out later', () => {
    const vad = createVadSegmenter();
    vad.push(join(quiet(100), tone(2000)));
    vad.discard();
    expect(vad.flush()).toEqual([]);
    expect(vad.push(quiet(2000))).toEqual([]);
  });

  it('uses the stream start the caller gives, and knows how far it has read', () => {
    const vad = createVadSegmenter({}, 5_000);
    const chunks = vad.push(join(tone(1000), quiet(800)));
    expect(chunks[0]!.startMs).toBe(5_000);
    expect(vad.positionMs()).toBe(5_000 + 1800);
  });

  it('honours its options: a lower silence, a higher threshold', () => {
    const fast = createVadSegmenter({ silenceMs: 200 });
    expect(fast.push(join(tone(1000), quiet(300), tone(1000), quiet(300)))).toHaveLength(2);
    const deaf = createVadSegmenter({ threshold: 20_000 });
    expect(deaf.push(join(tone(2000), quiet(900)))).toEqual([]);
  });

  it('takes a long run of silence and an empty push without growing or failing', () => {
    const vad = createVadSegmenter();
    for (let i = 0; i < 600; i++) expect(vad.push(quiet(1000))).toEqual([]);
    expect(vad.push(new Int16Array(0))).toEqual([]);
    expect(vad.positionMs()).toBe(600_000);
  });
});
