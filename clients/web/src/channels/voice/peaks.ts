/**
 * The loudness bars of a voice message (P14-17). While recording, the level is read about twelve times a second (0 to 1); when the
 * recording ends those readings are folded into at most 64 bars of 0 to 255, loudest bar = 255, which is what the message keeps in
 * `meta.voice.peaks` and what the player draws.
 */

export const PEAK_BARS = 64;

/** The loudness of one slice of sound: the largest distance from silence, 0 to 1. `data` is what an AnalyserNode gives (bytes, 128 = silence). */
export function levelOf(data: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const d = Math.abs((data[i] ?? 128) - 128);
    if (d > peak) peak = d;
  }
  return Math.min(1, peak / 128);
}

/** Folds readings (0 to 1) into at most `bars` whole numbers 0 to 255: the loudest reading in each stretch, then scaled so the loudest bar is 255. */
export function reducePeaks(levels: readonly number[], bars: number = PEAK_BARS): number[] {
  const n = Math.min(bars, levels.length);
  if (n <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * levels.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n));
    let top = 0;
    for (let j = from; j < to; j++) top = Math.max(top, Number.isFinite(levels[j]) ? (levels[j] as number) : 0);
    out.push(Math.max(0, top));
  }
  const max = Math.max(...out);
  if (max <= 0) return out.map(() => 0);
  return out.map((v) => Math.min(255, Math.round((v / max) * 255)));
}
