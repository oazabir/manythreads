import { describe, expect, it } from 'vitest';
import { SpeechError } from '../src/speech/types';
import { TOO_SLOW_MESSAGE, createLiveTranscriber, encodeWav16, type PcmSource, type Recognizer, type RecognizeResult, type StreamLine, type StreamStatus } from '../src/speech/stream';
import { STREAM_SETTINGS, createEnergyClassifier, createStreamingSegmenter, type StreamChunk } from '../src/speech/vad';

// P15-06: cutting a microphone into chunks, and the live transcriber on top of it (a partial line a second, a final per chunk).

const RATE = 16_000;
const samplesOf = (ms: number): number => Math.round((ms * RATE) / 1000);
/** A tone loud enough to be speech. */
const talk = (ms: number): Float32Array => Float32Array.from({ length: samplesOf(ms) }, (_v, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / RATE));
/** Speech with its breaths: a half second of voice, a short gap, again (a steady tone would be learned as a hum, as it should be). */
function babble(ms: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let at = 0; at < ms; at += 560) parts.push(talk(Math.min(500, ms - at)), hush(Math.min(60, Math.max(0, ms - at - 500))));
  return join(...parts);
}
const hush = (ms: number): Float32Array => new Float32Array(samplesOf(ms));
const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const ms = (n: number): number => (n * 1000) / RATE;

function collect(settings?: Parameters<typeof createStreamingSegmenter>[0]['settings']) {
  const chunks: StreamChunk[] = [];
  const seg = createStreamingSegmenter({ onChunk: (c) => chunks.push(c), ...(settings ? { settings } : {}) });
  return { chunks, seg };
}

describe('the energy classifier', () => {
  it('tells a voice from a quiet room, and learns a steady hum as quiet', () => {
    const isSpeech = createEnergyClassifier();
    const frame = (amp: number): Float32Array => Float32Array.from({ length: 320 }, (_v, i) => amp * Math.sin(i));
    expect(isSpeech(frame(0))).toBe(false);
    expect(isSpeech(frame(0.2))).toBe(true);
    expect(isSpeech(frame(0.001))).toBe(false);
  });
});

describe('the streaming segmenter', () => {
  it('cuts one stretch of speech at 600 ms of quiet, with a little room each side', () => {
    const { chunks, seg } = collect();
    seg.push(join(hush(1000), talk(2000), hush(1000)));
    expect(chunks).toHaveLength(1);
    const c = chunks[0]!;
    expect(ms(c.startSample)).toBeGreaterThan(1000 - 300);
    expect(ms(c.startSample)).toBeLessThanOrEqual(1000);
    expect(ms(c.endSample)).toBeGreaterThanOrEqual(3000);
    expect(ms(c.endSample)).toBeLessThan(3000 + 300);
    expect(c.samples.length).toBe(c.endSample - c.startSample);
  });

  it('keeps one chunk through a short breath and splits at a long pause', () => {
    const a = collect();
    a.seg.push(join(talk(1000), hush(300), talk(1000), hush(1000)));
    expect(a.chunks).toHaveLength(1);
    const b = collect();
    b.seg.push(join(talk(1000), hush(800), talk(1000), hush(1000)));
    expect(b.chunks).toHaveLength(2);
    expect(b.chunks[1]!.id).toBeGreaterThan(b.chunks[0]!.id);
    expect(b.chunks[1]!.startSample).toBeGreaterThan(b.chunks[0]!.endSample);
  });

  it('throws away a click', () => {
    const { chunks, seg } = collect();
    seg.push(join(hush(500), talk(100), hush(1500)));
    expect(chunks).toHaveLength(0);
  });

  it('never makes a chunk longer than 28 seconds, and loses no speech', () => {
    const { chunks, seg } = collect();
    seg.push(join(babble(70_000), hush(1000)));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(ms(c.samples.length)).toBeLessThanOrEqual(STREAM_SETTINGS.maxChunkMs + 20);
    const covered = chunks.reduce((n, c) => n + c.samples.length, 0);
    expect(ms(covered)).toBeGreaterThan(69_000);
  });

  it('cuts a long talker at a short breath after 20 seconds', () => {
    const { chunks, seg } = collect();
    seg.push(join(babble(21_000), hush(300), babble(5000), hush(1000)));
    expect(chunks).toHaveLength(2);
    expect(ms(chunks[0]!.samples.length)).toBeLessThan(22_000);
  });

  it('gives the same chunks however the samples arrive', () => {
    const all = join(hush(700), talk(1500), hush(900), talk(2500), hush(900));
    const whole = collect();
    whole.seg.push(all);
    const bits = collect();
    for (let at = 0; at < all.length; at += 1357) bits.seg.push(all.subarray(at, Math.min(all.length, at + 1357)));
    expect(bits.chunks.map((c) => [c.startSample, c.endSample])).toEqual(whole.chunks.map((c) => [c.startSample, c.endSample]));
    expect(bits.seg.position).toBe(all.length);
  });

  it('keeps its own copy of the samples (the audio system reuses its buffer)', () => {
    const { chunks, seg } = collect();
    const buf = join(talk(1000), hush(1000));
    const first = buf.slice(0, samplesOf(1000));
    seg.push(buf);
    buf.fill(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.samples.subarray(0, samplesOf(1000))).toEqual(first);
  });

  it('shows the speech so far in the open chunk, and flush ends it', () => {
    const { chunks, seg } = collect();
    expect(seg.current()).toBeNull();
    seg.push(join(hush(300), talk(1500)));
    const open = seg.current();
    expect(open).not.toBeNull();
    expect(ms(open!.samples.length)).toBeGreaterThan(1500);
    const recent = seg.current(samplesOf(500))!;
    expect(recent.samples.length).toBe(samplesOf(500));
    expect(recent.endSample).toBe(open!.endSample);
    seg.flush();
    expect(chunks).toHaveLength(1);
    expect(seg.current()).toBeNull();
  });
});

// ---- the transcriber ---------------------------------------------------------------------------------------------------------------------------

function manualSource() {
  let push: ((s: Float32Array) => void) | null = null;
  let stops = 0;
  const source: PcmSource = {
    start: async (onPcm) => void (push = onPcm),
    stop: () => void (stops += 1),
  };
  return { source, feed: (s: Float32Array) => push?.(s), stops: () => stops };
}

/** A recognizer a test finishes by hand. */
function manualRecognizer() {
  const calls: { samples: Float32Array; language: string | undefined; done: (r: RecognizeResult | Error) => void; progress: (f: number) => void }[] = [];
  const recognizer: Recognizer = {
    transcribe: (samples, options) =>
      new Promise((resolve, reject) => {
        calls.push({
          samples,
          language: options.language,
          done: (r) => (r instanceof Error ? reject(r) : resolve(r)),
          progress: (f) => options.onProgress?.({ stage: 'model', fraction: f }),
        });
      }),
  };
  return { recognizer, calls };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function build(over: { maxBacklogMs?: number; maxFailures?: number; language?: string } = {}) {
  const src = manualSource();
  const rec = manualRecognizer();
  const lines: StreamLine[] = [];
  const statuses: StreamStatus[] = [];
  let clock = 5000;
  const t = createLiveTranscriber({ source: src.source, recognizer: rec.recognizer, now: () => clock, onLine: (l) => lines.push(l), onStatus: (s) => statuses.push(s), ...over });
  return { t, src, rec, lines, statuses, setNow: (n: number) => void (clock = n), advance: (n: number) => void (clock += n) };
}

describe('the live transcriber', () => {
  it('writes a partial line about once a second while someone talks, then a final line when the chunk closes', async () => {
    const h = build();
    await h.t.start();
    h.src.feed(talk(1200));
    await tick();
    expect(h.rec.calls).toHaveLength(1); // the first partial
    h.rec.calls[0]!.done({ text: 'hello th', language: 'en' });
    await tick();
    expect(h.lines).toEqual([expect.objectContaining({ text: 'hello th', final: false, lang: 'en' })]);

    // less than a second later: no new partial job
    h.advance(400);
    h.src.feed(talk(300));
    await tick();
    expect(h.rec.calls).toHaveLength(1);

    h.advance(700);
    h.src.feed(talk(300));
    await tick();
    expect(h.rec.calls).toHaveLength(2);
    h.rec.calls[1]!.done({ text: 'hello there', language: 'en' });
    await tick();

    h.src.feed(hush(900)); // the chunk closes
    await tick();
    expect(h.rec.calls).toHaveLength(3);
    h.rec.calls[2]!.done({ text: ' Hello there, everyone. ', language: 'en' });
    await tick();
    const last = h.lines[h.lines.length - 1]!;
    expect(last).toMatchObject({ text: 'Hello there, everyone.', final: true });
    expect(h.lines.filter((l) => l.final)).toHaveLength(1);
    expect(new Set(h.lines.map((l) => l.id)).size).toBe(1); // partials and the final share the chunk's id
    expect(last.endMs).toBeGreaterThan(last.startMs);
  });

  it('puts the times on the clock it is given, counted back from the newest samples', async () => {
    const h = build();
    await h.t.start();
    h.setNow(10_000);
    h.src.feed(join(talk(1000), hush(1000))); // 2 s of audio ending "now"
    await tick();
    h.rec.calls[0]!.done({ text: 'hello', language: 'en' });
    await tick();
    const fin = h.lines.find((l) => l.final)!;
    expect(fin.startMs).toBeGreaterThanOrEqual(10_000 - 2000);
    expect(fin.startMs).toBeLessThanOrEqual(10_000 - 1000 + 20);
    expect(fin.endMs).toBeGreaterThan(fin.startMs + 900);
    expect(fin.endMs).toBeLessThanOrEqual(10_000);
  });

  it('does not show a partial for a chunk that closed meanwhile, and says nothing for silence', async () => {
    const h = build();
    await h.t.start();
    h.src.feed(talk(1200));
    await tick();
    h.src.feed(hush(900)); // closes while the partial is still being written out
    await tick();
    h.rec.calls[0]!.done({ text: 'late partial', language: 'en' });
    await tick();
    expect(h.lines).toHaveLength(0);
    h.rec.calls[1]!.done({ text: '   ', language: 'en' }); // the model heard nothing in the chunk
    await tick();
    expect(h.lines).toHaveLength(0);
  });

  it('reuses the language the model found, and finds it again every few chunks', async () => {
    const h = build();
    await h.t.start();
    const chunk = async (): Promise<void> => {
      h.src.feed(join(talk(500), hush(900)));
      await tick();
    };
    // answer every call as it comes
    const answerAll = async (): Promise<void> => {
      for (let guard = 0; guard < 40; guard++) {
        const open = h.rec.calls.find((c) => !(c as { answered?: boolean }).answered);
        if (!open) return;
        (open as { answered?: boolean }).answered = true;
        open.done({ text: 'words', language: 'bn' });
        await tick();
      }
    };
    for (let i = 0; i < 10; i++) {
      await chunk();
      await answerAll();
    }
    expect(h.rec.calls[0]!.language).toBeUndefined();
    const withLanguage = h.rec.calls.filter((c) => c.language === 'bn').length;
    const without = h.rec.calls.filter((c) => c.language === undefined).length;
    expect(withLanguage).toBeGreaterThan(5);
    expect(without).toBeGreaterThanOrEqual(2); // the first, and a refresh
  });

  it('tells the page while the model is being fetched, then that it is listening', async () => {
    const h = build();
    await h.t.start();
    h.src.feed(talk(1200));
    await tick();
    h.rec.calls[0]!.progress(0.4);
    expect(h.statuses).toContainEqual({ kind: 'loading', fraction: 0.4 });
    h.rec.calls[0]!.done({ text: 'hi', language: 'en' });
    await tick();
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: 'listening' });
  });

  it('keeps nothing while muted, and ends the chunk being spoken first', async () => {
    const h = build();
    await h.t.start();
    h.src.feed(join(talk(1000)));
    await tick();
    h.rec.calls[0]!.done({ text: 'part', language: 'en' });
    await tick();
    h.t.setMuted(true);
    await tick();
    expect(h.rec.calls).toHaveLength(2); // the chunk that was open is written out
    h.rec.calls[1]!.done({ text: 'part one', language: 'en' });
    await tick();
    expect(h.lines.filter((l) => l.final).map((l) => l.text)).toEqual(['part one']);
    h.src.feed(talk(3000));
    await tick();
    expect(h.rec.calls).toHaveLength(2);
    h.t.setMuted(false);
    h.advance(2000);
    h.src.feed(talk(1200));
    await tick();
    expect(h.rec.calls).toHaveLength(3);
  });

  it('says "too slow" and stops when finished chunks pile up faster than they are written out', async () => {
    const h = build({ maxBacklogMs: 5000 });
    await h.t.start();
    for (let i = 0; i < 6; i++) {
      h.src.feed(join(talk(2000), hush(900)));
      await tick();
    }
    expect(h.statuses).toContainEqual({ kind: 'too_slow', message: TOO_SLOW_MESSAGE });
    expect(h.src.stops()).toBeGreaterThanOrEqual(1);
    const before = h.rec.calls.length;
    h.src.feed(talk(5000));
    await tick();
    expect(h.rec.calls.length).toBe(before); // it listens no more
  });

  it('gives up after the model fails on a few chunks in a row, with the model\'s own plain sentence', async () => {
    const h = build({ maxFailures: 2 });
    await h.t.start();
    for (let i = 0; i < 2; i++) {
      h.src.feed(join(talk(500), hush(900)));
      await tick();
      for (const c of h.rec.calls.filter((x) => !(x as { answered?: boolean }).answered)) {
        (c as { answered?: boolean }).answered = true;
        c.done(new SpeechError('unavailable', "Couldn't get the speech model. Check your connection and try again."));
      }
      await tick();
    }
    expect(h.statuses).toContainEqual({ kind: 'failed', message: "Couldn't get the speech model. Check your connection and try again." });
    expect(h.src.stops()).toBeGreaterThanOrEqual(1);
  });

  it('writes out its last chunk on stop and resolves when everything is delivered', async () => {
    const h = build();
    await h.t.start();
    h.src.feed(talk(1500));
    await tick();
    const stopped = h.t.stop();
    let done = false;
    void stopped.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    // the partial that was running, then the final chunk
    h.rec.calls[0]!.done({ text: 'partial', language: 'en' });
    await tick();
    expect(done).toBe(false);
    h.rec.calls[1]!.done({ text: 'the last words', language: 'en' });
    await stopped;
    expect(h.lines.map((l) => l.text)).toEqual(['the last words']);
    expect(h.src.stops()).toBe(1);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: 'stopped' });
  });
});

describe('encodeWav16', () => {
  it('writes a 16 kHz mono 16-bit WAV', async () => {
    const wav = encodeWav16(Float32Array.from([0, 1, -1, 0.5]));
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(wav.type).toBe('audio/wav');
    expect(bytes.length).toBe(44 + 8);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE');
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
  });
});
