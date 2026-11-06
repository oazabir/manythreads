import { describe, expect, it } from 'vitest';
import { VAD_FRAME, VAD_SAMPLE_RATE, VAD_SETTINGS, createSileroRunner, fixedWindows, planWindows, speechRegions, windowsMs, type VadLibrary } from '../src/speech/vad';
import { dominantLanguage, languageFromLogits, languageTokenMap, segmentsFromChunks } from '../src/speech/whisper';

const FRAMES_PER_SECOND = VAD_SAMPLE_RATE / VAD_FRAME; // 31.25
const sec = (s: number): number => Math.round(s * VAD_SAMPLE_RATE);
/** Probabilities for a clip: runs of [seconds, probability]. */
const probs = (...runs: [number, number][]): Float32Array => {
  const out: number[] = [];
  for (const [s, p] of runs) for (let i = 0; i < Math.round(s * FRAMES_PER_SECOND); i++) out.push(p);
  return Float32Array.from(out);
};

describe('speechRegions', () => {
  it('finds one stretch of speech with room around it', () => {
    const p = probs([2, 0.02], [3, 0.9], [2, 0.02]);
    const r = speechRegions(p, sec(7));
    expect(r).toHaveLength(1);
    expect(r[0]!.start).toBeCloseTo(sec(2 - 0.2), -3);
    expect(r[0]!.end).toBeCloseTo(sec(5 + 0.2), -3);
  });

  it('keeps one stretch through a short pause and splits at a long one', () => {
    const short = speechRegions(probs([1, 0.9], [0.3, 0.05], [1, 0.9]), sec(2.3));
    expect(short).toHaveLength(1);
    const long = speechRegions(probs([1, 0.9], [3, 0.05], [1, 0.9]), sec(5));
    expect(long).toHaveLength(2);
  });

  it('holds on to speech while the numbers sit between the two thresholds', () => {
    const p = probs([1, 0.9], [2, 0.4], [1, 0.9], [2, 0.01]);
    expect(speechRegions(p, sec(6))).toHaveLength(1);
  });

  it('drops a click and finds nothing in silence', () => {
    expect(speechRegions(probs([2, 0.01], [0.1, 0.95], [2, 0.01]), sec(4.1))).toEqual([]);
    expect(speechRegions(probs([5, 0.01]), sec(5))).toEqual([]);
    expect(speechRegions(new Float32Array(0), 0)).toEqual([]);
  });

  it('stays inside the clip when speech touches its ends', () => {
    const r = speechRegions(probs([3, 0.9]), sec(3));
    expect(r[0]!.start).toBe(0);
    expect(r[0]!.end).toBeLessThanOrEqual(sec(3));
  });
});

describe('planWindows', () => {
  const r = (a: number, b: number) => ({ start: sec(a), end: sec(b) });

  it('keeps a short clip as one window', () => {
    expect(planWindows([r(1, 4), r(5, 9)])).toEqual([r(1, 9)]);
  });

  it('starts a new window at a long silence, dropping the silence', () => {
    expect(planWindows([r(1, 4), r(12, 15)])).toEqual([r(1, 4), r(12, 15)]);
  });

  it('never makes a window longer than the limit, cutting at a pause between stretches', () => {
    const w = planWindows([r(0, 10), r(11, 20), r(21, 30), r(31, 40)]);
    for (const x of w) expect(x.end - x.start).toBeLessThanOrEqual(sec(VAD_SETTINGS.maxWindowMs / 1000));
    expect(w).toEqual([r(0, 20), r(21, 40)]);
  });

  it('cuts one very long stretch into equal pieces that together cover it', () => {
    const w = planWindows([r(0, 70)]);
    expect(w).toHaveLength(3);
    expect(w[0]!.start).toBe(0);
    expect(w.at(-1)!.end).toBe(sec(70));
    for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBe(w[i - 1]!.end);
    for (const x of w) expect(x.end - x.start).toBeLessThanOrEqual(sec(28));
  });

  it('has nothing to do for no speech', () => {
    expect(planWindows([])).toEqual([]);
    expect(fixedWindows(0)).toEqual([]);
  });

  it('fixedWindows covers a whole clip when the speech finder is missing', () => {
    const w = fixedWindows(sec(65));
    expect(w[0]!.start).toBe(0);
    expect(w.at(-1)!.end).toBe(sec(65));
    expect(windowsMs(w)).toBe(65_000);
  });
});

describe('createSileroRunner', () => {
  it('feeds the model one frame at a time with the end of the one before, and carries its state', async () => {
    const calls: { input: Float32Array; state: unknown }[] = [];
    class Tensor {
      constructor(
        public type: string,
        public data: ArrayLike<number | bigint>,
        public dims: number[],
      ) {}
    }
    let n = 0;
    const lib: VadLibrary = {
      Tensor: Tensor as unknown as VadLibrary['Tensor'],
      AutoModel: {
        async from_pretrained(id, options) {
          expect(id).toMatch(/^silero-vad\/[0-9a-f]{40}$/);
          expect(options).toMatchObject({ dtype: 'fp32', device: 'wasm' });
          return async (inputs) => {
            const t = inputs['input'] as Tensor;
            calls.push({ input: Float32Array.from(t.data as Float32Array), state: inputs['state'] });
            n++;
            return { output: { data: Float32Array.of(n / 10) }, stateN: new Tensor('float32', [n], [1]) };
          };
        },
      },
    };
    const runner = await createSileroRunner(lib);
    const samples = Float32Array.from({ length: VAD_FRAME * 2 + 100 }, (_, i) => i + 1);
    const p = await runner.probabilities(samples);
    expect(Array.from(p)).toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(calls[0]!.input).toHaveLength(576);
    expect(calls[0]!.input.slice(0, 64).every((x) => x === 0)).toBe(true);
    expect(calls[0]!.input[64]).toBe(1);
    expect(calls[1]!.input[0]).toBe(VAD_FRAME - 63); // the last 64 samples of the first frame
    expect(calls[1]!.input[64]).toBe(VAD_FRAME + 1);
    expect(calls[2]!.input[64 + 99]).toBe(VAD_FRAME * 2 + 100);
    expect(calls[2]!.input[64 + 100]).toBe(0); // the short last frame is padded with silence
    expect((calls[2]!.state as Tensor).data).toEqual([2]);
  });
});

describe('what Whisper hands back', () => {
  it('turns chunk times into milliseconds from the start of the clip', () => {
    const s = segmentsFromChunks(
      [
        { text: ' Hello there. ', timestamp: [0, 1.5] },
        { text: '   ', timestamp: [1.5, 2] },
        { text: 'Last one', timestamp: [2, null] },
      ],
      10_000,
      14_000,
    );
    expect(s).toEqual([
      { text: 'Hello there.', startMs: 10_000, endMs: 11_500 },
      { text: 'Last one', startMs: 12_000, endMs: 14_000 },
    ]);
  });

  it('keeps segments inside their window', () => {
    const [x] = segmentsFromChunks([{ text: 'x', timestamp: [29.9, 31] }], 0, 30_000);
    expect(x).toEqual({ text: 'x', startMs: 29_900, endMs: 30_000 });
  });

  it('picks the language with the highest score among the language tokens only', () => {
    const ids = languageTokenMap({ '<|en|>': 2, '<|bn|>': 3, '<|haw|>': 4, '<|notimestamps|>': 1, '<|transcribe|>': 0 });
    expect([...ids.values()].sort()).toEqual(['bn', 'en', 'haw']);
    expect(languageFromLogits([99, 99, 0.1, 0.9, 0.2], ids)).toBe('bn');
    expect(languageFromLogits([0, 0], new Map())).toBeNull();
  });

  it('names the language most of the speech is in', () => {
    expect(dominantLanguage([{ language: 'en', ms: 1000 }, { language: 'bn', ms: 5000 }, { language: null, ms: 9000 }])).toBe('bn');
    expect(dominantLanguage([])).toBeNull();
  });
});
