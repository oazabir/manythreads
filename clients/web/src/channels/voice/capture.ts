import { VOICE_MAX_MS } from '@manythreads/shared';
import { VOICE_MIN_MS, formatClock, reachedLimit, warningAt } from './clock';
import { reducePeaks } from './peaks';
import { ALLOWED_TEXT, LOST_TEXT, TOO_SHORT_TEXT, clipMime, micErrorText } from './support';

/**
 * The recording itself (P14-17, reshaped in P32-05), with no React and with every browser object handed in, so the rules (permission, too short, pause and
 * resume, the five minute limit, cancel, a lost microphone) are tested with stand-ins. `useRecorder` is the thin hook around it.
 *
 * A recording is one thing from the first press to Send: it can be paused and resumed (paused time is not counted), and `take()` ends it and hands the clip
 * over to be sent; there is no preview step. At five minutes the recording pauses by itself and waits for Send or Delete.
 */

export interface TrackLike {
  stop(): void;
  onended: (() => void) | null;
}
export interface StreamLike {
  getTracks(): TrackLike[];
}
export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
}
/** Reads the level of the microphone (0 to 1); `close` lets go of the audio graph. */
export interface LevelReader {
  read(): number;
  close(): void;
}

export type CaptureDeps = {
  openMic(): Promise<StreamLike>;
  makeRecorder(stream: StreamLike, mimeType: string | undefined): RecorderLike;
  makeLevelReader(stream: StreamLike): LevelReader | null;
  pickMime(): string | undefined;
  now(): number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(fn: () => void, ms: number): () => void;
};

export type RecordedClip = { blob: Blob; mime: string; durationMs: number; peaks: number[]; /** The recording ran into the five minute limit and stopped by itself. */ limited: boolean };

export type CaptureState =
  | { phase: 'idle' }
  /** Waiting for the person to answer the browser's microphone question. */
  | { phase: 'asking' }
  /**
   * Recording, or waiting paused. `limited`: it paused by itself at five minutes. `lost`: the microphone went away; what was recorded can still be sent,
   * nothing more can be added.
   */
  | { phase: 'recording'; paused: boolean; limited: boolean; lost: boolean }
  | { phase: 'error'; message: string };

/** How many of the newest level readings the live waveform keeps (the bar shows as many as fit). */
export const TAIL_BARS = 160;

export type MeterSnapshot = {
  /** Recorded time, paused time left out. */
  elapsedMs: number;
  level: number;
  /** The newest readings (0 to 1), oldest first, at most `TAIL_BARS`; the waveform draws these. */
  tail: readonly number[];
  /** How many readings were taken in all (so a waveform that does not scroll knows where the newest one goes). */
  total: number;
};

const SILENT: MeterSnapshot = { elapsedMs: 0, level: 0, tail: [], total: 0 };

/** A value that changes about twelve times a second while recording: only the timer and the waveform listen, not the composer. */
export function createMeter() {
  let snap: MeterSnapshot = SILENT;
  const subs = new Set<() => void>();
  return {
    get: (): MeterSnapshot => snap,
    set(next: MeterSnapshot): void {
      snap = next;
      subs.forEach((f) => f());
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
export type Meter = ReturnType<typeof createMeter>;

export const TICK_MS = 80;
const TIMESLICE_MS = 250;

export class Capture {
  state: CaptureState = { phase: 'idle' };
  /** What a screen reader hears (a polite live region): short sentences at the start, pause, resume, the limit, never every second. */
  announcement = '';
  readonly meter: Meter = createMeter();

  private listeners = new Set<() => void>();
  private session = 0;
  private stream: StreamLike | null = null;
  private recorder: RecorderLike | null = null;
  private levels: LevelReader | null = null;
  private stopTicks: (() => void) | null = null;
  private chunks: Blob[] = [];
  private readings: number[] = [];
  private tail: number[] = [];
  /** Recorded time of the stretches that are over (a pause or resume closes one). */
  private accumulated = 0;
  /** When the running stretch began; meaningless while paused. */
  private segmentAt = 0;
  private outcome: 'keep' | 'cancel' | 'lost' = 'keep';
  private warned = 0;
  /** Waiting for the recorder to stop so `take()` can hand the clip over. */
  private taker: ((clip: RecordedClip | null) => void) | null = null;
  /** A clip kept when the microphone was lost, for `take()` after the recorder is gone. */
  private lostClip: RecordedClip | null = null;
  /** Send (or Delete) was pressed and the recorder is stopping: a second press does nothing, a second `take()` gets the same answer. */
  private ending = false;
  private takePromise: Promise<RecordedClip | null> | null = null;

  constructor(private readonly deps: CaptureDeps) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private set(state: CaptureState, announcement?: string): void {
    this.state = state;
    if (announcement !== undefined) this.announcement = announcement;
    this.listeners.forEach((f) => f());
  }

  /** False when this browser's recorder cannot pause: the bar then offers no Pause button. */
  get canPause(): boolean {
    return typeof this.recorder?.pause === 'function';
  }
  /** Send or Delete was pressed and the recording is closing: the bar disables both. */
  get isEnding(): boolean {
    return this.ending;
  }

  private running = (): boolean => this.state.phase === 'recording' && !this.state.paused;
  /** Recorded time so far: the closed stretches and the one that runs, never more than the limit. */
  private elapsed(): number {
    const live = this.state.phase === 'recording' && !this.state.paused ? this.deps.now() - this.segmentAt : 0;
    return Math.min(VOICE_MAX_MS, Math.max(0, this.accumulated + live));
  }

  /** Asks for the microphone and starts. Does nothing while a recording is under way. */
  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') return;
    const mine = ++this.session;
    this.set({ phase: 'asking' });
    let stream: StreamLike;
    try {
      stream = await this.deps.openMic();
    } catch (err) {
      if (mine === this.session) this.set({ phase: 'error', message: micErrorText(err) }, '');
      return;
    }
    if (mine !== this.session) {
      // let go before the answer came (released too early, Esc, or the composer closed): the microphone is not kept
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    try {
      this.begin(stream);
    } catch (err) {
      // `begin` may have got as far as the level reader or the recorder: let go of all of it, not only the tracks
      this.stopTicks?.();
      this.stopTicks = null;
      this.release();
      stream.getTracks().forEach((t) => t.stop());
      this.set({ phase: 'error', message: micErrorText(err) }, '');
    }
  }

  private begin(stream: StreamLike): void {
    const recorder = this.deps.makeRecorder(stream, this.deps.pickMime());
    this.stream = stream;
    this.recorder = recorder;
    this.chunks = [];
    this.readings = [];
    this.tail = [];
    this.accumulated = 0;
    this.warned = 0;
    this.outcome = 'keep';
    this.lostClip = null;
    this.ending = false;
    this.takePromise = null;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => this.finish();
    recorder.onerror = () => this.lose();
    for (const t of stream.getTracks()) {
      t.onended = () => {
        if (this.state.phase === 'recording' && !this.state.lost) this.lose();
      };
    }
    this.levels = this.deps.makeLevelReader(stream);
    this.segmentAt = this.deps.now();
    this.meter.set(SILENT);
    recorder.start(TIMESLICE_MS);
    this.state = { phase: 'recording', paused: false, limited: false, lost: false };
    this.stopTicks = this.deps.every(() => this.tick(), TICK_MS);
    this.set(this.state, 'Recording');
  }

  private tick(): void {
    if (!this.running()) return;
    const elapsedMs = this.elapsed();
    const level = this.levels?.read() ?? 0;
    this.readings.push(level);
    this.tail.push(level);
    if (this.tail.length > TAIL_BARS) this.tail.shift();
    this.meter.set({ elapsedMs, level, tail: this.tail.slice(), total: this.readings.length });
    const warn = warningAt(elapsedMs, this.warned);
    if (warn) {
      this.warned = warn.said;
      this.announcement = warn.text;
      this.listeners.forEach((f) => f());
    }
    // five minutes: the recording waits, paused, for Send or Delete
    if (reachedLimit(elapsedMs)) this.pauseNow(true);
  }

  private pauseNow(limited: boolean): void {
    if (!this.running() || this.ending) return;
    const at = this.elapsed();
    try {
      if (typeof this.recorder?.pause !== 'function') throw new Error('no pause');
      this.recorder.pause();
    } catch {
      if (limited) {
        // the limit is reached whether the recorder pauses or not: stop it for good so no more is recorded
        this.accumulated = at;
        this.stopTicks?.();
        this.stopTicks = null;
        this.set({ phase: 'recording', paused: true, limited: true, lost: false }, `Recording stopped at the limit, ${formatClock(at)}`);
        return;
      }
      // the state stays as it was: still recording, and the person is told
      this.set(this.state, 'Could not pause the recording. It is still recording.');
      return;
    }
    this.accumulated = at;
    this.stopTicks?.();
    this.stopTicks = null;
    this.meter.set({ elapsedMs: at, level: 0, tail: this.tail.slice(), total: this.readings.length });
    this.set({ phase: 'recording', paused: true, limited, lost: false }, limited ? `Recording stopped at the limit, ${formatClock(at)}` : `Recording paused, ${formatClock(at)}`);
  }

  /** Pauses the recording: paused time is not counted and nothing is heard until Resume. */
  pause(): void {
    this.pauseNow(false);
  }

  /** Goes on recording after a pause (not after the five minute limit or a lost microphone). */
  resume(): void {
    const s = this.state;
    if (s.phase !== 'recording' || !s.paused || s.limited || s.lost) return;
    try {
      if (typeof this.recorder?.resume !== 'function') throw new Error('no resume');
      this.recorder.resume();
    } catch {
      this.set(this.state, 'Could not resume the recording. It is still paused.');
      return;
    }
    this.segmentAt = this.deps.now();
    this.stopTicks = this.deps.every(() => this.tick(), TICK_MS);
    this.set({ phase: 'recording', paused: false, limited: false, lost: false }, 'Recording resumed');
  }

  /** Ends the recording and hands the clip over to be sent. Resolves to null when nothing is kept (too short, or no recording under way). */
  take(): Promise<RecordedClip | null> {
    if (this.ending) return this.takePromise ?? Promise.resolve(null);
    const s = this.state;
    if (s.phase !== 'recording') return Promise.resolve(null);
    if (s.lost) {
      const clip = this.lostClip;
      this.lostClip = null;
      this.set({ phase: 'idle' }, clip ? 'Sending the voice message' : '');
      return Promise.resolve(clip);
    }
    this.outcome = 'keep';
    this.ending = true;
    this.listeners.forEach((f) => f());
    this.takePromise = new Promise((resolve) => {
      this.taker = resolve;
      this.halt();
    });
    return this.takePromise;
  }

  /** Throws the recording away (slide away, Esc, the trash button). Nothing is kept and nothing is uploaded. */
  cancel(): void {
    if (this.ending) return;
    if (this.state.phase === 'asking') {
      this.session++; // the answer, when it comes, is ignored and the microphone released
      this.set({ phase: 'idle' }, '');
      return;
    }
    if (this.state.phase !== 'recording') return;
    if (this.state.lost) {
      this.lostClip = null;
      this.set({ phase: 'idle' }, 'Recording deleted');
      return;
    }
    this.outcome = 'cancel';
    this.ending = true;
    this.listeners.forEach((f) => f());
    this.halt();
  }

  /** The press ended before the browser's question was answered, and it was a hold, not a tap: say the microphone is ready, record nothing. */
  releaseWhileAsking(): void {
    if (this.state.phase !== 'asking') return;
    this.session++;
    this.set({ phase: 'error', message: ALLOWED_TEXT }, '');
  }

  /** The microphone went away (the device was unplugged, the track ended): keep what was recorded so far, if it is enough. */
  private lose(): void {
    if (this.state.phase !== 'recording' || this.state.lost || this.ending) return;
    this.outcome = 'lost';
    this.halt();
  }

  private halt(): void {
    this.accumulated = this.elapsed();
    this.stopTicks?.();
    this.stopTicks = null;
    const r = this.recorder;
    if (r && r.state !== 'inactive') r.stop();
    else this.finish();
  }

  private release(): void {
    this.levels?.close();
    this.levels = null;
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = null;
    this.recorder = null;
  }

  private finish(): void {
    if (this.state.phase !== 'recording') return;
    const mime = clipMime(this.recorder?.mimeType || this.deps.pickMime() || 'audio/webm');
    const chunks = this.chunks;
    const outcome = this.outcome;
    const limited = this.state.limited;
    const durationMs = Math.min(VOICE_MAX_MS, this.accumulated);
    const peaks = reducePeaks(this.readings);
    const taker = this.taker;
    this.taker = null;
    this.ending = false;
    this.takePromise = null;
    this.release();
    this.chunks = [];
    this.readings = [];
    this.tail = [];
    this.meter.set(SILENT);
    const done = (state: CaptureState, said: string, clip: RecordedClip | null): void => {
      this.set(state, said);
      taker?.(clip);
    };
    if (outcome === 'cancel') {
      done({ phase: 'idle' }, 'Recording deleted', null);
      return;
    }
    const blob = new Blob(chunks, { type: mime });
    const short = durationMs < VOICE_MIN_MS || blob.size === 0;
    if (short) {
      done({ phase: 'error', message: outcome === 'lost' ? LOST_TEXT : TOO_SHORT_TEXT }, '', null);
      return;
    }
    const clip: RecordedClip = { blob, mime, durationMs, peaks, limited };
    if (outcome === 'lost') {
      // what was recorded stays, waiting for Send or Delete
      this.lostClip = clip;
      this.meter.set({ elapsedMs: durationMs, level: 0, tail: [], total: 0 });
      this.set({ phase: 'recording', paused: true, limited: false, lost: true }, `The microphone was lost. The recording so far, ${formatClock(durationMs)}, can still be sent.`);
      return;
    }
    done({ phase: 'idle' }, 'Sending the voice message', clip);
  }

  /** Closes the "That was too short" or microphone message. */
  discard(announce = ''): void {
    if (this.state.phase === 'error') this.set({ phase: 'idle' }, announce);
  }

  /** The conversation changed under the recorder (another channel opened): whatever is under way is dropped, silently. */
  reset(): void {
    if (this.state.phase === 'asking') this.session++;
    if (this.state.phase === 'recording') {
      if (this.state.lost) {
        this.lostClip = null;
        this.set({ phase: 'idle' }, '');
        return;
      }
      this.outcome = 'cancel';
      this.ending = true;
      this.halt();
      return;
    }
    if (this.state.phase !== 'idle') this.set({ phase: 'idle' }, '');
  }

  /** The composer went away: let go of everything, silently. */
  dispose(): void {
    this.session++;
    this.stopTicks?.();
    this.stopTicks = null;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    }
    this.release();
    this.lostClip = null;
    this.chunks = [];
    this.readings = [];
    this.tail = [];
    this.ending = false;
    this.takePromise = null;
    this.taker?.(null);
    this.taker = null;
    this.state = { phase: 'idle' };
  }
}
